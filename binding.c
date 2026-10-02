#include <assert.h>
#include <bare.h>
#include <fpdf_annot.h>
#include <fpdf_edit.h>
#include <fpdf_formfill.h>
#include <fpdf_ppo.h>
#include <fpdf_save.h>
#include <fpdf_text.h>
#include <fpdfview.h>
#include <js.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <utf.h>
#include <uv.h>

// PDFium is not thread-safe and wants a single process-lifetime init; there is
// no matching destroy — the library lives for the life of the process.
static bool bare_pdfium_initialized = false;

static uv_once_t bare_pdfium_lock_once = UV_ONCE_INIT;
static uv_mutex_t bare_pdfium_lock_mutex;

// Rendering a page at an absurd scale would allocate gigabytes; cap each side.
static const int BARE_PDFIUM_MAX_DIM = 20000;

// An image object covering less than this fraction of the page is treated as
// decoration (a logo/rule), not content, when classifying a page.
static const double BARE_PDFIUM_MIN_IMAGE_FRACTION = 0.05;

// An extracted image below this pixel size is a spacer/bullet, not a figure.
static const int BARE_PDFIUM_MIN_IMAGE_PX = 8;

// An open document plus its own copy of the source bytes. FPDF_LoadMemDocument
// does not copy the buffer, so the document owns one and frees it on close.
typedef struct {
  FPDF_DOCUMENT doc;
  void *buf;
  FILE *file;
  FPDF_FILEACCESS access;
} bare_pdfium_doc_t;

typedef struct {
  int width;
  int height;
  uint8_t *rgba;
} bare_pdfium_raster_t;

typedef struct {
  uv_work_t req;
  js_env_t *env;
  js_deferred_t *deferred;
  js_ref_t *ref;
  bare_pdfium_doc_t *handle;
  int page_index;
  bool clip;
  double scale;
  const char *error;
  unsigned short *text;
  size_t units;
  bare_pdfium_raster_t raster;
} bare_pdfium_job_t;

static void
bare_pdfium__init_lock(void) {
  int err = uv_mutex_init(&bare_pdfium_lock_mutex);
  assert(err == 0);
}

// Never call into JS while holding the lock: any allocation can run a GC whose finalizers take it.
static void
bare_pdfium__lock(void) {
  uv_once(&bare_pdfium_lock_once, bare_pdfium__init_lock);
  uv_mutex_lock(&bare_pdfium_lock_mutex);
}

static void
bare_pdfium__unlock(void) {
  uv_mutex_unlock(&bare_pdfium_lock_mutex);
}

static void
bare_pdfium__ensure_init(void) {
  if (bare_pdfium_initialized) return;
  FPDF_InitLibrary();
  bare_pdfium_initialized = true;
}

static void
bare_pdfium__on_doc_finalize(js_env_t *env, void *data, void *finalize_hint) {
  bare_pdfium_doc_t *handle = (bare_pdfium_doc_t *) data;
  bare_pdfium__lock();
  if (handle->doc) FPDF_CloseDocument(handle->doc);
  bare_pdfium__unlock();
  if (handle->file) fclose(handle->file);
  free(handle->buf);
  free(handle);
}

static int64_t
bare_pdfium__file_size(FILE *file) {
#ifdef _WIN32
  if (_fseeki64(file, 0, SEEK_END) != 0) return -1;
  int64_t size = _ftelli64(file);
  _fseeki64(file, 0, SEEK_SET);
#else
  if (fseeko(file, 0, SEEK_END) != 0) return -1;
  off_t size = ftello(file);
  fseeko(file, 0, SEEK_SET);
#endif
  return (int64_t) size;
}

static int
bare_pdfium__get_block(void *param, unsigned long position, unsigned char *buf, unsigned long size) {
  FILE *file = (FILE *) param;
#ifdef _WIN32
  if (_fseeki64(file, (int64_t) position, SEEK_SET) != 0) return 0;
#else
  if (fseeko(file, (off_t) position, SEEK_SET) != 0) return 0;
#endif
  return fread(buf, 1, size, file) == size ? 1 : 0;
}

static bare_pdfium_doc_t *
bare_pdfium__handle(js_env_t *env, js_value_t *value) {
  bare_pdfium_doc_t *handle = NULL;
  int err = js_get_value_external(env, value, (void **) &handle);
  assert(err == 0);
  return handle;
}

static void
bare_pdfium__set_int(js_env_t *env, js_value_t *object, const char *name, int64_t value) {
  int err;
  js_value_t *val;
  err = js_create_int64(env, value, &val);
  assert(err == 0);
  err = js_set_named_property(env, object, name, val);
  assert(err == 0);
}

static void
bare_pdfium__set_bool(js_env_t *env, js_value_t *object, const char *name, bool value) {
  int err;
  js_value_t *val;
  err = js_get_boolean(env, value, &val);
  assert(err == 0);
  err = js_set_named_property(env, object, name, val);
  assert(err == 0);
}

// Copy any PDFium bitmap (BGRA/BGRx/BGR/Gray) into the RGBA the image pipeline expects.
static bool
bare_pdfium__raster(FPDF_BITMAP bitmap, bare_pdfium_raster_t *raster) {
  int width = FPDFBitmap_GetWidth(bitmap);
  int height = FPDFBitmap_GetHeight(bitmap);
  uint8_t *data = malloc((size_t) width * (size_t) height * 4);
  if (data == NULL) return false;

  int stride = FPDFBitmap_GetStride(bitmap);
  int format = FPDFBitmap_GetFormat(bitmap);
  const uint8_t *pixels = (const uint8_t *) FPDFBitmap_GetBuffer(bitmap);

  for (int y = 0; y < height; y++) {
    const uint8_t *src = pixels + (size_t) y * stride;
    uint8_t *dst = data + (size_t) y * width * 4;
    for (int x = 0; x < width; x++) {
      uint8_t r, g, b, a;
      switch (format) {
      case FPDFBitmap_BGRA:
        b = src[x * 4 + 0], g = src[x * 4 + 1], r = src[x * 4 + 2], a = src[x * 4 + 3];
        break;
      case FPDFBitmap_BGRx:
        b = src[x * 4 + 0], g = src[x * 4 + 1], r = src[x * 4 + 2], a = 255;
        break;
      case FPDFBitmap_BGR:
        b = src[x * 3 + 0], g = src[x * 3 + 1], r = src[x * 3 + 2], a = 255;
        break;
      case FPDFBitmap_Gray:
        r = g = b = src[x], a = 255;
        break;
      default:
        r = g = b = 0, a = 255;
        break;
      }
      dst[x * 4 + 0] = r, dst[x * 4 + 1] = g, dst[x * 4 + 2] = b, dst[x * 4 + 3] = a;
    }
  }

  raster->width = width;
  raster->height = height;
  raster->rgba = data;
  return true;
}

static void
bare_pdfium__finalize_rgba(js_env_t *env, void *data, void *finalize_hint) {
  free(data);
}

// Hands the raster's pixels to the returned arraybuffer, which frees them once collected.
static js_value_t *
bare_pdfium__raster_result(js_env_t *env, bare_pdfium_raster_t *raster) {
  int err;

  js_value_t *result;
  err = js_create_object(env, &result);
  assert(err == 0);

  bare_pdfium__set_int(env, result, "width", raster->width);
  bare_pdfium__set_int(env, result, "height", raster->height);

  size_t len = (size_t) raster->width * (size_t) raster->height * 4;

  js_value_t *buffer;
  err = js_create_external_arraybuffer(env, raster->rgba, len, bare_pdfium__finalize_rgba, NULL, &buffer);
  assert(err == 0);
  raster->rgba = NULL;

  err = js_set_named_property(env, result, "data", buffer);
  assert(err == 0);

  return result;
}

