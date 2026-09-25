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
bare_pdfium__pages(js_env_t *env, js_value_t *value, size_t *len) {
  int err;
  void *data;
  err = js_get_typedarray_info(env, value, NULL, &data, len, NULL, NULL);
  assert(err == 0);
  return (int *) data;
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

static js_value_t *
bare_pdfium_import_pages(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 4;
  js_value_t *argv[4];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *dest = bare_pdfium__handle(env, argv[0]);
  bare_pdfium_doc_t *src = bare_pdfium__handle(env, argv[1]);

  size_t len;
  int *pages = bare_pdfium__pages(env, argv[2], &len);

  int32_t at;
  err = js_get_value_int32(env, argv[3], &at);
  assert(err == 0);

  bare_pdfium__lock();
  bool ok = FPDF_ImportPagesByIndex(dest->doc, src->doc, pages, (unsigned long) len, at);
  bare_pdfium__unlock();

  if (!ok) bare_pdfium__throw(env, "failed to import pages");

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

static js_value_t *
bare_pdfium_save(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  bool remove_security;
  err = js_get_value_bool(env, argv[1], &remove_security);
  assert(err == 0);

  bare_pdfium_writer_t writer = {0};
  writer.base.version = 1;
  writer.base.WriteBlock = bare_pdfium__write_block;

  bare_pdfium__lock();
  bool ok = FPDF_SaveAsCopy(handle->doc, &writer.base, remove_security ? FPDF_REMOVE_SECURITY : FPDF_NO_INCREMENTAL);
  bare_pdfium__unlock();

  if (!ok) {
    free(writer.data);
    bare_pdfium__throw(env, "failed to save document");
    return NULL;
  }

  js_value_t *result;
  void *data;
  err = js_create_arraybuffer(env, writer.len, &data, &result);
  assert(err == 0);
  memcpy(data, writer.data, writer.len);
  free(writer.data);

  return result;
}

static js_value_t *
bare_pdfium_rotate(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 3;
  js_value_t *argv[3];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  size_t len;
  int *pages = bare_pdfium__pages(env, argv[1], &len);

  int32_t turns;
  err = js_get_value_int32(env, argv[2], &turns);
  assert(err == 0);

  const char *error = NULL;

  bare_pdfium__lock();
  for (size_t i = 0; i < len && error == NULL; i++) {
    FPDF_PAGE page = FPDF_LoadPage(handle->doc, pages[i]);
    if (page == NULL) {
      error = "failed to load page";
      break;
    }
    FPDFPage_SetRotation(page, ((FPDFPage_GetRotation(page) + turns) % 4 + 4) % 4);
    FPDF_ClosePage(page);
  }
  bare_pdfium__unlock();

  if (error) bare_pdfium__throw(env, error);

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

static js_value_t *
bare_pdfium_watermark(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 8;
  js_value_t *argv[8];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  size_t len;
  int *pages = bare_pdfium__pages(env, argv[1], &len);

  utf16_t *text = bare_pdfium__utf16(env, argv[2]);

  bool has_font;
  err = js_is_typedarray(env, argv[3], &has_font);
  assert(err == 0);

  uint8_t *font_data = NULL;
  size_t font_len = 0;
  if (has_font) {
    err = js_get_typedarray_info(env, argv[3], NULL, (void **) &font_data, &font_len, NULL, NULL);
    assert(err == 0);
  }

  double size, angle;
  err = js_get_value_double(env, argv[4], &size);
  assert(err == 0);
  err = js_get_value_double(env, argv[5], &angle);
  assert(err == 0);

  uint32_t color;
  err = js_get_value_uint32(env, argv[6], &color);
  assert(err == 0);

  bool under;
  err = js_get_value_bool(env, argv[7], &under);
  assert(err == 0);

  const char *error = NULL;

  bare_pdfium__lock();

  FPDF_FONT font = NULL;
  if (has_font) {
    font = FPDFText_LoadFont(handle->doc, font_data, (uint32_t) font_len, FPDF_FONT_TRUETYPE, true);
    if (font == NULL) error = "failed to load font";
  }

  for (size_t i = 0; i < len && error == NULL; i++) {
    FPDF_PAGE page = FPDF_LoadPage(handle->doc, pages[i]);
    if (page == NULL) {
      error = "failed to load page";
      break;
    }
    error = bare_pdfium__stamp(handle->doc, page, font, text, size, angle, color, under);
    FPDF_ClosePage(page);
  }

  if (font) FPDFFont_Close(font);

  bare_pdfium__unlock();

  free(text);

  if (error) bare_pdfium__throw(env, error);

  return NULL;
}

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

static void
bare_pdfium__set_string(js_env_t *env, js_value_t *object, const char *name, utf16_t *str) {
  int err = js_set_named_property(env, object, name, bare_pdfium__utf16_value(env, str));
  assert(err == 0);
  free(str);
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
bare_pdfium__widget(js_env_t *env, FPDF_FORMHANDLE form, FPDF_ANNOTATION annot, int page_index) {
  int err;

  js_value_t *widget;
  err = js_create_object(env, &widget);
  assert(err == 0);

  int type = FPDFAnnot_GetFormFieldType(form, annot);

  bare_pdfium__set_int(env, widget, "page", page_index);
  bare_pdfium__set_text(env, widget, "type", bare_pdfium__field_type(type));
  bare_pdfium__set_field_flags(env, widget, FPDFAnnot_GetFormFieldFlags(form, annot));
  bare_pdfium__set_bool(env, widget, "checked", FPDFAnnot_IsChecked(form, annot));
  bare_pdfium__set_string(env, widget, "name", bare_pdfium__annot_text(form, annot, FPDFAnnot_GetFormFieldName));
  bare_pdfium__set_string(env, widget, "value", bare_pdfium__annot_text(form, annot, FPDFAnnot_GetFormFieldValue));
  bare_pdfium__set_string(env, widget, "exportValue", bare_pdfium__annot_text(form, annot, FPDFAnnot_GetFormFieldExportValue));

  js_value_t *options, *selected;
  err = js_create_array(env, &options);
  assert(err == 0);
  err = js_create_array(env, &selected);
  assert(err == 0);

  if (type == FPDF_FORMFIELD_COMBOBOX || type == FPDF_FORMFIELD_LISTBOX) {
    int count = FPDFAnnot_GetOptionCount(form, annot);
    for (int i = 0; i < count; i++) {
      utf16_t *label = bare_pdfium__option_label(form, annot, i);
      err = js_set_element(env, options, (uint32_t) i, bare_pdfium__utf16_value(env, label));
      assert(err == 0);
      free(label);

      js_value_t *flag;
      err = js_get_boolean(env, FPDFAnnot_IsOptionSelected(form, annot, i), &flag);
      assert(err == 0);
      err = js_set_element(env, selected, (uint32_t) i, flag);
      assert(err == 0);
    }
  }

  err = js_set_named_property(env, widget, "options", options);
  assert(err == 0);
  err = js_set_named_property(env, widget, "selected", selected);
  assert(err == 0);

  return widget;
}

typedef struct {
  js_env_t *env;
  FPDF_FORMHANDLE form;
  FPDF_PAGE page;
  FPDF_ANNOTATION annot;
  int page_index;
  js_value_t *output;
  uint32_t count;
  size_t entries;
  utf16_t **names;
  js_value_t **values;
  bool *done;
} bare_pdfium_form_walk_t;

typedef void (*bare_pdfium_widget_fn)(bare_pdfium_form_walk_t *walk);

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
  js_value_t *widget = bare_pdfium__widget(walk->env, walk->form, walk->annot, walk->page_index);
  int err = js_set_element(walk->env, walk->output, walk->count++, widget);
  assert(err == 0);
}

static js_value_t *
bare_pdfium_form_widgets(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  js_value_t *result;
  err = js_create_array(env, &result);
  assert(err == 0);

  bare_pdfium_form_walk_t walk = {.env = env, .output = result};

  bare_pdfium__lock();
  const char *error = FPDF_GetFormType(handle->doc) == FORMTYPE_NONE
    ? NULL
    : bare_pdfium__walk_widgets(handle->doc, &walk, bare_pdfium__collect_widget);
  bare_pdfium__unlock();

  if (error) {
    bare_pdfium__throw(env, error);
    return NULL;
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
bare_pdfium__fill_text(bare_pdfium_form_walk_t *walk, js_value_t *value) {
  if (!FORM_SetFocusedAnnot(walk->form, walk->annot)) return;
  utf16_t *text = bare_pdfium__utf16(walk->env, value);
  FORM_SelectAllText(walk->form, walk->page);
  FORM_ReplaceSelection(walk->form, walk->page, (FPDF_WIDESTRING) text);
  FORM_ForceToKillFocus(walk->form);
  free(text);
}

static void
bare_pdfium__fill_choice(bare_pdfium_form_walk_t *walk, js_value_t *value, bool combo) {
  int err;
  js_env_t *env = walk->env;

  uint32_t wanted_len;
  err = js_get_array_length(env, value, &wanted_len);
  assert(err == 0);

  utf16_t **wanted = malloc((wanted_len ? wanted_len : 1) * sizeof(utf16_t *));
  for (uint32_t i = 0; i < wanted_len; i++) {
    js_value_t *item;
    err = js_get_element(env, value, i, &item);
    assert(err == 0);
    wanted[i] = bare_pdfium__utf16(env, item);
  }

  if (FORM_SetFocusedAnnot(walk->form, walk->annot)) {
    int count = FPDFAnnot_GetOptionCount(walk->form, walk->annot);
    for (int i = 0; i < count; i++) {
      utf16_t *label = bare_pdfium__option_label(walk->form, walk->annot, i);
      bool select = false;
      for (uint32_t k = 0; k < wanted_len && !select; k++) select = bare_pdfium__utf16_equal(label, wanted[k]);
      free(label);
      if (select || !combo) FORM_SetIndexSelected(walk->form, walk->page, i, select);
    }
    FORM_ForceToKillFocus(walk->form);
  }

  for (uint32_t i = 0; i < wanted_len; i++) free(wanted[i]);
  free(wanted);
}

static void
bare_pdfium__fill_widget(bare_pdfium_form_walk_t *walk) {
  int err;
  js_env_t *env = walk->env;

  utf16_t *name = bare_pdfium__annot_text(walk->form, walk->annot, FPDFAnnot_GetFormFieldName);
  size_t entry = walk->entries;
  for (size_t i = 0; i < walk->entries; i++) {
    if (bare_pdfium__utf16_equal(name, walk->names[i])) {
      entry = i;
      break;
    }
  }
  free(name);

  if (entry == walk->entries || walk->done[entry]) return;

  js_value_t *value = walk->values[entry];
  js_value_type_t kind;
  err = js_typeof(env, value, &kind);
  assert(err == 0);

  int type = FPDFAnnot_GetFormFieldType(walk->form, walk->annot);

  if (type == FPDF_FORMFIELD_CHECKBOX || type == FPDF_FORMFIELD_RADIOBUTTON) {
    bool want;
    if (kind == js_boolean) {
      err = js_get_value_bool(env, value, &want);
      assert(err == 0);
    } else {
      utf16_t *wanted = bare_pdfium__utf16(env, value);
      utf16_t *export_value = bare_pdfium__annot_text(walk->form, walk->annot, FPDFAnnot_GetFormFieldExportValue);
      want = bare_pdfium__utf16_equal(wanted, export_value);
      free(wanted);
      free(export_value);
    }
    bool checked = FPDFAnnot_IsChecked(walk->form, walk->annot);
    if (want != checked && (want || type == FPDF_FORMFIELD_CHECKBOX)) bare_pdfium__toggle(walk);
    return;
  }

  if (kind == js_string) {
    bare_pdfium__fill_text(walk, value);
  } else {
    bare_pdfium__fill_choice(walk, value, type == FPDF_FORMFIELD_COMBOBOX);
  }

  walk->done[entry] = true;
}

static js_value_t *
bare_pdfium_fill_form(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 3;
  js_value_t *argv[3];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  uint32_t entries;
  err = js_get_array_length(env, argv[1], &entries);
  assert(err == 0);

  bare_pdfium_form_walk_t walk = {.env = env, .entries = entries};
  walk.names = calloc(entries ? entries : 1, sizeof(utf16_t *));
  walk.values = calloc(entries ? entries : 1, sizeof(js_value_t *));
  walk.done = calloc(entries ? entries : 1, sizeof(bool));

  for (uint32_t i = 0; i < entries; i++) {
    js_value_t *name;
    err = js_get_element(env, argv[1], i, &name);
    assert(err == 0);
    walk.names[i] = bare_pdfium__utf16(env, name);
    err = js_get_element(env, argv[2], i, &walk.values[i]);
    assert(err == 0);
  }

  bare_pdfium__lock();
  const char *error = bare_pdfium__walk_widgets(handle->doc, &walk, bare_pdfium__fill_widget);
  bare_pdfium__unlock();

  for (uint32_t i = 0; i < entries; i++) free(walk.names[i]);
  free(walk.names);
  free(walk.values);
  free(walk.done);

  if (error) bare_pdfium__throw(env, error);

  return NULL;
}

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
#undef V

  return exports;
}

BARE_MODULE(bare_pdfium, bare_pdfium_exports)
