#include <assert.h>
#include <bare.h>
#include <fpdf_edit.h>
#include <fpdf_text.h>
#include <fpdfview.h>
#include <js.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <utf.h>

// PDFium is not thread-safe and wants a single process-lifetime init. Bare addon
// calls run on the JS thread, so a lazy guarded init is enough; there is no
// matching destroy — the library lives for the life of the process.
static bool bare_pdfium_initialized = false;

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
} bare_pdfium_doc_t;

static void
bare_pdfium__ensure_init(void) {
  if (bare_pdfium_initialized) return;
  FPDF_InitLibrary();
  bare_pdfium_initialized = true;
}

static void
bare_pdfium__on_doc_finalize(js_env_t *env, void *data, void *finalize_hint) {
  bare_pdfium_doc_t *handle = (bare_pdfium_doc_t *) data;
  if (handle->doc) FPDF_CloseDocument(handle->doc);
  free(handle->buf);
  free(handle);
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
static js_value_t *
bare_pdfium__bitmap_result(js_env_t *env, FPDF_BITMAP bitmap) {
  int err;

  int width = FPDFBitmap_GetWidth(bitmap);
  int height = FPDFBitmap_GetHeight(bitmap);
  int stride = FPDFBitmap_GetStride(bitmap);
  int format = FPDFBitmap_GetFormat(bitmap);
  const uint8_t *pixels = (const uint8_t *) FPDFBitmap_GetBuffer(bitmap);

  js_value_t *result;
  err = js_create_object(env, &result);
  assert(err == 0);

  bare_pdfium__set_int(env, result, "width", width);
  bare_pdfium__set_int(env, result, "height", height);

  size_t out_len = (size_t) width * (size_t) height * 4;

  js_value_t *buffer;
  uint8_t *data;
  err = js_create_unsafe_arraybuffer(env, out_len, (void **) &data, &buffer);
  assert(err == 0);

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

  err = js_set_named_property(env, result, "data", buffer);
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

  bare_pdfium__ensure_init();

  void *copy = malloc(len == 0 ? 1 : len);
  memcpy(copy, pdf, len);

  FPDF_DOCUMENT doc =
    FPDF_LoadMemDocument(copy, (int) len, password_len ? password : NULL);
  if (doc == NULL) {
    free(copy);
    unsigned long code = FPDF_GetLastError();
    const char *message =
      code == FPDF_ERR_PASSWORD ? "password required or incorrect" : "failed to load PDF";
    err = js_throw_error(env, NULL, message);
    assert(err == 0);
    return NULL;
  }

  bare_pdfium_doc_t *handle = malloc(sizeof(bare_pdfium_doc_t));
  handle->doc = doc;
  handle->buf = copy;

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
  if (handle->doc) {
    FPDF_CloseDocument(handle->doc);
    handle->doc = NULL;
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

  js_value_t *result;
  err = js_create_int64(env, FPDF_GetPageCount(handle->doc), &result);
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
  if (!FPDF_GetPageSizeByIndexF(handle->doc, (int) page_index, &size)) {
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

  FPDF_PAGE page = FPDF_LoadPage(handle->doc, (int) page_index);
  if (page == NULL) {
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

  FPDF_PAGE page = FPDF_LoadPage(handle->doc, (int) page_index);
  if (page == NULL) {
    err = js_throw_error(env, NULL, "failed to load page");
    assert(err == 0);
    return NULL;
  }

  // PDF user-space units are points (1/72"); scale maps them to device pixels.
  int width = (int) lround(FPDF_GetPageWidth(page) * scale);
  int height = (int) lround(FPDF_GetPageHeight(page) * scale);
  if (width < 1) width = 1;
  if (height < 1) height = 1;

  if (width > BARE_PDFIUM_MAX_DIM || height > BARE_PDFIUM_MAX_DIM) {
    FPDF_ClosePage(page);
    err = js_throw_error(env, NULL, "rendered dimensions exceed limit");
    assert(err == 0);
    return NULL;
  }

  FPDF_BITMAP bitmap = FPDFBitmap_Create(width, height, 1);
  if (bitmap == NULL) {
    FPDF_ClosePage(page);
    err = js_throw_error(env, NULL, "failed to allocate bitmap");
    assert(err == 0);
    return NULL;
  }

  // Paint white first: a page with no background renders onto transparency,
  // and a vision model reads a transparent PNG as a black rectangle.
  FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
  FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, FPDF_ANNOT);

  js_value_t *result = bare_pdfium__bitmap_result(env, bitmap);

  FPDFBitmap_Destroy(bitmap);
  FPDF_ClosePage(page);

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

  FPDF_PAGE page = FPDF_LoadPage(handle->doc, (int) page_index);
  if (page == NULL) {
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

  return result;
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
  V("close", bare_pdfium_close)
  V("pageCount", bare_pdfium_page_count)
  V("pageSize", bare_pdfium_page_size)
  V("pageFlags", bare_pdfium_page_flags)
  V("render", bare_pdfium_render)
  V("extractImages", bare_pdfium_extract_images)
#undef V

  return exports;
}

BARE_MODULE(bare_pdfium, bare_pdfium_exports)