static void
bare_pdfium__throw_load_error(js_env_t *env, unsigned long code) {
  const char *name;
  const char *message;
  switch (code) {
  case FPDF_ERR_FILE:
    name = "FILE", message = "failed to load PDF: file not found or could not be opened";
    break;
  case FPDF_ERR_FORMAT:
    name = "FORMAT", message = "failed to load PDF: not a PDF or corrupted";
    break;
  case FPDF_ERR_PASSWORD:
    name = "PASSWORD", message = "password required or incorrect";
    break;
  case FPDF_ERR_SECURITY:
    name = "SECURITY", message = "failed to load PDF: unsupported security scheme";
    break;
  case FPDF_ERR_PAGE:
    name = "PAGE", message = "failed to load PDF: page not found or content error";
    break;
  default:
    name = "UNKNOWN", message = "failed to load PDF";
    break;
  }
  int err = js_throw_error(env, name, message);
  assert(err == 0);
}

static const char *
bare_pdfium__render_page(FPDF_DOCUMENT doc, int page_index, double scale, bare_pdfium_raster_t *result) {
  FPDF_PAGE page = FPDF_LoadPage(doc, page_index);
  if (page == NULL) return "failed to load page";

  // PDF user-space units are points (1/72"); scale maps them to device pixels.
  int width = (int) lround(FPDF_GetPageWidth(page) * scale);
  int height = (int) lround(FPDF_GetPageHeight(page) * scale);
  if (width < 1) width = 1;
  if (height < 1) height = 1;

  if (width > BARE_PDFIUM_MAX_DIM || height > BARE_PDFIUM_MAX_DIM) {
    FPDF_ClosePage(page);
    return "rendered dimensions exceed limit";
  }

  FPDF_BITMAP bitmap = FPDFBitmap_Create(width, height, 1);
  if (bitmap == NULL) {
    FPDF_ClosePage(page);
    return "failed to allocate bitmap";
  }

  // Paint white first: a page with no background renders onto transparency,
  // and a vision model reads a transparent PNG as a black rectangle.
  FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
  FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, FPDF_ANNOT);

  FPDF_ClosePage(page);

  bool copied = bare_pdfium__raster(bitmap, result);
  FPDFBitmap_Destroy(bitmap);
  return copied ? NULL : "failed to allocate bitmap";
}

static const char *
bare_pdfium__page_text(FPDF_DOCUMENT doc, int page_index, bool clip, unsigned short **text, size_t *units) {
  FPDF_PAGE page = FPDF_LoadPage(doc, page_index);
  if (page == NULL) return "failed to load page";

  FPDF_TEXTPAGE text_page = FPDFText_LoadPage(page);
  if (text_page == NULL) {
    FPDF_ClosePage(page);
    return "failed to load text page";
  }

  *text = NULL;
  *units = 0;

  FS_RECTF box;
  if (clip && FPDF_GetPageBoundingBox(page, &box)) {
    int count = FPDFText_GetBoundedText(text_page, box.left, box.top, box.right, box.bottom, NULL, 0);
    if (count > 0) {
      *text = malloc((size_t) (count + 1) * sizeof(unsigned short));
      int written = FPDFText_GetBoundedText(text_page, box.left, box.top, box.right, box.bottom, *text, count + 1);
      *units = written > count ? (size_t) count : (size_t) (written > 0 ? written : 0);
      for (size_t i = 0; i < *units; i++) {
        if ((*text)[i] == 0x0002) (*text)[i] = 0xfffe;
      }
    }
  } else {
    int char_count = FPDFText_CountChars(text_page);
    if (char_count > 0) {
      *text = malloc((size_t) (char_count + 1) * sizeof(unsigned short));
      int written = FPDFText_GetText(text_page, 0, char_count, *text);
      *units = written > 0 ? (size_t) (written - 1) : 0;
    }
  }

  FPDFText_ClosePage(text_page);
  FPDF_ClosePage(page);

  return NULL;
}

static js_value_t *
bare_pdfium__text_result(js_env_t *env, const unsigned short *text, size_t units) {
  js_value_t *result;
  int err = units
    ? js_create_string_utf16le(env, (const utf16_t *) text, units, &result)
    : js_create_string_utf8(env, (const utf8_t *) "", 0, &result);
  assert(err == 0);
  return result;
}

static js_value_t *
bare_pdfium_open(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 2);

  uint8_t *pdf;
  size_t len;
  err = js_get_typedarray_info(env, argv[0], NULL, (void **) &pdf, &len, NULL, NULL);
  assert(err == 0);

  // an empty string means no password
  char password[256];
  size_t password_len = 0;
  err = js_get_value_string_utf8(
    env, argv[1], (utf8_t *) password, sizeof(password), &password_len
  );
  assert(err == 0);
  password[password_len < sizeof(password) ? password_len : sizeof(password) - 1] = '\0';

  void *copy = malloc(len == 0 ? 1 : len);
  memcpy(copy, pdf, len);

  bare_pdfium__lock();
  bare_pdfium__ensure_init();
  FPDF_DOCUMENT doc =
    FPDF_LoadMemDocument(copy, (int) len, password_len ? password : NULL);
  unsigned long code = doc == NULL ? FPDF_GetLastError() : FPDF_ERR_SUCCESS;
  bare_pdfium__unlock();

  if (doc == NULL) {
    free(copy);
    bare_pdfium__throw_load_error(env, code);
    return NULL;
  }

  bare_pdfium_doc_t *handle = malloc(sizeof(bare_pdfium_doc_t));
  handle->doc = doc;
  handle->buf = copy;
  handle->file = NULL;

  js_value_t *external;
  err = js_create_external(env, handle, bare_pdfium__on_doc_finalize, NULL, &external);
  assert(err == 0);

  return external;
}

static js_value_t *
bare_pdfium_open_file(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 2);

  size_t path_len = 0;
  err = js_get_value_string_utf8(env, argv[0], NULL, 0, &path_len);
  assert(err == 0);
  char *path = malloc(path_len + 1);
  err = js_get_value_string_utf8(env, argv[0], (utf8_t *) path, path_len + 1, &path_len);
  assert(err == 0);
  path[path_len] = '\0';

  char password[256];
  size_t password_len = 0;
  err = js_get_value_string_utf8(
    env, argv[1], (utf8_t *) password, sizeof(password), &password_len
  );
  assert(err == 0);
  password[password_len < sizeof(password) ? password_len : sizeof(password) - 1] = '\0';

  FILE *file = fopen(path, "rb");
  free(path);
  if (file == NULL) {
    err = js_throw_error(env, "FILE", "failed to open file");
    assert(err == 0);
    return NULL;
  }

  int64_t size = bare_pdfium__file_size(file);
  if (size < 0) {
    fclose(file);
    err = js_throw_error(env, "FILE", "failed to size file");
    assert(err == 0);
    return NULL;
  }

  bare_pdfium_doc_t *handle = malloc(sizeof(bare_pdfium_doc_t));
  handle->doc = NULL;
  handle->buf = NULL;
  handle->file = file;
  handle->access.m_FileLen = (unsigned long) size;
  handle->access.m_GetBlock = bare_pdfium__get_block;
  handle->access.m_Param = file;

  bare_pdfium__lock();
  bare_pdfium__ensure_init();
  handle->doc = FPDF_LoadCustomDocument(&handle->access, password_len ? password : NULL);
  unsigned long code = handle->doc == NULL ? FPDF_GetLastError() : FPDF_ERR_SUCCESS;
  bare_pdfium__unlock();

  if (handle->doc == NULL) {
    fclose(file);
    free(handle);
    bare_pdfium__throw_load_error(env, code);
    return NULL;
  }

  js_value_t *external;
  err = js_create_external(env, handle, bare_pdfium__on_doc_finalize, NULL, &external);
  assert(err == 0);

  return external;
}

