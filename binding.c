#include <assert.h>
#include <bare.h>
#include <fpdf_edit.h>
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
  int width;
  int height;
  uint8_t *rgba;
} bare_pdfium_job_t;

static void
bare_pdfium__init_lock(void) {
  int err = uv_mutex_init(&bare_pdfium_lock_mutex);
  assert(err == 0);
}

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

// Copy any PDFium bitmap (BGRA/BGRx/BGR/Gray) into a { width, height, data }
// object whose data is a fresh RGBA arraybuffer. Shared by render and
// extractImages so both speak the same RGBA the image pipeline expects.
static void
bare_pdfium__bitmap_rgba(FPDF_BITMAP bitmap, uint8_t *data) {
  int width = FPDFBitmap_GetWidth(bitmap);
  int height = FPDFBitmap_GetHeight(bitmap);
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
}

static js_value_t *
bare_pdfium__rgba_result(js_env_t *env, int width, int height, const uint8_t *rgba) {
  int err;

  js_value_t *result;
  err = js_create_object(env, &result);
  assert(err == 0);

  bare_pdfium__set_int(env, result, "width", width);
  bare_pdfium__set_int(env, result, "height", height);

  js_value_t *buffer;
  uint8_t *data;
  err = js_create_unsafe_arraybuffer(env, (size_t) width * (size_t) height * 4, (void **) &data, &buffer);
  assert(err == 0);
  memcpy(data, rgba, (size_t) width * (size_t) height * 4);

  err = js_set_named_property(env, result, "data", buffer);
  assert(err == 0);

  return result;
}

// Copy any PDFium bitmap (BGRA/BGRx/BGR/Gray) into a { width, height, data }
// object whose data is a fresh RGBA arraybuffer. Shared by render and
// extractImages so both speak the same RGBA the image pipeline expects.
static js_value_t *
bare_pdfium__bitmap_result(js_env_t *env, FPDF_BITMAP bitmap) {
  int err;

  int width = FPDFBitmap_GetWidth(bitmap);
  int height = FPDFBitmap_GetHeight(bitmap);

  js_value_t *result;
  err = js_create_object(env, &result);
  assert(err == 0);

  bare_pdfium__set_int(env, result, "width", width);
  bare_pdfium__set_int(env, result, "height", height);

  js_value_t *buffer;
  uint8_t *data;
  err = js_create_unsafe_arraybuffer(env, (size_t) width * (size_t) height * 4, (void **) &data, &buffer);
  assert(err == 0);

  bare_pdfium__bitmap_rgba(bitmap, data);

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
bare_pdfium__render_bitmap(FPDF_DOCUMENT doc, int page_index, double scale, FPDF_BITMAP *result) {
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

  *result = bitmap;
  return NULL;
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

  bare_pdfium__lock();

  FPDF_BITMAP bitmap;
  const char *error = bare_pdfium__render_bitmap(handle->doc, (int) page_index, scale, &bitmap);
  if (error) {
    bare_pdfium__unlock();
    err = js_throw_error(env, NULL, error);
    assert(err == 0);
    return NULL;
  }

  js_value_t *result = bare_pdfium__bitmap_result(env, bitmap);

  FPDFBitmap_Destroy(bitmap);

  bare_pdfium__unlock();

  return result;
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

  js_value_t *result;
  err = js_create_array(env, &result);
  assert(err == 0);

  uint32_t count = 0;
  int objects = FPDFPage_CountObjects(page);
  for (int i = 0; i < objects; i++) {
    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, i);
    if (FPDFPageObj_GetType(object) != FPDF_PAGEOBJ_IMAGE) continue;

    FPDF_BITMAP bitmap = FPDFImageObj_GetRenderedBitmap(handle->doc, page, object);
    if (bitmap == NULL) continue;

    if (FPDFBitmap_GetWidth(bitmap) < BARE_PDFIUM_MIN_IMAGE_PX ||
        FPDFBitmap_GetHeight(bitmap) < BARE_PDFIUM_MIN_IMAGE_PX) {
      FPDFBitmap_Destroy(bitmap);
      continue;
    }

    js_value_t *item = bare_pdfium__bitmap_result(env, bitmap);
    FPDFBitmap_Destroy(bitmap);

    err = js_set_element(env, result, count++, item);
    assert(err == 0);
  }

  FPDF_ClosePage(page);

  bare_pdfium__unlock();

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
  free(job->rgba);
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
  if (job->handle->doc == NULL) {
    job->error = "document is closed";
  } else {
    FPDF_BITMAP bitmap;
    job->error = bare_pdfium__render_bitmap(job->handle->doc, job->page_index, job->scale, &bitmap);
    if (job->error == NULL) {
      job->width = FPDFBitmap_GetWidth(bitmap);
      job->height = FPDFBitmap_GetHeight(bitmap);
      job->rgba = malloc((size_t) job->width * (size_t) job->height * 4);
      bare_pdfium__bitmap_rgba(bitmap, job->rgba);
      FPDFBitmap_Destroy(bitmap);
    }
  }
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

  js_value_t *result = job->error ? NULL : bare_pdfium__rgba_result(env, job->width, job->height, job->rgba);
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
#undef V

  return exports;
}

BARE_MODULE(bare_pdfium, bare_pdfium_exports)