static js_value_t *
bare_pdfium_close(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);
  // idempotent: the finalizer frees the struct, so null the fields it would touch
  bare_pdfium__lock();
  if (handle->doc) {
    FPDF_CloseDocument(handle->doc);
    handle->doc = NULL;
  }
  bare_pdfium__unlock();
  if (handle->file) {
    fclose(handle->file);
    handle->file = NULL;
  }
  free(handle->buf);
  handle->buf = NULL;

  return NULL;
}

static js_value_t *
bare_pdfium_page_count(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  bare_pdfium__lock();
  int count = FPDF_GetPageCount(handle->doc);
  bare_pdfium__unlock();

  js_value_t *result;
  err = js_create_int64(env, count, &result);
  assert(err == 0);

  return result;
}

static js_value_t *
bare_pdfium_page_size(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  FS_SIZEF size;
  bare_pdfium__lock();
  bool found = FPDF_GetPageSizeByIndexF(handle->doc, (int) page_index, &size);
  bare_pdfium__unlock();
  if (!found) {
    err = js_throw_error(env, NULL, "page index out of range");
    assert(err == 0);
    return NULL;
  }

  js_value_t *result;
  err = js_create_object(env, &result);
  assert(err == 0);

  js_value_t *width;
  err = js_create_double(env, size.width, &width);
  assert(err == 0);
  err = js_set_named_property(env, result, "width", width);
  assert(err == 0);

  js_value_t *height;
  err = js_create_double(env, size.height, &height);
  assert(err == 0);
  err = js_set_named_property(env, result, "height", height);
  assert(err == 0);

  return result;
}

static js_value_t *
bare_pdfium_page_flags(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  bare_pdfium__lock();

  FPDF_PAGE page = FPDF_LoadPage(handle->doc, (int) page_index);
  if (page == NULL) {
    bare_pdfium__unlock();
    err = js_throw_error(env, NULL, "failed to load page");
    assert(err == 0);
    return NULL;
  }

  double page_area = FPDF_GetPageWidth(page) * FPDF_GetPageHeight(page);
  bool has_image = false;
  int objects = FPDFPage_CountObjects(page);
  for (int i = 0; i < objects && !has_image; i++) {
    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, i);
    if (FPDFPageObj_GetType(object) != FPDF_PAGEOBJ_IMAGE) continue;
    float left, bottom, right, top;
    if (!FPDFPageObj_GetBounds(object, &left, &bottom, &right, &top)) {
      has_image = true;
      break;
    }
    double area = ((double) right - left) * ((double) top - bottom);
    if (page_area <= 0 || area >= BARE_PDFIUM_MIN_IMAGE_FRACTION * page_area) has_image = true;
  }

  bool has_text = false;
  FPDF_TEXTPAGE text_page = FPDFText_LoadPage(page);
  if (text_page != NULL) {
    has_text = FPDFText_CountChars(text_page) > 0;
    FPDFText_ClosePage(text_page);
  }

  FPDF_ClosePage(page);

  bare_pdfium__unlock();

  js_value_t *result;
  err = js_create_object(env, &result);
  assert(err == 0);
  bare_pdfium__set_bool(env, result, "hasImage", has_image);
  bare_pdfium__set_bool(env, result, "hasText", has_text);

  return result;
}

static js_value_t *
bare_pdfium_render(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 3;
  js_value_t *argv[3];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  double scale;
  err = js_get_value_double(env, argv[2], &scale);
  assert(err == 0);

  bare_pdfium_raster_t raster;
  bare_pdfium__lock();
  const char *error = bare_pdfium__render_page(handle->doc, (int) page_index, scale, &raster);
  bare_pdfium__unlock();

  if (error) {
    err = js_throw_error(env, NULL, error);
    assert(err == 0);
    return NULL;
  }

  return bare_pdfium__raster_result(env, &raster);
}

static js_value_t *
bare_pdfium_extract_images(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  bare_pdfium__lock();

  FPDF_PAGE page = FPDF_LoadPage(handle->doc, (int) page_index);
  if (page == NULL) {
    bare_pdfium__unlock();
    err = js_throw_error(env, NULL, "failed to load page");
    assert(err == 0);
    return NULL;
  }

  int objects = FPDFPage_CountObjects(page);
  bare_pdfium_raster_t *images = objects > 0 ? malloc(sizeof(bare_pdfium_raster_t) * (size_t) objects) : NULL;
  const char *error = objects > 0 && images == NULL ? "failed to allocate bitmap" : NULL;
  uint32_t count = 0;
  for (int i = 0; error == NULL && i < objects; i++) {
    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, i);
    if (FPDFPageObj_GetType(object) != FPDF_PAGEOBJ_IMAGE) continue;

    FPDF_BITMAP bitmap = FPDFImageObj_GetRenderedBitmap(handle->doc, page, object);
    if (bitmap == NULL) continue;

    if (FPDFBitmap_GetWidth(bitmap) < BARE_PDFIUM_MIN_IMAGE_PX ||
        FPDFBitmap_GetHeight(bitmap) < BARE_PDFIUM_MIN_IMAGE_PX) {
      FPDFBitmap_Destroy(bitmap);
      continue;
    }

    if (bare_pdfium__raster(bitmap, &images[count])) count++;
    else error = "failed to allocate bitmap";
    FPDFBitmap_Destroy(bitmap);
  }

  FPDF_ClosePage(page);

  bare_pdfium__unlock();

  if (error) {
    for (uint32_t i = 0; i < count; i++) free(images[i].rgba);
    free(images);
    err = js_throw_error(env, NULL, error);
    assert(err == 0);
    return NULL;
  }

  js_value_t *result;
  err = js_create_array(env, &result);
  assert(err == 0);

  for (uint32_t i = 0; i < count; i++) {
    js_value_t *item = bare_pdfium__raster_result(env, &images[i]);

    err = js_set_element(env, result, i, item);
    assert(err == 0);
  }

  free(images);

  return result;
}

static js_value_t *
bare_pdfium_extract_text(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 3;
  js_value_t *argv[3];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  bool clip;
  err = js_get_value_bool(env, argv[2], &clip);
  assert(err == 0);

  unsigned short *text;
  size_t units;
  bare_pdfium__lock();
  const char *error = bare_pdfium__page_text(handle->doc, (int) page_index, clip, &text, &units);
  bare_pdfium__unlock();

  if (error) {
    err = js_throw_error(env, NULL, error);
    assert(err == 0);
    return NULL;
  }

  js_value_t *result = bare_pdfium__text_result(env, text, units);
  free(text);

  return result;
}

static js_value_t *
bare_pdfium__queue_job(js_env_t *env, js_value_t *external, int64_t page_index, bare_pdfium_job_t **result) {
  int err;

  bare_pdfium_job_t *job = calloc(1, sizeof(bare_pdfium_job_t));
  job->req.data = job;
  job->env = env;
  job->handle = bare_pdfium__handle(env, external);
  job->page_index = (int) page_index;

  err = js_create_reference(env, external, 1, &job->ref);
  assert(err == 0);

  js_value_t *promise;
  err = js_create_promise(env, &job->deferred, &promise);
  assert(err == 0);

  *result = job;
  return promise;
}

static void
bare_pdfium__settle_job(bare_pdfium_job_t *job, js_value_t *resolution) {
  int err;
  js_env_t *env = job->env;

  if (job->error) {
    js_value_t *message;
    err = js_create_string_utf8(env, (const utf8_t *) job->error, -1, &message);
    assert(err == 0);
    js_value_t *error;
    err = js_create_error(env, NULL, message, &error);
    assert(err == 0);
    err = js_reject_deferred(env, job->deferred, error);
    assert(err == 0);
  } else {
    err = js_resolve_deferred(env, job->deferred, resolution);
    assert(err == 0);
  }

  err = js_delete_reference(env, job->ref);
  assert(err == 0);

  free(job->text);
  free(job->raster.rgba);
  free(job);
}

static void
bare_pdfium__text_work(uv_work_t *req) {
  bare_pdfium_job_t *job = (bare_pdfium_job_t *) req->data;
  bare_pdfium__lock();
  job->error = job->handle->doc
    ? bare_pdfium__page_text(job->handle->doc, job->page_index, job->clip, &job->text, &job->units)
    : "document is closed";
  bare_pdfium__unlock();
}

static void
bare_pdfium__text_done(uv_work_t *req, int status) {
  int err;
  bare_pdfium_job_t *job = (bare_pdfium_job_t *) req->data;
  js_env_t *env = job->env;

  js_handle_scope_t *scope;
  err = js_open_handle_scope(env, &scope);
  assert(err == 0);

  js_value_t *result = job->error ? NULL : bare_pdfium__text_result(env, job->text, job->units);
  bare_pdfium__settle_job(job, result);

  err = js_close_handle_scope(env, scope);
  assert(err == 0);
}

static js_value_t *
bare_pdfium_extract_text_async(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 3;
  js_value_t *argv[3];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  bare_pdfium_job_t *job;
  js_value_t *promise = bare_pdfium__queue_job(env, argv[0], page_index, &job);

  err = js_get_value_bool(env, argv[2], &job->clip);
  assert(err == 0);

  uv_loop_t *loop;
  err = js_get_env_loop(env, &loop);
  assert(err == 0);

  err = uv_queue_work(loop, &job->req, bare_pdfium__text_work, bare_pdfium__text_done);
  assert(err == 0);

  return promise;
}

static void
bare_pdfium__render_work(uv_work_t *req) {
  bare_pdfium_job_t *job = (bare_pdfium_job_t *) req->data;
  bare_pdfium__lock();
  job->error = job->handle->doc
    ? bare_pdfium__render_page(job->handle->doc, job->page_index, job->scale, &job->raster)
    : "document is closed";
  bare_pdfium__unlock();
}

static void
bare_pdfium__render_done(uv_work_t *req, int status) {
  int err;
  bare_pdfium_job_t *job = (bare_pdfium_job_t *) req->data;
  js_env_t *env = job->env;

  js_handle_scope_t *scope;
  err = js_open_handle_scope(env, &scope);
  assert(err == 0);

  js_value_t *result = job->error ? NULL : bare_pdfium__raster_result(env, &job->raster);
  bare_pdfium__settle_job(job, result);

  err = js_close_handle_scope(env, scope);
  assert(err == 0);
}

static js_value_t *
bare_pdfium_render_async(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 3;
  js_value_t *argv[3];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  bare_pdfium_job_t *job;
  js_value_t *promise = bare_pdfium__queue_job(env, argv[0], page_index, &job);

  err = js_get_value_double(env, argv[2], &job->scale);
  assert(err == 0);

  uv_loop_t *loop;
  err = js_get_env_loop(env, &loop);
  assert(err == 0);

  err = uv_queue_work(loop, &job->req, bare_pdfium__render_work, bare_pdfium__render_done);
  assert(err == 0);

  return promise;
}

static void
bare_pdfium__throw(js_env_t *env, const char *message) {
  int err = js_throw_error(env, NULL, message);
  assert(err == 0);
}

static int *
bare_pdfium__copy_pages(js_env_t *env, js_value_t *value, size_t *len) {
  int err;
  void *data;
  err = js_get_typedarray_info(env, value, NULL, &data, len, NULL, NULL);
  assert(err == 0);
  int *pages = malloc((*len ? *len : 1) * sizeof(int));
  memcpy(pages, data, *len * sizeof(int));
  return pages;
}

static utf16_t *
bare_pdfium__utf16(js_env_t *env, js_value_t *value) {
  int err;
  size_t len;
  err = js_get_value_string_utf16le(env, value, NULL, 0, &len);
  assert(err == 0);
  utf16_t *str = malloc((len + 1) * sizeof(utf16_t));
  err = js_get_value_string_utf16le(env, value, str, len + 1, &len);
  assert(err == 0);
  str[len] = 0;
  return str;
}

static bool
bare_pdfium__utf16_equal(const utf16_t *a, const utf16_t *b) {
  while (*a && *a == *b) a++, b++;
  return *a == *b;
}

static js_value_t *
bare_pdfium__utf16_value(js_env_t *env, const utf16_t *str) {
  size_t len = 0;
  while (str[len]) len++;
  js_value_t *result;
  int err = js_create_string_utf16le(env, str, len, &result);
  assert(err == 0);
  return result;
}

static js_value_t *
bare_pdfium_create(js_env_t *env, js_callback_info_t *info) {
  int err;

  bare_pdfium__lock();
  bare_pdfium__ensure_init();
  FPDF_DOCUMENT doc = FPDF_CreateNewDocument();
  bare_pdfium__unlock();

  if (doc == NULL) {
    bare_pdfium__throw(env, "failed to create document");
    return NULL;
  }

  bare_pdfium_doc_t *handle = calloc(1, sizeof(bare_pdfium_doc_t));
  handle->doc = doc;

  js_value_t *external;
  err = js_create_external(env, handle, bare_pdfium__on_doc_finalize, NULL, &external);
  assert(err == 0);

  return external;
}

static const char *
bare_pdfium__rotate_pages(FPDF_DOCUMENT doc, const int *pages, size_t len, int turns) {
  for (size_t i = 0; i < len; i++) {
    FPDF_PAGE page = FPDF_LoadPage(doc, pages[i]);
    if (page == NULL) return "failed to load page";
    FPDFPage_SetRotation(page, ((FPDFPage_GetRotation(page) + turns) % 4 + 4) % 4);
    FPDF_ClosePage(page);
  }
  return NULL;
}

typedef struct {
  FPDF_FILEWRITE base;
  uint8_t *data;
  size_t len;
  size_t cap;
} bare_pdfium_writer_t;

static int
bare_pdfium__write_block(FPDF_FILEWRITE *self, const void *data, unsigned long size) {
  bare_pdfium_writer_t *writer = (bare_pdfium_writer_t *) self;
  if (writer->len + size > writer->cap) {
    size_t cap = writer->cap ? writer->cap : 65536;
    while (cap < writer->len + size) cap *= 2;
    uint8_t *grown = realloc(writer->data, cap);
    if (grown == NULL) return 0;
    writer->data = grown;
    writer->cap = cap;
  }
  memcpy(writer->data + writer->len, data, size);
  writer->len += size;
  return 1;
}

static const char *
bare_pdfium__save_document(FPDF_DOCUMENT doc, bool remove_security, uint8_t **data, size_t *len) {
  bare_pdfium_writer_t writer = {0};
  writer.base.version = 1;
  writer.base.WriteBlock = bare_pdfium__write_block;

  if (!FPDF_SaveAsCopy(doc, &writer.base, remove_security ? FPDF_REMOVE_SECURITY : FPDF_NO_INCREMENTAL)) {
    free(writer.data);
    return "failed to save document";
  }

  *data = writer.data;
  *len = writer.len;
  return NULL;
}

static const char *
bare_pdfium__stamp(FPDF_DOCUMENT doc, FPDF_PAGE page, FPDF_FONT font, const utf16_t *text, double size, double angle, uint32_t color, bool under) {
  double base = size > 0 ? size : 100;
  FPDF_PAGEOBJECT object = font
    ? FPDFPageObj_CreateTextObj(doc, font, (float) base)
    : FPDFPageObj_NewTextObj(doc, "Helvetica-Bold", (float) base);
  if (object == NULL) return "failed to create watermark text";

  if (!FPDFText_SetText(object, (FPDF_WIDESTRING) text)) {
    FPDFPageObj_Destroy(object);
    return "failed to set watermark text";
  }

  FPDFPageObj_SetFillColor(object, (color >> 24) & 0xff, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);

  float left, bottom, right, top;
  if (!FPDFPageObj_GetBounds(object, &left, &bottom, &right, &top)) {
    FPDFPageObj_Destroy(object);
    return "failed to measure watermark text";
  }

  FS_RECTF box;
  if (!FPDF_GetPageBoundingBox(page, &box)) {
    FPDFPageObj_Destroy(object);
    return "failed to read page box";
  }

  double radians = (angle + 90.0 * FPDFPage_GetRotation(page)) * 3.14159265358979323846 / 180.0;
  double cos_a = cos(radians), sin_a = sin(radians);

  double text_width = (double) right - left, text_height = (double) top - bottom;
  double page_width = (double) box.right - box.left, page_height = (double) box.top - box.bottom;

  double scale = 1;
  if (size <= 0 && text_width > 0) {
    double span_x = fabs(text_width * cos_a) + fabs(text_height * sin_a);
    double span_y = fabs(text_width * sin_a) + fabs(text_height * cos_a);
    scale = fmin(0.8 * page_width / span_x, 0.8 * page_height / span_y);
  }

  double mid_x = ((double) left + right) / 2, mid_y = ((double) bottom + top) / 2;
  double center_x = ((double) box.left + box.right) / 2, center_y = ((double) box.bottom + box.top) / 2;

  double a = scale * cos_a, b = scale * sin_a, c = -scale * sin_a, d = scale * cos_a;
  FPDFPageObj_Transform(object, a, b, c, d, center_x - (a * mid_x + c * mid_y), center_y - (b * mid_x + d * mid_y));

  bool inserted = under ? FPDFPage_InsertObjectAtIndex(page, object, 0) : (FPDFPage_InsertObject(page, object), true);
  if (!inserted) {
    FPDFPageObj_Destroy(object);
    return "failed to insert watermark";
  }

  return FPDFPage_GenerateContent(page) ? NULL : "failed to write page content";
}

static const char *
bare_pdfium__watermark_pages(FPDF_DOCUMENT doc, const int *pages, size_t len, const utf16_t *text, const uint8_t *font_data, size_t font_len, double size, double angle, uint32_t color, bool under) {
  FPDF_FONT font = NULL;
  if (font_data) {
    font = FPDFText_LoadFont(doc, font_data, (uint32_t) font_len, FPDF_FONT_TRUETYPE, true);
    if (font == NULL) return "failed to load font";
  }

  const char *error = NULL;
  for (size_t i = 0; i < len && error == NULL; i++) {
    FPDF_PAGE page = FPDF_LoadPage(doc, pages[i]);
    if (page == NULL) {
      error = "failed to load page";
      break;
    }
    error = bare_pdfium__stamp(doc, page, font, text, size, angle, color, under);
    FPDF_ClosePage(page);
  }

  if (font) FPDFFont_Close(font);

  return error;
}

typedef struct {
  int page;
  int type;
  int flags;
  bool checked;
  utf16_t *name;
  utf16_t *value;
  utf16_t *export_value;
  int option_count;
  utf16_t **options;
  bool *selected;
} bare_pdfium_widget_t;

typedef enum {
  BARE_PDFIUM_ENTRY_CHECK,
  BARE_PDFIUM_ENTRY_TEXT,
  BARE_PDFIUM_ENTRY_ITEMS
} bare_pdfium_entry_kind_t;

typedef struct {
  utf16_t *name;
  bare_pdfium_entry_kind_t kind;
  bool checked;
  utf16_t *text;
  utf16_t **items;
  uint32_t item_count;
  bool done;
} bare_pdfium_entry_t;

typedef struct {
  FPDF_FORMHANDLE form;
  FPDF_PAGE page;
  FPDF_ANNOTATION annot;
  int page_index;
  bare_pdfium_widget_t *widgets;
  size_t widget_count;
  size_t widget_cap;
  bare_pdfium_entry_t *entries;
  size_t entry_count;
} bare_pdfium_form_walk_t;

typedef void (*bare_pdfium_widget_fn)(bare_pdfium_form_walk_t *walk);

typedef unsigned long (*bare_pdfium_annot_text_fn)(FPDF_FORMHANDLE, FPDF_ANNOTATION, FPDF_WCHAR *, unsigned long);

static utf16_t *
bare_pdfium__annot_text(FPDF_FORMHANDLE form, FPDF_ANNOTATION annot, bare_pdfium_annot_text_fn fn) {
  unsigned long bytes = fn(form, annot, NULL, 0);
  utf16_t *str = calloc(bytes / 2 + 1, sizeof(utf16_t));
  if (bytes) fn(form, annot, (FPDF_WCHAR *) str, bytes);
  return str;
}

static utf16_t *
bare_pdfium__option_label(FPDF_FORMHANDLE form, FPDF_ANNOTATION annot, int index) {
  unsigned long bytes = FPDFAnnot_GetOptionLabel(form, annot, index, NULL, 0);
  utf16_t *str = calloc(bytes / 2 + 1, sizeof(utf16_t));
  if (bytes) FPDFAnnot_GetOptionLabel(form, annot, index, (FPDF_WCHAR *) str, bytes);
  return str;
}

static const char *
bare_pdfium__walk_widgets(FPDF_DOCUMENT doc, bare_pdfium_form_walk_t *walk, bare_pdfium_widget_fn fn) {
  FPDF_FORMFILLINFO info;
  memset(&info, 0, sizeof(info));
  info.version = 1;

  walk->form = FPDFDOC_InitFormFillEnvironment(doc, &info);
  if (walk->form == NULL) return "failed to load the form";

  const char *error = NULL;
  int count = FPDF_GetPageCount(doc);

  for (int i = 0; i < count && error == NULL; i++) {
    FPDF_PAGE page = FPDF_LoadPage(doc, i);
    if (page == NULL) {
      error = "failed to load page";
      break;
    }
    FORM_OnAfterLoadPage(page, walk->form);

    walk->page = page;
    walk->page_index = i;

    int annots = FPDFPage_GetAnnotCount(page);
    for (int j = 0; j < annots; j++) {
      FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, j);
      if (annot == NULL) continue;
      if (FPDFAnnot_GetSubtype(annot) == FPDF_ANNOT_WIDGET) {
        walk->annot = annot;
        fn(walk);
      }
      FPDFPage_CloseAnnot(annot);
    }

    FORM_OnBeforeClosePage(page, walk->form);
    FPDF_ClosePage(page);
  }

  FPDFDOC_ExitFormFillEnvironment(walk->form);

  return error;
}

static void
bare_pdfium__collect_widget(bare_pdfium_form_walk_t *walk) {
  if (walk->widget_count == walk->widget_cap) {
    walk->widget_cap = walk->widget_cap ? walk->widget_cap * 2 : 16;
    walk->widgets = realloc(walk->widgets, walk->widget_cap * sizeof(bare_pdfium_widget_t));
  }

  FPDF_FORMHANDLE form = walk->form;
  FPDF_ANNOTATION annot = walk->annot;
  bare_pdfium_widget_t *widget = &walk->widgets[walk->widget_count++];

  widget->page = walk->page_index;
  widget->type = FPDFAnnot_GetFormFieldType(form, annot);
  widget->flags = FPDFAnnot_GetFormFieldFlags(form, annot);
  widget->checked = FPDFAnnot_IsChecked(form, annot);
  widget->name = bare_pdfium__annot_text(form, annot, FPDFAnnot_GetFormFieldName);
  widget->value = bare_pdfium__annot_text(form, annot, FPDFAnnot_GetFormFieldValue);
  widget->export_value = bare_pdfium__annot_text(form, annot, FPDFAnnot_GetFormFieldExportValue);
  widget->option_count = 0;
  widget->options = NULL;
  widget->selected = NULL;

  if (widget->type == FPDF_FORMFIELD_COMBOBOX || widget->type == FPDF_FORMFIELD_LISTBOX) {
    int count = FPDFAnnot_GetOptionCount(form, annot);
    if (count > 0) {
      widget->option_count = count;
      widget->options = malloc(count * sizeof(utf16_t *));
      widget->selected = malloc(count * sizeof(bool));
      for (int i = 0; i < count; i++) {
        widget->options[i] = bare_pdfium__option_label(form, annot, i);
        widget->selected[i] = FPDFAnnot_IsOptionSelected(form, annot, i);
      }
    }
  }
}

static void
bare_pdfium__free_widgets(bare_pdfium_widget_t *widgets, size_t count) {
  for (size_t i = 0; i < count; i++) {
    free(widgets[i].name);
    free(widgets[i].value);
    free(widgets[i].export_value);
    for (int j = 0; j < widgets[i].option_count; j++) free(widgets[i].options[j]);
    free(widgets[i].options);
    free(widgets[i].selected);
  }
  free(widgets);
}

static const char *
bare_pdfium__form_widgets(FPDF_DOCUMENT doc, bare_pdfium_widget_t **widgets, size_t *count) {
  bare_pdfium_form_walk_t walk = {0};
  const char *error = FPDF_GetFormType(doc) == FORMTYPE_NONE
    ? NULL
    : bare_pdfium__walk_widgets(doc, &walk, bare_pdfium__collect_widget);
  if (error) {
    bare_pdfium__free_widgets(walk.widgets, walk.widget_count);
    return error;
  }
  *widgets = walk.widgets;
  *count = walk.widget_count;
  return NULL;
}

static const char *
bare_pdfium__field_type(int type) {
  switch (type) {
  case FPDF_FORMFIELD_PUSHBUTTON:
    return "button";
  case FPDF_FORMFIELD_CHECKBOX:
    return "checkbox";
  case FPDF_FORMFIELD_RADIOBUTTON:
    return "radio";
  case FPDF_FORMFIELD_COMBOBOX:
    return "combobox";
  case FPDF_FORMFIELD_LISTBOX:
    return "listbox";
  case FPDF_FORMFIELD_TEXTFIELD:
    return "text";
  case FPDF_FORMFIELD_SIGNATURE:
    return "signature";
  default:
    return "unknown";
  }
}

static void
bare_pdfium__set_text(js_env_t *env, js_value_t *object, const char *name, const char *text) {
  js_value_t *value;
  int err = js_create_string_utf8(env, (const utf8_t *) text, -1, &value);
  assert(err == 0);
  err = js_set_named_property(env, object, name, value);
  assert(err == 0);
}

static void
bare_pdfium__set_field_flags(js_env_t *env, js_value_t *object, int flags) {
  bare_pdfium__set_bool(env, object, "readOnly", (flags & FPDF_FORMFLAG_READONLY) != 0);
  bare_pdfium__set_bool(env, object, "required", (flags & FPDF_FORMFLAG_REQUIRED) != 0);
  bare_pdfium__set_bool(env, object, "editable", (flags & FPDF_FORMFLAG_CHOICE_EDIT) != 0);
  bare_pdfium__set_bool(env, object, "multiSelect", (flags & FPDF_FORMFLAG_CHOICE_MULTI_SELECT) != 0);
}

static js_value_t *
bare_pdfium__widgets_result(js_env_t *env, const bare_pdfium_widget_t *widgets, size_t count) {
  int err;

  js_value_t *result;
  err = js_create_array(env, &result);
  assert(err == 0);

  for (size_t i = 0; i < count; i++) {
    const bare_pdfium_widget_t *widget = &widgets[i];

    js_value_t *item;
    err = js_create_object(env, &item);
    assert(err == 0);

    bare_pdfium__set_int(env, item, "page", widget->page);
    bare_pdfium__set_text(env, item, "type", bare_pdfium__field_type(widget->type));
    bare_pdfium__set_field_flags(env, item, widget->flags);
    bare_pdfium__set_bool(env, item, "checked", widget->checked);

    err = js_set_named_property(env, item, "name", bare_pdfium__utf16_value(env, widget->name));
    assert(err == 0);
    err = js_set_named_property(env, item, "value", bare_pdfium__utf16_value(env, widget->value));
    assert(err == 0);
    err = js_set_named_property(env, item, "exportValue", bare_pdfium__utf16_value(env, widget->export_value));
    assert(err == 0);

    js_value_t *options, *selected;
    err = js_create_array(env, &options);
    assert(err == 0);
    err = js_create_array(env, &selected);
    assert(err == 0);

    for (int j = 0; j < widget->option_count; j++) {
      err = js_set_element(env, options, (uint32_t) j, bare_pdfium__utf16_value(env, widget->options[j]));
      assert(err == 0);
      js_value_t *flag;
      err = js_get_boolean(env, widget->selected[j], &flag);
      assert(err == 0);
      err = js_set_element(env, selected, (uint32_t) j, flag);
      assert(err == 0);
    }

    err = js_set_named_property(env, item, "options", options);
    assert(err == 0);
    err = js_set_named_property(env, item, "selected", selected);
    assert(err == 0);

    err = js_set_element(env, result, (uint32_t) i, item);
    assert(err == 0);
  }

  return result;
}

static void
bare_pdfium__toggle(bare_pdfium_form_walk_t *walk) {
  bool before = FPDFAnnot_IsChecked(walk->form, walk->annot);

  if (FORM_SetFocusedAnnot(walk->form, walk->annot)) {
    FORM_OnChar(walk->form, walk->page, ' ', 0);
    FORM_ForceToKillFocus(walk->form);
  }

  if (FPDFAnnot_IsChecked(walk->form, walk->annot) != before) return;

  FS_RECTF rect;
  if (!FPDFAnnot_GetRect(walk->annot, &rect)) return;
  double x = ((double) rect.left + rect.right) / 2, y = ((double) rect.bottom + rect.top) / 2;
  FORM_OnLButtonDown(walk->form, walk->page, 0, x, y);
  FORM_OnLButtonUp(walk->form, walk->page, 0, x, y);
  FORM_ForceToKillFocus(walk->form);
}

static void
bare_pdfium__fill_text(bare_pdfium_form_walk_t *walk, const utf16_t *text) {
  if (!FORM_SetFocusedAnnot(walk->form, walk->annot)) return;
  FORM_SelectAllText(walk->form, walk->page);
  FORM_ReplaceSelection(walk->form, walk->page, (FPDF_WIDESTRING) text);
  FORM_ForceToKillFocus(walk->form);
}

static void
bare_pdfium__fill_choice(bare_pdfium_form_walk_t *walk, const bare_pdfium_entry_t *entry, bool combo) {
  if (!FORM_SetFocusedAnnot(walk->form, walk->annot)) return;

  int count = FPDFAnnot_GetOptionCount(walk->form, walk->annot);
  for (int i = 0; i < count; i++) {
    utf16_t *label = bare_pdfium__option_label(walk->form, walk->annot, i);
    bool select = false;
    for (uint32_t k = 0; k < entry->item_count && !select; k++) {
      select = bare_pdfium__utf16_equal(label, entry->items[k]);
    }
    free(label);
    if (select || !combo) FORM_SetIndexSelected(walk->form, walk->page, i, select);
  }

  FORM_ForceToKillFocus(walk->form);
}

static void
bare_pdfium__fill_widget(bare_pdfium_form_walk_t *walk) {
  utf16_t *name = bare_pdfium__annot_text(walk->form, walk->annot, FPDFAnnot_GetFormFieldName);
  bare_pdfium_entry_t *entry = NULL;
  for (size_t i = 0; i < walk->entry_count && entry == NULL; i++) {
    if (bare_pdfium__utf16_equal(name, walk->entries[i].name)) entry = &walk->entries[i];
  }
  free(name);

  if (entry == NULL || entry->done) return;

  int type = FPDFAnnot_GetFormFieldType(walk->form, walk->annot);

  if (type == FPDF_FORMFIELD_CHECKBOX || type == FPDF_FORMFIELD_RADIOBUTTON) {
    bool want = false;
    if (entry->kind == BARE_PDFIUM_ENTRY_CHECK) {
      want = entry->checked;
    } else if (entry->kind == BARE_PDFIUM_ENTRY_TEXT) {
      utf16_t *export_value = bare_pdfium__annot_text(walk->form, walk->annot, FPDFAnnot_GetFormFieldExportValue);
      want = bare_pdfium__utf16_equal(entry->text, export_value);
      free(export_value);
    }
    bool checked = FPDFAnnot_IsChecked(walk->form, walk->annot);
    if (want != checked && (want || type == FPDF_FORMFIELD_CHECKBOX)) bare_pdfium__toggle(walk);
    return;
  }

  if (entry->kind == BARE_PDFIUM_ENTRY_TEXT) {
    bare_pdfium__fill_text(walk, entry->text);
  } else if (entry->kind == BARE_PDFIUM_ENTRY_ITEMS) {
    bare_pdfium__fill_choice(walk, entry, type == FPDF_FORMFIELD_COMBOBOX);
  }

  entry->done = true;
}

static bare_pdfium_entry_t *
bare_pdfium__entries(js_env_t *env, js_value_t *names, js_value_t *values, size_t *count) {
  int err;

  uint32_t len;
  err = js_get_array_length(env, names, &len);
  assert(err == 0);

  bare_pdfium_entry_t *entries = calloc(len ? len : 1, sizeof(bare_pdfium_entry_t));

  for (uint32_t i = 0; i < len; i++) {
    bare_pdfium_entry_t *entry = &entries[i];

    js_value_t *name, *value;
    err = js_get_element(env, names, i, &name);
    assert(err == 0);
    err = js_get_element(env, values, i, &value);
    assert(err == 0);

    entry->name = bare_pdfium__utf16(env, name);

    js_value_type_t type;
    err = js_typeof(env, value, &type);
    assert(err == 0);

    if (type == js_boolean) {
      entry->kind = BARE_PDFIUM_ENTRY_CHECK;
      err = js_get_value_bool(env, value, &entry->checked);
      assert(err == 0);
    } else if (type == js_string) {
      entry->kind = BARE_PDFIUM_ENTRY_TEXT;
      entry->text = bare_pdfium__utf16(env, value);
    } else {
      entry->kind = BARE_PDFIUM_ENTRY_ITEMS;
      err = js_get_array_length(env, value, &entry->item_count);
      assert(err == 0);
      entry->items = malloc((entry->item_count ? entry->item_count : 1) * sizeof(utf16_t *));
      for (uint32_t k = 0; k < entry->item_count; k++) {
        js_value_t *item;
        err = js_get_element(env, value, k, &item);
        assert(err == 0);
        entry->items[k] = bare_pdfium__utf16(env, item);
      }
    }
  }

  *count = len;
  return entries;
}

static void
bare_pdfium__free_entries(bare_pdfium_entry_t *entries, size_t count) {
  if (entries == NULL) return;
  for (size_t i = 0; i < count; i++) {
    free(entries[i].name);
    free(entries[i].text);
    for (uint32_t k = 0; k < entries[i].item_count; k++) free(entries[i].items[k]);
    free(entries[i].items);
  }
  free(entries);
}

typedef enum {
  BARE_PDFIUM_RESULT_NONE,
  BARE_PDFIUM_RESULT_BUFFER,
  BARE_PDFIUM_RESULT_WIDGETS
} bare_pdfium_result_kind_t;

typedef struct bare_pdfium_edit_job_s bare_pdfium_edit_job_t;

struct bare_pdfium_edit_job_s {
  uv_work_t req;
  js_env_t *env;
  js_deferred_t *deferred;
  js_ref_t *ref;
  js_ref_t *source_ref;
  js_value_t *source_value;
  bare_pdfium_doc_t *handle;
  bare_pdfium_doc_t *source;
  const char *(*work)(bare_pdfium_edit_job_t *job);
  bare_pdfium_result_kind_t result;
  int *pages;
  size_t pages_len;
  int32_t number;
  bool flag;
  utf16_t *text;
  uint8_t *font;
  size_t font_len;
  double size;
  double angle;
  uint32_t color;
  bare_pdfium_entry_t *entries;
  size_t entry_count;
  const char *error;
  uint8_t *data;
  size_t len;
  bare_pdfium_widget_t *widgets;
  size_t widget_count;
};

typedef void (*bare_pdfium_edit_setup_fn)(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job);

static const char *
bare_pdfium__import_work(bare_pdfium_edit_job_t *job) {
  int at = job->number < 0 ? FPDF_GetPageCount(job->handle->doc) : job->number;
  bool ok = FPDF_ImportPagesByIndex(job->handle->doc, job->source->doc, job->pages, (unsigned long) job->pages_len, at);
  return ok ? NULL : "failed to import pages";
}

static void
bare_pdfium__import_setup(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job) {
  job->source_value = argv[1];
  job->source = bare_pdfium__handle(env, argv[1]);
  job->pages = bare_pdfium__copy_pages(env, argv[2], &job->pages_len);
  int err = js_get_value_int32(env, argv[3], &job->number);
  assert(err == 0);
  job->work = bare_pdfium__import_work;
}

static const char *
bare_pdfium__rotate_work(bare_pdfium_edit_job_t *job) {
  return bare_pdfium__rotate_pages(job->handle->doc, job->pages, job->pages_len, job->number);
}

static void
bare_pdfium__rotate_setup(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job) {
  job->pages = bare_pdfium__copy_pages(env, argv[1], &job->pages_len);
  int err = js_get_value_int32(env, argv[2], &job->number);
  assert(err == 0);
  job->work = bare_pdfium__rotate_work;
}

static const char *
bare_pdfium__watermark_work(bare_pdfium_edit_job_t *job) {
  return bare_pdfium__watermark_pages(
    job->handle->doc, job->pages, job->pages_len, job->text, job->font, job->font_len, job->size, job->angle, job->color, job->flag
  );
}

static void
bare_pdfium__watermark_setup(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job) {
  int err;

  job->pages = bare_pdfium__copy_pages(env, argv[1], &job->pages_len);
  job->text = bare_pdfium__utf16(env, argv[2]);

  bool has_font;
  err = js_is_typedarray(env, argv[3], &has_font);
  assert(err == 0);
  if (has_font) {
    void *data;
    err = js_get_typedarray_info(env, argv[3], NULL, &data, &job->font_len, NULL, NULL);
    assert(err == 0);
    job->font = malloc(job->font_len ? job->font_len : 1);
    memcpy(job->font, data, job->font_len);
  }

  err = js_get_value_double(env, argv[4], &job->size);
  assert(err == 0);
  err = js_get_value_double(env, argv[5], &job->angle);
  assert(err == 0);
  err = js_get_value_uint32(env, argv[6], &job->color);
  assert(err == 0);
  err = js_get_value_bool(env, argv[7], &job->flag);
  assert(err == 0);

  job->work = bare_pdfium__watermark_work;
}

static const char *
bare_pdfium__save_work(bare_pdfium_edit_job_t *job) {
  return bare_pdfium__save_document(job->handle->doc, job->flag, &job->data, &job->len);
}

static void
bare_pdfium__save_setup(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job) {
  int err = js_get_value_bool(env, argv[1], &job->flag);
  assert(err == 0);
  job->work = bare_pdfium__save_work;
  job->result = BARE_PDFIUM_RESULT_BUFFER;
}

static const char *
bare_pdfium__widgets_work(bare_pdfium_edit_job_t *job) {
  return bare_pdfium__form_widgets(job->handle->doc, &job->widgets, &job->widget_count);
}

static void
bare_pdfium__widgets_setup(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job) {
  job->work = bare_pdfium__widgets_work;
  job->result = BARE_PDFIUM_RESULT_WIDGETS;
}

static const char *
bare_pdfium__fill_work(bare_pdfium_edit_job_t *job) {
  bare_pdfium_form_walk_t walk = {.entries = job->entries, .entry_count = job->entry_count};
  return bare_pdfium__walk_widgets(job->handle->doc, &walk, bare_pdfium__fill_widget);
}

static void
bare_pdfium__fill_setup(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job) {
  job->entries = bare_pdfium__entries(env, argv[1], argv[2], &job->entry_count);
  job->work = bare_pdfium__fill_work;
}

static void
bare_pdfium__run_edit(bare_pdfium_edit_job_t *job) {
  bare_pdfium__lock();
  if (job->handle->doc == NULL || (job->source && job->source->doc == NULL)) {
    job->error = "document is closed";
  } else {
    job->error = job->work(job);
  }
  bare_pdfium__unlock();
}

static js_value_t *
bare_pdfium__edit_result(js_env_t *env, bare_pdfium_edit_job_t *job) {
  int err;
  js_value_t *result;

  if (job->result == BARE_PDFIUM_RESULT_BUFFER) {
    void *data;
    err = js_create_arraybuffer(env, job->len, &data, &result);
    assert(err == 0);
    memcpy(data, job->data, job->len);
  } else if (job->result == BARE_PDFIUM_RESULT_WIDGETS) {
    result = bare_pdfium__widgets_result(env, job->widgets, job->widget_count);
  } else {
    err = js_get_undefined(env, &result);
    assert(err == 0);
  }

  return result;
}

static void
bare_pdfium__free_edit(bare_pdfium_edit_job_t *job) {
  free(job->pages);
  free(job->text);
  free(job->font);
  free(job->data);
  bare_pdfium__free_entries(job->entries, job->entry_count);
  bare_pdfium__free_widgets(job->widgets, job->widget_count);
  free(job);
}

static void
bare_pdfium__edit_work(uv_work_t *req) {
  bare_pdfium__run_edit((bare_pdfium_edit_job_t *) req->data);
}

static void
bare_pdfium__edit_done(uv_work_t *req, int status) {
  int err;
  bare_pdfium_edit_job_t *job = (bare_pdfium_edit_job_t *) req->data;
  js_env_t *env = job->env;

  js_handle_scope_t *scope;
  err = js_open_handle_scope(env, &scope);
  assert(err == 0);

  if (job->error) {
    js_value_t *message;
    err = js_create_string_utf8(env, (const utf8_t *) job->error, -1, &message);
    assert(err == 0);
    js_value_t *error;
    err = js_create_error(env, NULL, message, &error);
    assert(err == 0);
    err = js_reject_deferred(env, job->deferred, error);
    assert(err == 0);
  } else {
    err = js_resolve_deferred(env, job->deferred, bare_pdfium__edit_result(env, job));
    assert(err == 0);
  }

  err = js_delete_reference(env, job->ref);
  assert(err == 0);
  if (job->source_ref) {
    err = js_delete_reference(env, job->source_ref);
    assert(err == 0);
  }

  bare_pdfium__free_edit(job);

  err = js_close_handle_scope(env, scope);
  assert(err == 0);
}

static js_value_t *
bare_pdfium__edit(js_env_t *env, js_callback_info_t *info, bare_pdfium_edit_setup_fn setup, bool async) {
  int err;

  size_t argc = 8;
  js_value_t *argv[8];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_edit_job_t *job = calloc(1, sizeof(bare_pdfium_edit_job_t));
  job->req.data = job;
  job->env = env;
  job->handle = bare_pdfium__handle(env, argv[0]);

  setup(env, argv, job);

  if (!async) {
    bare_pdfium__run_edit(job);
    js_value_t *result = NULL;
    if (job->error) {
      bare_pdfium__throw(env, job->error);
    } else {
      result = bare_pdfium__edit_result(env, job);
    }
    bare_pdfium__free_edit(job);
    return result;
  }

  err = js_create_reference(env, argv[0], 1, &job->ref);
  assert(err == 0);
  if (job->source_value) {
    err = js_create_reference(env, job->source_value, 1, &job->source_ref);
    assert(err == 0);
  }

  js_value_t *promise;
  err = js_create_promise(env, &job->deferred, &promise);
  assert(err == 0);

  uv_loop_t *loop;
  err = js_get_env_loop(env, &loop);
  assert(err == 0);

  err = uv_queue_work(loop, &job->req, bare_pdfium__edit_work, bare_pdfium__edit_done);
  assert(err == 0);

  return promise;
}

#define BARE_PDFIUM_EDIT(name, setup) \
  static js_value_t *bare_pdfium_##name(js_env_t *env, js_callback_info_t *info) { \
    return bare_pdfium__edit(env, info, setup, false); \
  } \
  static js_value_t *bare_pdfium_##name##_async(js_env_t *env, js_callback_info_t *info) { \
    return bare_pdfium__edit(env, info, setup, true); \
  }

BARE_PDFIUM_EDIT(import_pages, bare_pdfium__import_setup)
BARE_PDFIUM_EDIT(rotate, bare_pdfium__rotate_setup)
BARE_PDFIUM_EDIT(watermark, bare_pdfium__watermark_setup)
BARE_PDFIUM_EDIT(save, bare_pdfium__save_setup)
BARE_PDFIUM_EDIT(form_widgets, bare_pdfium__widgets_setup)
BARE_PDFIUM_EDIT(fill_form, bare_pdfium__fill_setup)

#undef BARE_PDFIUM_EDIT

static js_value_t *
bare_pdfium_exports(js_env_t *env, js_value_t *exports) {
  int err;

#define V(name, fn) \
  { \
    js_value_t *val; \
    err = js_create_function(env, name, -1, fn, NULL, &val); \
    assert(err == 0); \
    err = js_set_named_property(env, exports, name, val); \
    assert(err == 0); \
  }

  V("open", bare_pdfium_open)
  V("openFile", bare_pdfium_open_file)
  V("close", bare_pdfium_close)
  V("pageCount", bare_pdfium_page_count)
  V("pageSize", bare_pdfium_page_size)
  V("pageFlags", bare_pdfium_page_flags)
  V("render", bare_pdfium_render)
  V("extractImages", bare_pdfium_extract_images)
  V("extractText", bare_pdfium_extract_text)
  V("extractTextAsync", bare_pdfium_extract_text_async)
  V("renderAsync", bare_pdfium_render_async)
  V("create", bare_pdfium_create)
  V("importPages", bare_pdfium_import_pages)
  V("save", bare_pdfium_save)
  V("rotate", bare_pdfium_rotate)
  V("watermark", bare_pdfium_watermark)
  V("formWidgets", bare_pdfium_form_widgets)
  V("fillForm", bare_pdfium_fill_form)
  V("importPagesAsync", bare_pdfium_import_pages_async)
  V("rotateAsync", bare_pdfium_rotate_async)
  V("watermarkAsync", bare_pdfium_watermark_async)
  V("saveAsync", bare_pdfium_save_async)
  V("formWidgetsAsync", bare_pdfium_form_widgets_async)
  V("fillFormAsync", bare_pdfium_fill_form_async)
#undef V

  return exports;
}

BARE_MODULE(bare_pdfium, bare_pdfium_exports)
