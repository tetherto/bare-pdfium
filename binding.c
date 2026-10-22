#include <assert.h>
#include <bare.h>
#include <fpdf_annot.h>
#include <fpdf_doc.h>
#include <fpdf_edit.h>
#include <fpdf_flatten.h>
#include <fpdf_formfill.h>
#include <fpdf_ppo.h>
#include <fpdf_progressive.h>
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

static size_t bare_pdfium_envs = 0;

static size_t bare_pdfium_documents = 0;

static uv_once_t bare_pdfium_lock_once = UV_ONCE_INIT;
static uv_mutex_t bare_pdfium_lock_mutex;

// Rendering a page at an absurd scale would allocate gigabytes; cap each side.
static const int BARE_PDFIUM_MAX_DIM = 20000;

static const int64_t BARE_PDFIUM_MAX_PIXELS = 40000000;

// An image object covering less than this fraction of the page is treated as
// decoration (a logo/rule), not content, when classifying a page.
static const double BARE_PDFIUM_MIN_IMAGE_FRACTION = 0.05;

// An extracted image below this pixel size is a spacer/bullet, not a figure.
static const int BARE_PDFIUM_MIN_IMAGE_PX = 8;

#define BARE_PDFIUM_ERRORS(V) \
  V(CLOSED, "CLOSED", "document is closed") \
  V(PAGE_RANGE, "PAGE_RANGE", "page index out of range") \
  V(PAGE, "PAGE", "failed to load page") \
  V(TEXT_PAGE, "PAGE", "failed to load text page") \
  V(LIMIT, "LIMIT", "rendered dimensions exceed limit") \
  V(ABORTED, "ABORTED", "render was aborted") \
  V(IMAGE_LIMIT, "LIMIT", "an image on the page is over 40 megapixels; render the page instead") \
  V(IMAGES_LIMIT, "LIMIT", "the images on the page exceed 160 megapixels; extract fewer or render the page") \
  V(MEMORY, "MEMORY", "failed to allocate bitmap") \
  V(FILE_OPEN, "FILE", "failed to open file") \
  V(FILE_SIZE, "FILE", "failed to size file") \
  V(CREATE, "EDIT", "failed to create document") \
  V(IMPORT, "IMPORT", "failed to import pages") \
  V(SAVE, "SAVE", "failed to save document") \
  V(CONTENT, "EDIT", "failed to write page content") \
  V(STAMP_CREATE, "EDIT", "failed to create watermark text") \
  V(STAMP_SET, "EDIT", "failed to set watermark text") \
  V(STAMP_MEASURE, "EDIT", "failed to measure watermark text") \
  V(STAMP_BOX, "EDIT", "failed to read page box") \
  V(STAMP_INSERT, "EDIT", "failed to insert watermark") \
  V(FORM, "FORM", "failed to load the form") \
  V(FONT_LOAD, "FONT", "failed to load font") \
  V(FONT_UNKNOWN, "FONT", "unknown font") \
  V(ADD_PAGE, "EDIT", "failed to add page") \
  V(DRAW_TEXT, "EDIT", "failed to create text") \
  V(DRAW_RECT, "EDIT", "failed to create rectangle") \
  V(DRAW_LINE, "EDIT", "failed to create line") \
  V(IMAGE, "IMAGE", "failed to load image") \
  V(MOVE, "EDIT", "failed to move pages") \
  V(FLATTEN, "EDIT", "failed to flatten page") \
  V(SEARCH, "PAGE", "failed to search the page")

#define V(name, code, message) static const char BARE_PDFIUM_E_##name[] = message;
BARE_PDFIUM_ERRORS(V)
#undef V

static const char *
bare_pdfium__error_code(const char *error) {
#define V(name, code, message) \
  if (error == BARE_PDFIUM_E_##name) return code;
  BARE_PDFIUM_ERRORS(V)
#undef V
  return "PDFIUM";
}

static void
bare_pdfium__throw(js_env_t *env, const char *error) {
  int err = js_throw_error(env, bare_pdfium__error_code(error), error);
  assert(err == 0);
}

static js_value_t *
bare_pdfium__error_value(js_env_t *env, const char *error) {
  int err;
  js_value_t *code, *message, *result;
  err = js_create_string_utf8(env, (const utf8_t *) bare_pdfium__error_code(error), -1, &code);
  assert(err == 0);
  err = js_create_string_utf8(env, (const utf8_t *) error, -1, &message);
  assert(err == 0);
  err = js_create_error(env, code, message, &result);
  assert(err == 0);
  return result;
}

// An open document plus its own copy of the source bytes. FPDF_LoadMemDocument
// does not copy the buffer, so the document owns one and frees it on close.
typedef struct {
  FPDF_DOCUMENT doc;
  void *buf;
  FILE *file;
  FPDF_FILEACCESS access;
  FPDF_FONT *fonts;
  size_t font_count;
  struct bare_pdfium_image_s *images;
  size_t image_count;
  js_env_t *env;
  js_deferred_teardown_t *teardown;
  uint32_t pending;
  bool exiting;
} bare_pdfium_doc_t;

typedef struct bare_pdfium_image_s {
  FPDF_XOBJECT xobject;
  double width;
  double height;
} bare_pdfium_image_t;

static void
bare_pdfium__close_images(bare_pdfium_doc_t *handle) {
  for (size_t i = 0; i < handle->image_count; i++)
    FPDF_CloseXObject(handle->images[i].xobject);
  free(handle->images);
  handle->images = NULL;
  handle->image_count = 0;
}

static void
bare_pdfium__close_fonts(bare_pdfium_doc_t *handle) {
  for (size_t i = 0; i < handle->font_count; i++)
    FPDFFont_Close(handle->fonts[i]);
  free(handle->fonts);
  handle->fonts = NULL;
  handle->font_count = 0;
}

typedef struct {
  int width;
  int height;
  uint8_t *rgba;
} bare_pdfium_raster_t;

typedef struct {
  bool set;
  double x, y, width, height;
} bare_pdfium_region_t;

typedef struct {
  uv_work_t req;
  js_env_t *env;
  js_deferred_t *deferred;
  js_ref_t *ref;
  bare_pdfium_doc_t *handle;
  int page_index;
  bool clip;
  double scale;
  bare_pdfium_region_t region;
  uint8_t *abort;
  js_ref_t *abort_ref;
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
bare_pdfium__maybe_destroy(void) {
  if (!bare_pdfium_initialized || bare_pdfium_envs > 0 || bare_pdfium_documents > 0) return;
  FPDF_DestroyLibrary();
  bare_pdfium_initialized = false;
}

static bool
bare_pdfium__trylock(void) {
  uv_once(&bare_pdfium_lock_once, bare_pdfium__init_lock);
  return uv_mutex_trylock(&bare_pdfium_lock_mutex) == 0;
}

static void
bare_pdfium__release(bare_pdfium_doc_t *handle) {
  bare_pdfium__close_fonts(handle);
  bare_pdfium__close_images(handle);
  if (handle->doc) {
    FPDF_CloseDocument(handle->doc);
    handle->doc = NULL;
    bare_pdfium_documents--;
    bare_pdfium__maybe_destroy();
  }
}

static void
bare_pdfium__release_files(bare_pdfium_doc_t *handle) {
  if (handle->file) {
    fclose(handle->file);
    handle->file = NULL;
  }
  free(handle->buf);
  handle->buf = NULL;
}

static void
bare_pdfium__settle_teardown(bare_pdfium_doc_t *handle) {
  if (handle->teardown == NULL || handle->pending > 0) return;
  if (handle->doc && !handle->exiting) return;

  if (handle->exiting) {
    bare_pdfium__lock();
    bare_pdfium__release(handle);
    bare_pdfium__unlock();
    bare_pdfium__release_files(handle);
  }

  js_deferred_teardown_t *teardown = handle->teardown;
  handle->teardown = NULL;
  int err = js_finish_deferred_teardown_callback(teardown);
  assert(err == 0);
}

static void
bare_pdfium__on_teardown(js_deferred_teardown_t *teardown, void *data) {
  bare_pdfium_doc_t *handle = (bare_pdfium_doc_t *) data;
  handle->exiting = true;
  bare_pdfium__settle_teardown(handle);
}

typedef struct {
  uv_work_t req;
  bare_pdfium_doc_t *handle;
} bare_pdfium_release_t;

static void
bare_pdfium__release_work(uv_work_t *req) {
  bare_pdfium_release_t *release = (bare_pdfium_release_t *) req->data;
  bare_pdfium__lock();
  bare_pdfium__release(release->handle);
  bare_pdfium__unlock();
}

static void
bare_pdfium__release_done(uv_work_t *req, int status) {
  bare_pdfium_release_t *release = (bare_pdfium_release_t *) req->data;
  bare_pdfium__release_files(release->handle);
  free(release->handle);
  free(release);
}

static void
bare_pdfium__on_doc_finalize(js_env_t *env, void *data, void *finalize_hint) {
  int err;
  bare_pdfium_doc_t *handle = (bare_pdfium_doc_t *) data;

  if (handle->teardown) {
    err = js_finish_deferred_teardown_callback(handle->teardown);
    assert(err == 0);
    handle->teardown = NULL;
  }

  if (handle->doc == NULL && handle->font_count == 0 && handle->image_count == 0) {
    bare_pdfium__release_files(handle);
    free(handle);
    return;
  }

  if (bare_pdfium__trylock()) {
    bare_pdfium__release(handle);
    bare_pdfium__unlock();
    bare_pdfium__release_files(handle);
    free(handle);
    return;
  }

  uv_loop_t *loop;
  err = js_get_env_loop(env, &loop);
  assert(err == 0);

  bare_pdfium_release_t *release = malloc(sizeof(bare_pdfium_release_t));
  release->req.data = release;
  release->handle = handle;
  err = uv_queue_work(loop, &release->req, bare_pdfium__release_work, bare_pdfium__release_done);
  assert(err == 0);
}

static js_value_t *
bare_pdfium__wrap_doc(js_env_t *env, bare_pdfium_doc_t *handle) {
  int err;
  handle->env = env;
  err = js_add_deferred_teardown_callback(env, bare_pdfium__on_teardown, handle, &handle->teardown);
  assert(err == 0);
  js_value_t *external;
  err = js_create_external(env, handle, bare_pdfium__on_doc_finalize, NULL, &external);
  assert(err == 0);
  return external;
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
  if (js_get_value_external(env, value, (void **) &handle) != 0) return NULL;
  return handle;
}

static bool
bare_pdfium__usable(js_env_t *env, bare_pdfium_doc_t *handle) {
  if (handle && handle->doc) return true;
  bare_pdfium__throw(env, BARE_PDFIUM_E_CLOSED);
  return false;
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

static FPDF_BOOL
bare_pdfium__need_to_pause(IFSDK_PAUSE *pause) {
  return __atomic_load_n((uint8_t *) pause->user, __ATOMIC_RELAXED) != 0;
}

static const char *
bare_pdfium__render_page(FPDF_DOCUMENT doc, int page_index, double scale, const bare_pdfium_region_t *region, uint8_t *abort, bare_pdfium_raster_t *result) {
  if (abort && __atomic_load_n(abort, __ATOMIC_RELAXED)) return BARE_PDFIUM_E_ABORTED;

  FPDF_PAGE page = FPDF_LoadPage(doc, page_index);
  if (page == NULL) return BARE_PDFIUM_E_PAGE;

  // PDF user-space units are points (1/72"); scale maps them to device pixels.
  double page_width = FPDF_GetPageWidth(page);
  double page_height = FPDF_GetPageHeight(page);
  double full_width = fmax(1, round(page_width * scale));
  double full_height = fmax(1, round(page_height * scale));
  double width = full_width, height = full_height, start_x = 0, start_y = 0;
  if (region && region->set) {
    width = fmax(1, round(region->width * scale));
    height = fmax(1, round(region->height * scale));
    start_x = -round(region->x * scale);
    start_y = -round((page_height - region->y - region->height) * scale);
  }

  if (width > BARE_PDFIUM_MAX_DIM || height > BARE_PDFIUM_MAX_DIM || width * height > BARE_PDFIUM_MAX_PIXELS || full_width > INT32_MAX / 2 || full_height > INT32_MAX / 2 || fabs(start_x) > INT32_MAX / 2 || fabs(start_y) > INT32_MAX / 2) {
    FPDF_ClosePage(page);
    return BARE_PDFIUM_E_LIMIT;
  }

  int stride = (int) width * 4;
  uint8_t *rgba = malloc((size_t) stride * (size_t) height);
  FPDF_BITMAP bitmap = rgba ? FPDFBitmap_CreateEx((int) width, (int) height, FPDFBitmap_BGRA, rgba, stride) : NULL;
  if (bitmap == NULL) {
    free(rgba);
    FPDF_ClosePage(page);
    return BARE_PDFIUM_E_MEMORY;
  }

  // Paint white first: a page with no background renders onto transparency,
  // and a vision model reads a transparent PNG as a black rectangle.
  FPDFBitmap_FillRect(bitmap, 0, 0, (int) width, (int) height, 0xffffffff);
  int flags = FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER;
  bool aborted = false;
  if (abort) {
    IFSDK_PAUSE pause = {.version = 1, .NeedToPauseNow = bare_pdfium__need_to_pause, .user = abort};
    int status = FPDF_RenderPageBitmap_Start(bitmap, page, (int) start_x, (int) start_y, (int) full_width, (int) full_height, 0, flags, &pause);
    while (status == FPDF_RENDER_TOBECONTINUED && !(aborted = __atomic_load_n(abort, __ATOMIC_RELAXED))) {
      status = FPDF_RenderPage_Continue(page, &pause);
    }
    FPDF_RenderPage_Close(page);
  } else {
    FPDF_RenderPageBitmap(bitmap, page, (int) start_x, (int) start_y, (int) full_width, (int) full_height, 0, flags);
  }

  FPDF_ClosePage(page);
  FPDFBitmap_Destroy(bitmap);

  if (aborted) {
    free(rgba);
    return BARE_PDFIUM_E_ABORTED;
  }

  result->width = (int) width;
  result->height = (int) height;
  result->rgba = rgba;
  return NULL;
}

static bare_pdfium_region_t
bare_pdfium__region(js_env_t *env, js_value_t *value) {
  bare_pdfium_region_t region = {0};
  js_value_type_t type;
  int err = js_typeof(env, value, &type);
  assert(err == 0);
  if (type != js_object) return region;
  const char *names[4] = {"x", "y", "width", "height"};
  double *fields[4] = {&region.x, &region.y, &region.width, &region.height};
  for (int i = 0; i < 4; i++) {
    js_value_t *field;
    err = js_get_named_property(env, value, names[i], &field);
    assert(err == 0);
    err = js_get_value_double(env, field, fields[i]);
    assert(err == 0);
  }
  region.set = true;
  return region;
}

static const char *
bare_pdfium__page_text(FPDF_DOCUMENT doc, int page_index, bool clip, unsigned short **text, size_t *units) {
  FPDF_PAGE page = FPDF_LoadPage(doc, page_index);
  if (page == NULL) return BARE_PDFIUM_E_PAGE;

  FPDF_TEXTPAGE text_page = FPDFText_LoadPage(page);
  if (text_page == NULL) {
    FPDF_ClosePage(page);
    return BARE_PDFIUM_E_TEXT_PAGE;
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
  if (doc) bare_pdfium_documents++;
  bare_pdfium__unlock();

  if (doc == NULL) {
    free(copy);
    bare_pdfium__throw_load_error(env, code);
    return NULL;
  }

  bare_pdfium_doc_t *handle = calloc(1, sizeof(bare_pdfium_doc_t));
  handle->doc = doc;
  handle->buf = copy;
  handle->file = NULL;

  return bare_pdfium__wrap_doc(env, handle);
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
    bare_pdfium__throw(env, BARE_PDFIUM_E_FILE_OPEN);
    return NULL;
  }

  int64_t size = bare_pdfium__file_size(file);
  if (size < 0) {
    fclose(file);
    bare_pdfium__throw(env, BARE_PDFIUM_E_FILE_SIZE);
    return NULL;
  }

  bare_pdfium_doc_t *handle = calloc(1, sizeof(bare_pdfium_doc_t));
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
  if (handle->doc) bare_pdfium_documents++;
  bare_pdfium__unlock();

  if (handle->doc == NULL) {
    fclose(file);
    free(handle);
    bare_pdfium__throw_load_error(env, code);
    return NULL;
  }

  return bare_pdfium__wrap_doc(env, handle);
}

static js_value_t *
bare_pdfium_close(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);

  bare_pdfium__lock();
  bare_pdfium__release(handle);
  bare_pdfium__unlock();
  bare_pdfium__release_files(handle);
  bare_pdfium__settle_teardown(handle);

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
  if (!bare_pdfium__usable(env, handle)) return NULL;

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
  if (!bare_pdfium__usable(env, handle)) return NULL;

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  FS_SIZEF size;
  bare_pdfium__lock();
  bool found = FPDF_GetPageSizeByIndexF(handle->doc, (int) page_index, &size);
  bare_pdfium__unlock();
  if (!found) {
    bare_pdfium__throw(env, BARE_PDFIUM_E_PAGE);
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

static const int BARE_PDFIUM_MAX_FORM_DEPTH = 32;

typedef struct {
  double a, b, c, d, e, f;
} bare_pdfium_matrix_t;

typedef struct {
  double left, bottom, right, top;
} bare_pdfium_box_t;

typedef bool (*bare_pdfium_visit_fn)(FPDF_PAGEOBJECT object, int type, const bare_pdfium_box_t *box, void *context);

static bare_pdfium_matrix_t
bare_pdfium__concat(const FS_MATRIX *inner, const bare_pdfium_matrix_t *outer) {
  return (bare_pdfium_matrix_t){
    .a = inner->a * outer->a + inner->b * outer->c,
    .b = inner->a * outer->b + inner->b * outer->d,
    .c = inner->c * outer->a + inner->d * outer->c,
    .d = inner->c * outer->b + inner->d * outer->d,
    .e = inner->e * outer->a + inner->f * outer->c + outer->e,
    .f = inner->e * outer->b + inner->f * outer->d + outer->f,
  };
}

static bool
bare_pdfium__object_box(FPDF_PAGEOBJECT object, const bare_pdfium_matrix_t *m, bare_pdfium_box_t *box) {
  float left, bottom, right, top;
  if (!FPDFPageObj_GetBounds(object, &left, &bottom, &right, &top)) return false;
  double xs[4] = {left, right, left, right};
  double ys[4] = {bottom, bottom, top, top};
  for (int i = 0; i < 4; i++) {
    double x = m->a * xs[i] + m->c * ys[i] + m->e;
    double y = m->b * xs[i] + m->d * ys[i] + m->f;
    if (i == 0 || x < box->left) box->left = x;
    if (i == 0 || x > box->right) box->right = x;
    if (i == 0 || y < box->bottom) box->bottom = y;
    if (i == 0 || y > box->top) box->top = y;
  }
  return true;
}

static bool
bare_pdfium__visit_objects(FPDF_PAGE page, FPDF_PAGEOBJECT form, const bare_pdfium_matrix_t *m, int depth, bare_pdfium_visit_fn fn, void *context) {
  int count = form ? FPDFFormObj_CountObjects(form) : FPDFPage_CountObjects(page);
  for (int i = 0; i < count; i++) {
    FPDF_PAGEOBJECT object = form ? FPDFFormObj_GetObject(form, (unsigned long) i) : FPDFPage_GetObject(page, i);
    if (object == NULL) continue;
    int type = FPDFPageObj_GetType(object);
    if (type == FPDF_PAGEOBJ_FORM) {
      FS_MATRIX inner;
      if (depth >= BARE_PDFIUM_MAX_FORM_DEPTH || !FPDFPageObj_GetMatrix(object, &inner)) continue;
      bare_pdfium_matrix_t nested = bare_pdfium__concat(&inner, m);
      if (!bare_pdfium__visit_objects(page, object, &nested, depth + 1, fn, context)) return false;
      continue;
    }
    bare_pdfium_box_t box;
    bool bounded = bare_pdfium__object_box(object, m, &box);
    if (!fn(object, type, bounded ? &box : NULL, context)) return false;
  }
  return true;
}

static void
bare_pdfium__visit_page(FPDF_PAGE page, bare_pdfium_visit_fn fn, void *context) {
  bare_pdfium_matrix_t identity = {1, 0, 0, 1, 0, 0};
  bare_pdfium__visit_objects(page, NULL, &identity, 0, fn, context);
}

typedef struct {
  double page_area;
  bool has_image;
  bool has_text;
} bare_pdfium_flags_t;

static bool
bare_pdfium__flag_object(FPDF_PAGEOBJECT object, int type, const bare_pdfium_box_t *box, void *context) {
  bare_pdfium_flags_t *flags = (bare_pdfium_flags_t *) context;
  if (type == FPDF_PAGEOBJ_TEXT && box && (box->right > box->left || box->top > box->bottom)) {
    flags->has_text = true;
  } else if (type == FPDF_PAGEOBJ_IMAGE && !flags->has_image) {
    double area = box ? (box->right - box->left) * (box->top - box->bottom) : 0;
    if (box == NULL || flags->page_area <= 0 || area >= BARE_PDFIUM_MIN_IMAGE_FRACTION * flags->page_area) {
      flags->has_image = true;
    }
  }
  return !(flags->has_text && flags->has_image);
}

static js_value_t *
bare_pdfium_page_flags(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);
  if (!bare_pdfium__usable(env, handle)) return NULL;

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  bare_pdfium__lock();

  FPDF_PAGE page = FPDF_LoadPage(handle->doc, (int) page_index);
  if (page == NULL) {
    bare_pdfium__unlock();
    bare_pdfium__throw(env, BARE_PDFIUM_E_PAGE);
    return NULL;
  }

  bare_pdfium_flags_t flags = {.page_area = FPDF_GetPageWidth(page) * FPDF_GetPageHeight(page)};
  bare_pdfium__visit_page(page, bare_pdfium__flag_object, &flags);

  FPDF_ClosePage(page);

  bare_pdfium__unlock();

  js_value_t *result;
  err = js_create_object(env, &result);
  assert(err == 0);
  bare_pdfium__set_bool(env, result, "hasImage", flags.has_image);
  bare_pdfium__set_bool(env, result, "hasText", flags.has_text);

  return result;
}

static js_value_t *
bare_pdfium_render(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 4;
  js_value_t *argv[4];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);
  if (!bare_pdfium__usable(env, handle)) return NULL;

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  double scale;
  err = js_get_value_double(env, argv[2], &scale);
  assert(err == 0);

  bare_pdfium_region_t region = bare_pdfium__region(env, argv[3]);

  bare_pdfium_raster_t raster;
  bare_pdfium__lock();
  const char *error = bare_pdfium__render_page(handle->doc, (int) page_index, scale, &region, NULL, &raster);
  bare_pdfium__unlock();

  if (error) {
    bare_pdfium__throw(env, error);
    return NULL;
  }

  return bare_pdfium__raster_result(env, &raster);
}

typedef struct {
  FPDF_PAGEOBJECT *objects;
  bare_pdfium_box_t *boxes;
  size_t count;
  size_t capacity;
  bool failed;
} bare_pdfium_found_t;

static bool
bare_pdfium__collect_image(FPDF_PAGEOBJECT object, int type, const bare_pdfium_box_t *box, void *context) {
  bare_pdfium_found_t *found = (bare_pdfium_found_t *) context;
  if (type != FPDF_PAGEOBJ_IMAGE) return true;
  if (found->count == found->capacity) {
    size_t capacity = found->capacity ? found->capacity * 2 : 8;
    FPDF_PAGEOBJECT *objects = realloc(found->objects, capacity * sizeof(FPDF_PAGEOBJECT));
    if (objects) found->objects = objects;
    bare_pdfium_box_t *boxes = objects ? realloc(found->boxes, capacity * sizeof(bare_pdfium_box_t)) : NULL;
    if (boxes) found->boxes = boxes;
    if (objects == NULL || boxes == NULL) {
      found->failed = true;
      return false;
    }
    found->capacity = capacity;
  }
  found->objects[found->count] = object;
  found->boxes[found->count] = box ? *box : (bare_pdfium_box_t){0, 0, 0, 0};
  found->count++;
  return true;
}

static js_value_t *
bare_pdfium__box_value(js_env_t *env, const bare_pdfium_box_t *box) {
  int err;
  js_value_t *result;
  err = js_create_object(env, &result);
  assert(err == 0);
  double values[4] = {box->left, box->bottom, box->right - box->left, box->top - box->bottom};
  for (int i = 0; i < 4; i++)
    values[i] = round(values[i] * 1000) / 1000;
  const char *names[4] = {"x", "y", "width", "height"};
  for (int i = 0; i < 4; i++) {
    js_value_t *value;
    err = js_create_double(env, values[i], &value);
    assert(err == 0);
    err = js_set_named_property(env, result, names[i], value);
    assert(err == 0);
  }
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
  if (!bare_pdfium__usable(env, handle)) return NULL;

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  bare_pdfium__lock();

  FPDF_PAGE page = FPDF_LoadPage(handle->doc, (int) page_index);
  if (page == NULL) {
    bare_pdfium__unlock();
    bare_pdfium__throw(env, BARE_PDFIUM_E_PAGE);
    return NULL;
  }

  bare_pdfium_found_t found = {0};
  bare_pdfium__visit_page(page, bare_pdfium__collect_image, &found);
  bare_pdfium_raster_t *images = found.count > 0 ? malloc(sizeof(bare_pdfium_raster_t) * found.count) : NULL;
  bare_pdfium_box_t *boxes = found.count > 0 ? malloc(sizeof(bare_pdfium_box_t) * found.count) : NULL;
  const char *error = found.failed || (found.count > 0 && (images == NULL || boxes == NULL)) ? BARE_PDFIUM_E_MEMORY : NULL;
  uint32_t count = 0;
  int64_t total = 0;
  for (size_t i = 0; error == NULL && i < found.count; i++) {
    FPDF_PAGEOBJECT object = found.objects[i];

    unsigned int source_width = 0, source_height = 0;
    if (!FPDFImageObj_GetImagePixelSize(object, &source_width, &source_height)) continue;
    int64_t source_pixels = (int64_t) source_width * source_height;
    if (source_pixels > BARE_PDFIUM_MAX_PIXELS) {
      error = BARE_PDFIUM_E_IMAGE_LIMIT;
      break;
    }

    FPDF_BITMAP bitmap = FPDFImageObj_GetRenderedBitmap(handle->doc, page, object);
    if (bitmap == NULL) continue;

    int64_t pixels = (int64_t) FPDFBitmap_GetWidth(bitmap) * FPDFBitmap_GetHeight(bitmap);
    total += pixels;
    if (pixels > BARE_PDFIUM_MAX_PIXELS || total > BARE_PDFIUM_MAX_PIXELS * 4) {
      FPDFBitmap_Destroy(bitmap);
      error = pixels > BARE_PDFIUM_MAX_PIXELS ? BARE_PDFIUM_E_IMAGE_LIMIT : BARE_PDFIUM_E_IMAGES_LIMIT;
      break;
    }

    if (FPDFBitmap_GetWidth(bitmap) < BARE_PDFIUM_MIN_IMAGE_PX || FPDFBitmap_GetHeight(bitmap) < BARE_PDFIUM_MIN_IMAGE_PX) {
      FPDFBitmap_Destroy(bitmap);
      continue;
    }

    if (bare_pdfium__raster(bitmap, &images[count])) {
      boxes[count] = found.boxes[i];
      count++;
    } else {
      error = BARE_PDFIUM_E_MEMORY;
    }
    FPDFBitmap_Destroy(bitmap);
  }

  free(found.objects);
  free(found.boxes);
  FPDF_ClosePage(page);

  bare_pdfium__unlock();

  if (error) {
    for (uint32_t i = 0; i < count; i++)
      free(images[i].rgba);
    free(images);
    free(boxes);
    bare_pdfium__throw(env, error);
    return NULL;
  }

  js_value_t *result;
  err = js_create_array(env, &result);
  assert(err == 0);

  for (uint32_t i = 0; i < count; i++) {
    js_value_t *item = bare_pdfium__raster_result(env, &images[i]);
    js_value_t *bounds = bare_pdfium__box_value(env, &boxes[i]);
    err = js_set_named_property(env, item, "bounds", bounds);
    assert(err == 0);

    err = js_set_element(env, result, i, item);
    assert(err == 0);
  }

  free(images);
  free(boxes);

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
  if (!bare_pdfium__usable(env, handle)) return NULL;

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
    bare_pdfium__throw(env, error);
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
  job->handle->pending++;

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

  bare_pdfium_doc_t *handle = job->handle;

  if (!handle->exiting) {
    err = job->error
            ? js_reject_deferred(env, job->deferred, bare_pdfium__error_value(env, job->error))
            : js_resolve_deferred(env, job->deferred, resolution);
    assert(err == 0);
  }

  err = js_delete_reference(env, job->ref);
  assert(err == 0);

  if (job->abort_ref) {
    err = js_delete_reference(env, job->abort_ref);
    assert(err == 0);
  }

  handle->pending--;
  bare_pdfium__settle_teardown(handle);

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
                 : BARE_PDFIUM_E_CLOSED;
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

  js_value_t *result = job->error || job->handle->exiting ? NULL : bare_pdfium__text_result(env, job->text, job->units);
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

  if (bare_pdfium__handle(env, argv[0]) == NULL) {
    bare_pdfium__throw(env, BARE_PDFIUM_E_CLOSED);
    return NULL;
  }

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
                 ? bare_pdfium__render_page(job->handle->doc, job->page_index, job->scale, &job->region, job->abort, &job->raster)
                 : BARE_PDFIUM_E_CLOSED;
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

  js_value_t *result = job->error || job->handle->exiting ? NULL : bare_pdfium__raster_result(env, &job->raster);
  bare_pdfium__settle_job(job, result);

  err = js_close_handle_scope(env, scope);
  assert(err == 0);
}

static js_value_t *
bare_pdfium_render_async(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 5;
  js_value_t *argv[5];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  int64_t page_index;
  err = js_get_value_int64(env, argv[1], &page_index);
  assert(err == 0);

  if (bare_pdfium__handle(env, argv[0]) == NULL) {
    bare_pdfium__throw(env, BARE_PDFIUM_E_CLOSED);
    return NULL;
  }

  bare_pdfium_job_t *job;
  js_value_t *promise = bare_pdfium__queue_job(env, argv[0], page_index, &job);

  err = js_get_value_double(env, argv[2], &job->scale);
  assert(err == 0);

  job->region = bare_pdfium__region(env, argv[3]);

  bool has_abort = false;
  err = js_is_typedarray(env, argv[4], &has_abort);
  assert(err == 0);
  if (has_abort) {
    void *data;
    err = js_get_typedarray_info(env, argv[4], NULL, &data, NULL, NULL, NULL);
    assert(err == 0);
    job->abort = (uint8_t *) data;
    err = js_create_reference(env, argv[4], 1, &job->abort_ref);
    assert(err == 0);
  }

  uv_loop_t *loop;
  err = js_get_env_loop(env, &loop);
  assert(err == 0);

  err = uv_queue_work(loop, &job->req, bare_pdfium__render_work, bare_pdfium__render_done);
  assert(err == 0);

  return promise;
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
  while (*a && *a == *b)
    a++, b++;
  return *a == *b;
}

static js_value_t *
bare_pdfium__utf16_value(js_env_t *env, const utf16_t *str) {
  size_t len = 0;
  while (str[len])
    len++;
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
  if (doc) bare_pdfium_documents++;
  bare_pdfium__unlock();

  if (doc == NULL) {
    bare_pdfium__throw(env, BARE_PDFIUM_E_CREATE);
    return NULL;
  }

  bare_pdfium_doc_t *handle = calloc(1, sizeof(bare_pdfium_doc_t));
  handle->doc = doc;

  return bare_pdfium__wrap_doc(env, handle);
}

typedef struct {
  unsigned long *slots;
  size_t capacity;
} bare_pdfium_seen_t;

static bool
bare_pdfium__seen_init(bare_pdfium_seen_t *seen, size_t count) {
  seen->capacity = 16;
  while (seen->capacity < count * 2)
    seen->capacity *= 2;
  seen->slots = calloc(seen->capacity, sizeof(unsigned long));
  return seen->slots != NULL;
}

static bool
bare_pdfium__seen_add(bare_pdfium_seen_t *seen, unsigned long number) {
  if (number == 0) return true;
  size_t i = (number * 2654435761u) & (seen->capacity - 1);
  while (seen->slots[i] != 0) {
    if (seen->slots[i] == number) return false;
    i = (i + 1) & (seen->capacity - 1);
  }
  seen->slots[i] = number;
  return true;
}

static const char *
bare_pdfium__rotate_pages(FPDF_DOCUMENT doc, const int *pages, size_t len, int turns) {
  bare_pdfium_seen_t seen;
  if (!bare_pdfium__seen_init(&seen, len)) return BARE_PDFIUM_E_MEMORY;
  const char *error = NULL;
  for (size_t i = 0; i < len && error == NULL; i++) {
    FPDF_PAGE page = FPDF_LoadPage(doc, pages[i]);
    if (page == NULL) {
      error = BARE_PDFIUM_E_PAGE;
      break;
    }
    if (bare_pdfium__seen_add(&seen, FPDFPage_GetObjectNumber(page))) {
      FPDFPage_SetRotation(page, ((FPDFPage_GetRotation(page) + turns) % 4 + 4) % 4);
    }
    FPDF_ClosePage(page);
  }
  free(seen.slots);
  return error;
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
    while (cap < writer->len + size)
      cap *= 2;
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
    return BARE_PDFIUM_E_SAVE;
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
  if (object == NULL) return BARE_PDFIUM_E_STAMP_CREATE;

  if (!FPDFText_SetText(object, (FPDF_WIDESTRING) text)) {
    FPDFPageObj_Destroy(object);
    return BARE_PDFIUM_E_STAMP_SET;
  }

  FPDFPageObj_SetFillColor(object, (color >> 24) & 0xff, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);

  float left, bottom, right, top;
  if (!FPDFPageObj_GetBounds(object, &left, &bottom, &right, &top)) {
    FPDFPageObj_Destroy(object);
    return BARE_PDFIUM_E_STAMP_MEASURE;
  }

  FS_RECTF box;
  if (!FPDF_GetPageBoundingBox(page, &box)) {
    FPDFPageObj_Destroy(object);
    return BARE_PDFIUM_E_STAMP_BOX;
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
    return BARE_PDFIUM_E_STAMP_INSERT;
  }

  return FPDFPage_GenerateContent(page) ? NULL : BARE_PDFIUM_E_CONTENT;
}

static const char *
bare_pdfium__watermark_pages(FPDF_DOCUMENT doc, const int *pages, size_t len, const utf16_t *text, const uint8_t *font_data, size_t font_len, double size, double angle, uint32_t color, bool under) {
  FPDF_FONT font = NULL;
  if (font_data) {
    font = FPDFText_LoadFont(doc, font_data, (uint32_t) font_len, FPDF_FONT_TRUETYPE, true);
    if (font == NULL) return BARE_PDFIUM_E_FONT_LOAD;
  }

  bare_pdfium_seen_t seen;
  if (!bare_pdfium__seen_init(&seen, len)) {
    if (font) FPDFFont_Close(font);
    return BARE_PDFIUM_E_MEMORY;
  }

  const char *error = NULL;
  for (size_t i = 0; i < len && error == NULL; i++) {
    FPDF_PAGE page = FPDF_LoadPage(doc, pages[i]);
    if (page == NULL) {
      error = BARE_PDFIUM_E_PAGE;
      break;
    }
    if (bare_pdfium__seen_add(&seen, FPDFPage_GetObjectNumber(page))) {
      error = bare_pdfium__stamp(doc, page, font, text, size, angle, color, under);
    }
    FPDF_ClosePage(page);
  }

  free(seen.slots);
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
  struct {
    double left, bottom, right, top;
  } rect;
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
  if (walk->form == NULL) return BARE_PDFIUM_E_FORM;

  const char *error = NULL;
  int count = FPDF_GetPageCount(doc);

  for (int i = 0; i < count && error == NULL; i++) {
    FPDF_PAGE page = FPDF_LoadPage(doc, i);
    if (page == NULL) {
      error = BARE_PDFIUM_E_PAGE;
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
  FS_RECTF rect;
  if (FPDFAnnot_GetRect(annot, &rect)) {
    widget->rect.left = fmin(rect.left, rect.right);
    widget->rect.right = fmax(rect.left, rect.right);
    widget->rect.bottom = fmin(rect.bottom, rect.top);
    widget->rect.top = fmax(rect.bottom, rect.top);
  } else {
    widget->rect.left = widget->rect.right = widget->rect.bottom = widget->rect.top = 0;
  }

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
    for (int j = 0; j < widgets[i].option_count; j++)
      free(widgets[i].options[j]);
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
    bare_pdfium_box_t rect = {widget->rect.left, widget->rect.bottom, widget->rect.right, widget->rect.top};
    err = js_set_named_property(env, item, "rect", bare_pdfium__box_value(env, &rect));
    assert(err == 0);
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
    for (uint32_t k = 0; k < entries[i].item_count; k++)
      free(entries[i].items[k]);
    free(entries[i].items);
  }
  free(entries);
}

typedef enum {
  BARE_PDFIUM_DRAW_TEXT,
  BARE_PDFIUM_DRAW_RECT,
  BARE_PDFIUM_DRAW_LINE,
  BARE_PDFIUM_DRAW_IMAGE
} bare_pdfium_draw_kind_t;

typedef struct {
  bare_pdfium_draw_kind_t kind;
  int32_t font;
  double size;
  double x;
  double y;
  double x2;
  double y2;
  double width;
  double height;
  double line_width;
  uint32_t fill;
  uint32_t stroke;
  utf16_t *text;
  int32_t image;
} bare_pdfium_draw_item_t;

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
  bare_pdfium_draw_item_t *items;
  size_t item_count;
};

typedef void (*bare_pdfium_edit_setup_fn)(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job);

static const char *
bare_pdfium__import_work(bare_pdfium_edit_job_t *job) {
  int at = job->number < 0 ? FPDF_GetPageCount(job->handle->doc) : job->number;
  if (job->handle == job->source) {
    FPDF_DOCUMENT scratch = FPDF_CreateNewDocument();
    if (scratch == NULL) return BARE_PDFIUM_E_IMPORT;
    bool copied = FPDF_ImportPagesByIndex(scratch, job->source->doc, job->pages, (unsigned long) job->pages_len, 0);
    bool ok = copied && FPDF_ImportPagesByIndex(job->handle->doc, scratch, NULL, 0, at);
    FPDF_CloseDocument(scratch);
    return ok ? NULL : BARE_PDFIUM_E_IMPORT;
  }
  bool ok = FPDF_ImportPagesByIndex(job->handle->doc, job->source->doc, job->pages, (unsigned long) job->pages_len, at);
  return ok ? NULL : BARE_PDFIUM_E_IMPORT;
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
    job->error = BARE_PDFIUM_E_CLOSED;
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
  for (size_t i = 0; i < job->item_count; i++)
    free(job->items[i].text);
  free(job->items);
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

  bare_pdfium_doc_t *handle = job->handle;
  bare_pdfium_doc_t *source = job->source_ref ? job->source : NULL;

  if (!handle->exiting && !(source && source->exiting)) {
    err = job->error
            ? js_reject_deferred(env, job->deferred, bare_pdfium__error_value(env, job->error))
            : js_resolve_deferred(env, job->deferred, bare_pdfium__edit_result(env, job));
    assert(err == 0);
  }

  err = js_delete_reference(env, job->ref);
  assert(err == 0);
  if (job->source_ref) {
    err = js_delete_reference(env, job->source_ref);
    assert(err == 0);
  }

  bare_pdfium__free_edit(job);

  handle->pending--;
  bare_pdfium__settle_teardown(handle);
  if (source) {
    source->pending--;
    bare_pdfium__settle_teardown(source);
  }

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

  if (job->handle == NULL) {
    free(job);
    bare_pdfium__throw(env, BARE_PDFIUM_E_CLOSED);
    return NULL;
  }

  setup(env, argv, job);

  if (job->source_value && job->source == NULL) {
    bare_pdfium__free_edit(job);
    bare_pdfium__throw(env, BARE_PDFIUM_E_CLOSED);
    return NULL;
  }

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
  job->handle->pending++;
  if (job->source_value) {
    err = js_create_reference(env, job->source_value, 1, &job->source_ref);
    assert(err == 0);
    job->source->pending++;
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

static double
bare_pdfium__number(js_env_t *env, js_value_t *object, const char *name) {
  int err;
  js_value_t *value;
  err = js_get_named_property(env, object, name, &value);
  assert(err == 0);
  js_value_type_t type;
  err = js_typeof(env, value, &type);
  assert(err == 0);
  if (type != js_number) return 0;
  double result;
  err = js_get_value_double(env, value, &result);
  assert(err == 0);
  return result;
}

static js_value_t *
bare_pdfium__property(js_env_t *env, js_value_t *object, const char *name) {
  js_value_t *value;
  int err = js_get_named_property(env, object, name, &value);
  assert(err == 0);
  return value;
}

static uint8_t *
bare_pdfium__copy_bytes(js_env_t *env, js_value_t *value, size_t *len) {
  bool is_typedarray = false;
  *len = 0;
  if (js_is_typedarray(env, value, &is_typedarray) != 0 || !is_typedarray) return NULL;
  void *data;
  js_typedarray_type_t type;
  size_t count;
  if (js_get_typedarray_info(env, value, &type, &data, &count, NULL, NULL) != 0 || type != js_uint8array) return NULL;
  *len = count;
  uint8_t *copy = malloc(count ? count : 1);
  if (copy && count) memcpy(copy, data, count);
  return copy;
}

typedef struct {
  const uint8_t *data;
  size_t len;
} bare_pdfium_memory_t;

static int
bare_pdfium__memory_block(void *param, unsigned long position, unsigned char *buf, unsigned long size) {
  bare_pdfium_memory_t *memory = (bare_pdfium_memory_t *) param;
  if (position > memory->len || size > memory->len - position) return 0;
  memcpy(buf, memory->data + position, size);
  return 1;
}

static void
bare_pdfium__set_colors(FPDF_PAGEOBJECT object, uint32_t fill, uint32_t stroke, double line_width) {
  if (fill & 0xff) FPDFPageObj_SetFillColor(object, fill >> 24, (fill >> 16) & 0xff, (fill >> 8) & 0xff, fill & 0xff);
  if (stroke & 0xff) {
    FPDFPageObj_SetStrokeColor(object, stroke >> 24, (stroke >> 16) & 0xff, (stroke >> 8) & 0xff, stroke & 0xff);
    FPDFPageObj_SetStrokeWidth(object, (float) line_width);
  }
}

static FPDF_PAGEOBJECT
bare_pdfium__new_image(FPDF_DOCUMENT doc, FPDF_PAGE page, const uint8_t *data, size_t len, bool jpeg, int pixel_width, int pixel_height) {
  if (data == NULL || len == 0) return NULL;
  if (!jpeg) {
    if (pixel_width <= 0 || pixel_height <= 0) return NULL;
    int64_t pixels = (int64_t) pixel_width * pixel_height;
    if (pixels > BARE_PDFIUM_MAX_PIXELS || (size_t) pixels * 4 > len) return NULL;
  }
  FPDF_PAGEOBJECT object = FPDFPageObj_NewImageObj(doc);
  if (object == NULL) return NULL;

  bool ok;
  if (jpeg) {
    bare_pdfium_memory_t memory = {data, len};
    FPDF_FILEACCESS access = {(unsigned long) len, bare_pdfium__memory_block, &memory};
    ok = FPDFImageObj_LoadJpegFileInline(&page, 1, object, &access);
  } else {
    size_t pixels = (size_t) pixel_width * pixel_height;
    bool opaque = true;
    for (size_t i = 0; i < pixels && opaque; i++)
      opaque = data[i * 4 + 3] == 255;
    FPDF_BITMAP bitmap = FPDFBitmap_Create(pixel_width, pixel_height, opaque ? 0 : 1);
    ok = bitmap != NULL;
    if (ok) {
      uint8_t *buffer = (uint8_t *) FPDFBitmap_GetBuffer(bitmap);
      int stride = FPDFBitmap_GetStride(bitmap);
      for (int y = 0; y < pixel_height; y++) {
        const uint8_t *src = data + (size_t) y * pixel_width * 4;
        uint8_t *dst = buffer + (size_t) y * stride;
        for (int x = 0; x < pixel_width; x++) {
          dst[x * 4 + 0] = src[x * 4 + 2];
          dst[x * 4 + 1] = src[x * 4 + 1];
          dst[x * 4 + 2] = src[x * 4 + 0];
          dst[x * 4 + 3] = src[x * 4 + 3];
        }
      }
      ok = FPDFImageObj_SetBitmap(&page, 1, object, bitmap);
      FPDFBitmap_Destroy(bitmap);
    }
  }

  if (!ok) {
    FPDFPageObj_Destroy(object);
    return NULL;
  }
  return object;
}

static const double BARE_PDFIUM_MAX_IMAGE_POINTS = 14400;

static const char *
bare_pdfium__load_image(bare_pdfium_doc_t *handle, const uint8_t *data, size_t len, bool jpeg, int pixel_width, int pixel_height) {
  if (pixel_width <= 0 || pixel_height <= 0) return BARE_PDFIUM_E_IMAGE;
  double fit = fmin(1, BARE_PDFIUM_MAX_IMAGE_POINTS / fmax(pixel_width, pixel_height));
  double width = pixel_width * fit, height = pixel_height * fit;

  bare_pdfium_image_t *images = realloc(handle->images, (handle->image_count + 1) * sizeof(bare_pdfium_image_t));
  if (images == NULL) return BARE_PDFIUM_E_MEMORY;
  handle->images = images;

  FPDF_DOCUMENT scratch = FPDF_CreateNewDocument();
  if (scratch == NULL) return BARE_PDFIUM_E_MEMORY;
  FPDF_PAGE page = FPDFPage_New(scratch, 0, width, height);
  FPDF_PAGEOBJECT object = page ? bare_pdfium__new_image(scratch, page, data, len, jpeg, pixel_width, pixel_height) : NULL;
  bool ok = object != NULL && FPDFImageObj_SetMatrix(object, width, 0, 0, height, 0, 0);
  if (ok) {
    FPDFPage_InsertObject(page, object);
    ok = FPDFPage_GenerateContent(page);
  } else if (object) {
    FPDFPageObj_Destroy(object);
  }
  FPDF_XOBJECT xobject = ok ? FPDF_NewXObjectFromPage(handle->doc, scratch, 0) : NULL;
  if (page) FPDF_ClosePage(page);
  FPDF_CloseDocument(scratch);
  if (xobject == NULL) return BARE_PDFIUM_E_IMAGE;

  handle->images[handle->image_count++] = (bare_pdfium_image_t){xobject, width, height};
  return NULL;
}

static FPDF_PAGEOBJECT
bare_pdfium__draw_image(bare_pdfium_doc_t *handle, const bare_pdfium_draw_item_t *item) {
  if (item->image < 0 || (size_t) item->image >= handle->image_count) return NULL;
  const bare_pdfium_image_t *image = &handle->images[item->image];
  FPDF_PAGEOBJECT object = FPDF_NewFormObjectFromXObject(image->xobject);
  if (object == NULL) return NULL;
  FPDFPageObj_Transform(object, item->width / image->width, 0, 0, item->height / image->height, item->x, item->y);
  return object;
}

static const char *
bare_pdfium__draw_work(bare_pdfium_edit_job_t *job) {
  bare_pdfium_doc_t *handle = job->handle;
  FPDF_PAGE page = FPDF_LoadPage(handle->doc, job->number);
  if (page == NULL) return BARE_PDFIUM_E_PAGE;

  const char *error = NULL;
  for (size_t i = 0; i < job->item_count && error == NULL; i++) {
    const bare_pdfium_draw_item_t *item = &job->items[i];
    FPDF_PAGEOBJECT object = NULL;

    switch (item->kind) {
    case BARE_PDFIUM_DRAW_TEXT:
      if (item->font < 0 || (size_t) item->font >= handle->font_count) {
        error = BARE_PDFIUM_E_FONT_UNKNOWN;
        break;
      }
      object = FPDFPageObj_CreateTextObj(handle->doc, handle->fonts[item->font], (float) item->size);
      if (object == NULL || !FPDFText_SetText(object, (FPDF_WIDESTRING) item->text)) {
        if (object) FPDFPageObj_Destroy(object);
        object = NULL;
        error = BARE_PDFIUM_E_DRAW_TEXT;
        break;
      }
      bare_pdfium__set_colors(object, item->fill, 0, 0);
      FPDFPageObj_Transform(object, 1, 0, 0, 1, item->x, item->y);
      break;
    case BARE_PDFIUM_DRAW_RECT:
      object = FPDFPageObj_CreateNewRect((float) item->x, (float) item->y, (float) item->width, (float) item->height);
      if (object == NULL) {
        error = BARE_PDFIUM_E_DRAW_RECT;
        break;
      }
      bare_pdfium__set_colors(object, item->fill, item->stroke, item->line_width);
      FPDFPath_SetDrawMode(object, (item->fill & 0xff) ? FPDF_FILLMODE_WINDING : FPDF_FILLMODE_NONE, (item->stroke & 0xff) != 0);
      break;
    case BARE_PDFIUM_DRAW_LINE:
      object = FPDFPageObj_CreateNewPath((float) item->x, (float) item->y);
      if (object == NULL || !FPDFPath_LineTo(object, (float) item->x2, (float) item->y2)) {
        if (object) FPDFPageObj_Destroy(object);
        object = NULL;
        error = BARE_PDFIUM_E_DRAW_LINE;
        break;
      }
      bare_pdfium__set_colors(object, 0, item->stroke, item->line_width);
      FPDFPath_SetDrawMode(object, FPDF_FILLMODE_NONE, true);
      break;
    case BARE_PDFIUM_DRAW_IMAGE:
      object = bare_pdfium__draw_image(handle, item);
      if (object == NULL) error = BARE_PDFIUM_E_IMAGE;
      break;
    }

    if (object) FPDFPage_InsertObject(page, object);
  }

  if (error == NULL && !FPDFPage_GenerateContent(page)) error = BARE_PDFIUM_E_CONTENT;
  FPDF_ClosePage(page);
  return error;
}

static void
bare_pdfium__draw_setup(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job) {
  int err;

  err = js_get_value_int32(env, argv[1], &job->number);
  assert(err == 0);

  uint32_t count;
  err = js_get_array_length(env, argv[2], &count);
  assert(err == 0);

  job->items = calloc(count ? count : 1, sizeof(bare_pdfium_draw_item_t));
  job->item_count = count;

  for (uint32_t i = 0; i < count; i++) {
    js_value_t *value;
    err = js_get_element(env, argv[2], i, &value);
    assert(err == 0);

    bare_pdfium_draw_item_t *item = &job->items[i];
    item->kind = (bare_pdfium_draw_kind_t) bare_pdfium__number(env, value, "kind");
    item->x = bare_pdfium__number(env, value, "x");
    item->y = bare_pdfium__number(env, value, "y");
    item->x2 = bare_pdfium__number(env, value, "x2");
    item->y2 = bare_pdfium__number(env, value, "y2");
    item->width = bare_pdfium__number(env, value, "width");
    item->height = bare_pdfium__number(env, value, "height");
    item->size = bare_pdfium__number(env, value, "size");
    item->line_width = bare_pdfium__number(env, value, "lineWidth");
    item->fill = (uint32_t) bare_pdfium__number(env, value, "fill");
    item->stroke = (uint32_t) bare_pdfium__number(env, value, "stroke");
    item->font = (int32_t) bare_pdfium__number(env, value, "font");

    if (item->kind == BARE_PDFIUM_DRAW_TEXT) {
      item->text = bare_pdfium__utf16(env, bare_pdfium__property(env, value, "text"));
    } else if (item->kind == BARE_PDFIUM_DRAW_IMAGE) {
      item->image = (int32_t) bare_pdfium__number(env, value, "image");
    }
  }

  job->work = bare_pdfium__draw_work;
}

static int
bare_pdfium__descending(const void *a, const void *b) {
  return *(const int *) b - *(const int *) a;
}

static const char *
bare_pdfium__delete_work(bare_pdfium_edit_job_t *job) {
  qsort(job->pages, job->pages_len, sizeof(int), bare_pdfium__descending);
  for (size_t i = 0; i < job->pages_len; i++) {
    if (i > 0 && job->pages[i] == job->pages[i - 1]) continue;
    FPDFPage_Delete(job->handle->doc, job->pages[i]);
  }
  return NULL;
}

static void
bare_pdfium__delete_setup(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job) {
  job->pages = bare_pdfium__copy_pages(env, argv[1], &job->pages_len);
  job->work = bare_pdfium__delete_work;
}

static const char *
bare_pdfium__move_work(bare_pdfium_edit_job_t *job) {
  return FPDF_MovePages(job->handle->doc, job->pages, (unsigned long) job->pages_len, job->number) ? NULL : BARE_PDFIUM_E_MOVE;
}

static void
bare_pdfium__move_setup(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job) {
  job->pages = bare_pdfium__copy_pages(env, argv[1], &job->pages_len);
  int err = js_get_value_int32(env, argv[2], &job->number);
  assert(err == 0);
  job->work = bare_pdfium__move_work;
}

static const char *
bare_pdfium__flatten_work(bare_pdfium_edit_job_t *job) {
  for (size_t i = 0; i < job->pages_len; i++) {
    FPDF_PAGE page = FPDF_LoadPage(job->handle->doc, job->pages[i]);
    if (page == NULL) return BARE_PDFIUM_E_PAGE;
    int result = FPDFPage_Flatten(page, FLAT_NORMALDISPLAY);
    FPDF_ClosePage(page);
    if (result == FLATTEN_FAIL) return BARE_PDFIUM_E_FLATTEN;
  }
  return NULL;
}

static void
bare_pdfium__flatten_setup(js_env_t *env, js_value_t **argv, bare_pdfium_edit_job_t *job) {
  job->pages = bare_pdfium__copy_pages(env, argv[1], &job->pages_len);
  job->work = bare_pdfium__flatten_work;
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
BARE_PDFIUM_EDIT(draw, bare_pdfium__draw_setup)
BARE_PDFIUM_EDIT(delete_pages, bare_pdfium__delete_setup)
BARE_PDFIUM_EDIT(move_pages, bare_pdfium__move_setup)
BARE_PDFIUM_EDIT(flatten, bare_pdfium__flatten_setup)

#undef BARE_PDFIUM_EDIT

static js_value_t *
bare_pdfium_new_page(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 4;
  js_value_t *argv[4];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);
  if (!bare_pdfium__usable(env, handle)) return NULL;

  int32_t index;
  err = js_get_value_int32(env, argv[1], &index);
  assert(err == 0);

  double width, height;
  err = js_get_value_double(env, argv[2], &width);
  assert(err == 0);
  err = js_get_value_double(env, argv[3], &height);
  assert(err == 0);

  bare_pdfium__lock();
  FPDF_PAGE page = FPDFPage_New(handle->doc, index, width, height);
  if (page) FPDF_ClosePage(page);
  bare_pdfium__unlock();

  if (page == NULL) bare_pdfium__throw(env, BARE_PDFIUM_E_ADD_PAGE);

  return NULL;
}

static js_value_t *
bare_pdfium_load_font(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);
  if (!bare_pdfium__usable(env, handle)) return NULL;

  bool is_bytes;
  err = js_is_typedarray(env, argv[1], &is_bytes);
  assert(err == 0);

  uint8_t *data = NULL;
  size_t len = 0;
  char name[64] = {0};
  if (is_bytes) {
    data = bare_pdfium__copy_bytes(env, argv[1], &len);
  } else {
    size_t written;
    err = js_get_value_string_utf8(env, argv[1], (utf8_t *) name, sizeof(name) - 1, &written);
    assert(err == 0);
    name[written] = '\0';
  }

  int32_t index = -1;

  bare_pdfium__lock();
  FPDF_FONT font = is_bytes
                     ? FPDFText_LoadFont(handle->doc, data, (uint32_t) len, FPDF_FONT_TRUETYPE, true)
                     : FPDFText_LoadStandardFont(handle->doc, name);
  if (font) {
    FPDF_FONT *fonts = realloc(handle->fonts, (handle->font_count + 1) * sizeof(FPDF_FONT));
    if (fonts) {
      handle->fonts = fonts;
      handle->fonts[handle->font_count] = font;
      index = (int32_t) handle->font_count++;
    } else {
      FPDFFont_Close(font);
    }
  }
  bare_pdfium__unlock();

  free(data);

  if (index < 0) {
    bare_pdfium__throw(env, BARE_PDFIUM_E_FONT_LOAD);
    return NULL;
  }

  js_value_t *result;
  err = js_create_int32(env, index, &result);
  assert(err == 0);
  return result;
}

static js_value_t *
bare_pdfium_measure(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 3;
  js_value_t *argv[3];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);
  if (!bare_pdfium__usable(env, handle)) return NULL;

  int32_t index;
  err = js_get_value_int32(env, argv[1], &index);
  assert(err == 0);

  utf16_t *text = bare_pdfium__utf16(env, argv[2]);

  double total = 0;
  bool known = true;

  bare_pdfium__lock();
  if (index < 0 || (size_t) index >= handle->font_count) {
    known = false;
  } else {
    FPDF_FONT font = handle->fonts[index];
    for (size_t i = 0; text[i]; i++) {
      uint32_t code = text[i];
      if (code >= 0xd800 && code <= 0xdbff && text[i + 1] >= 0xdc00 && text[i + 1] <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (text[++i] - 0xdc00);
      }
      float width;
      if (FPDFFont_GetGlyphWidth(font, code, 1000, &width)) total += width;
    }
  }
  bare_pdfium__unlock();

  free(text);

  if (!known) {
    bare_pdfium__throw(env, BARE_PDFIUM_E_FONT_UNKNOWN);
    return NULL;
  }

  js_value_t *result;
  err = js_create_double(env, total, &result);
  assert(err == 0);
  return result;
}

static js_value_t *
bare_pdfium_font_metrics(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);
  if (!bare_pdfium__usable(env, handle)) return NULL;

  int32_t index;
  err = js_get_value_int32(env, argv[1], &index);
  assert(err == 0);

  float ascent = 0, descent = 0;
  bool known = true;

  bare_pdfium__lock();
  if (index < 0 || (size_t) index >= handle->font_count) {
    known = false;
  } else {
    FPDFFont_GetAscent(handle->fonts[index], 1000, &ascent);
    FPDFFont_GetDescent(handle->fonts[index], 1000, &descent);
  }
  bare_pdfium__unlock();

  if (!known) {
    bare_pdfium__throw(env, BARE_PDFIUM_E_FONT_UNKNOWN);
    return NULL;
  }

  js_value_t *result;
  err = js_create_object(env, &result);
  assert(err == 0);

  js_value_t *value;
  err = js_create_double(env, ascent, &value);
  assert(err == 0);
  err = js_set_named_property(env, result, "ascent", value);
  assert(err == 0);
  err = js_create_double(env, descent, &value);
  assert(err == 0);
  err = js_set_named_property(env, result, "descent", value);
  assert(err == 0);

  return result;
}

static void
bare_pdfium__on_env_teardown(void *data) {
  bare_pdfium__lock();
  bare_pdfium_envs--;
  bare_pdfium__maybe_destroy();
  bare_pdfium__unlock();
}

typedef struct {
  unsigned short *text;
  size_t units;
} bare_pdfium_string_t;

static bare_pdfium_string_t
bare_pdfium__utf16_bytes(unsigned long bytes, unsigned short *buffer) {
  bare_pdfium_string_t result = {buffer, bytes >= 2 ? bytes / 2 - 1 : 0};
  if (result.units == 0) {
    free(buffer);
    result.text = NULL;
  }
  return result;
}

static js_value_t *
bare_pdfium__string_or_null(js_env_t *env, bare_pdfium_string_t string) {
  js_value_t *result;
  int err = string.text ? js_create_string_utf16le(env, (const utf16_t *) string.text, string.units, &result) : js_get_null(env, &result);
  assert(err == 0);
  return result;
}

static js_value_t *
bare_pdfium__int_or_null(js_env_t *env, int value) {
  js_value_t *result;
  int err = value >= 0 ? js_create_int64(env, value, &result) : js_get_null(env, &result);
  assert(err == 0);
  return result;
}

static bare_pdfium_doc_t *
bare_pdfium__read_args(js_env_t *env, js_callback_info_t *info, size_t expected, js_value_t **argv) {
  size_t argc = expected;
  int err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);
  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);
  return bare_pdfium__usable(env, handle) ? handle : NULL;
}

static js_value_t *
bare_pdfium_metadata(js_env_t *env, js_callback_info_t *info) {
  js_value_t *argv[1];
  bare_pdfium_doc_t *handle = bare_pdfium__read_args(env, info, 1, argv);
  if (handle == NULL) return NULL;

  static const char *tags[] = {"Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"};
  static const char *names[] = {"title", "author", "subject", "keywords", "creator", "producer", "creationDate", "modDate"};
  bare_pdfium_string_t values[8];

  bare_pdfium__lock();
  for (int i = 0; i < 8; i++) {
    unsigned long bytes = FPDF_GetMetaText(handle->doc, tags[i], NULL, 0);
    unsigned short *buffer = bytes > 2 ? malloc(bytes) : NULL;
    if (buffer) FPDF_GetMetaText(handle->doc, tags[i], buffer, bytes);
    values[i] = bare_pdfium__utf16_bytes(buffer ? bytes : 0, buffer);
  }
  bare_pdfium__unlock();

  js_value_t *result;
  int err = js_create_object(env, &result);
  assert(err == 0);
  for (int i = 0; i < 8; i++) {
    err = js_set_named_property(env, result, names[i], bare_pdfium__string_or_null(env, values[i]));
    assert(err == 0);
    free(values[i].text);
  }
  return result;
}

static js_value_t *
bare_pdfium_page_label(js_env_t *env, js_callback_info_t *info) {
  js_value_t *argv[2];
  bare_pdfium_doc_t *handle = bare_pdfium__read_args(env, info, 2, argv);
  if (handle == NULL) return NULL;
  int32_t page_index;
  int err = js_get_value_int32(env, argv[1], &page_index);
  assert(err == 0);

  bare_pdfium__lock();
  unsigned long bytes = FPDF_GetPageLabel(handle->doc, page_index, NULL, 0);
  unsigned short *buffer = bytes > 2 ? malloc(bytes) : NULL;
  if (buffer) FPDF_GetPageLabel(handle->doc, page_index, buffer, bytes);
  bare_pdfium__unlock();

  bare_pdfium_string_t label = bare_pdfium__utf16_bytes(buffer ? bytes : 0, buffer);
  js_value_t *result = bare_pdfium__string_or_null(env, label);
  free(label.text);
  return result;
}

static const size_t BARE_PDFIUM_MAX_OUTLINE = 65536;
static const int BARE_PDFIUM_MAX_OUTLINE_DEPTH = 64;

typedef struct {
  bare_pdfium_string_t title;
  int page;
  long parent;
} bare_pdfium_bookmark_t;

typedef struct {
  bare_pdfium_bookmark_t *items;
  size_t count;
  size_t capacity;
} bare_pdfium_outline_t;

static int
bare_pdfium__dest_page(FPDF_DOCUMENT doc, FPDF_DEST dest, FPDF_ACTION action) {
  if (dest == NULL && action && FPDFAction_GetType(action) == PDFACTION_GOTO) dest = FPDFAction_GetDest(doc, action);
  return dest ? FPDFDest_GetDestPageIndex(doc, dest) : -1;
}

static void
bare_pdfium__walk_outline(FPDF_DOCUMENT doc, FPDF_BOOKMARK parent, long parent_index, int depth, bare_pdfium_outline_t *outline) {
  if (depth >= BARE_PDFIUM_MAX_OUTLINE_DEPTH) return;
  for (FPDF_BOOKMARK bookmark = FPDFBookmark_GetFirstChild(doc, parent); bookmark && outline->count < BARE_PDFIUM_MAX_OUTLINE; bookmark = FPDFBookmark_GetNextSibling(doc, bookmark)) {
    if (outline->count == outline->capacity) {
      size_t capacity = outline->capacity ? outline->capacity * 2 : 32;
      bare_pdfium_bookmark_t *items = realloc(outline->items, capacity * sizeof(bare_pdfium_bookmark_t));
      if (items == NULL) return;
      outline->items = items;
      outline->capacity = capacity;
    }
    unsigned long bytes = FPDFBookmark_GetTitle(bookmark, NULL, 0);
    unsigned short *buffer = bytes > 2 ? malloc(bytes) : NULL;
    if (buffer) FPDFBookmark_GetTitle(bookmark, buffer, bytes);
    long index = (long) outline->count++;
    outline->items[index] = (bare_pdfium_bookmark_t){
      .title = bare_pdfium__utf16_bytes(buffer ? bytes : 0, buffer),
      .page = bare_pdfium__dest_page(doc, FPDFBookmark_GetDest(doc, bookmark), FPDFBookmark_GetAction(bookmark)),
      .parent = parent_index,
    };
    bare_pdfium__walk_outline(doc, bookmark, index, depth + 1, outline);
  }
}

static js_value_t *
bare_pdfium_outline(js_env_t *env, js_callback_info_t *info) {
  js_value_t *argv[1];
  bare_pdfium_doc_t *handle = bare_pdfium__read_args(env, info, 1, argv);
  if (handle == NULL) return NULL;

  bare_pdfium_outline_t outline = {0};
  bare_pdfium__lock();
  bare_pdfium__walk_outline(handle->doc, NULL, -1, 0, &outline);
  bare_pdfium__unlock();

  int err;
  js_value_t *root;
  err = js_create_array(env, &root);
  assert(err == 0);
  js_value_t **children = outline.count ? malloc(outline.count * sizeof(js_value_t *)) : NULL;
  for (size_t i = 0; i < outline.count; i++) {
    bare_pdfium_bookmark_t *item = &outline.items[i];
    js_value_t *node;
    err = js_create_object(env, &node);
    assert(err == 0);
    err = js_set_named_property(env, node, "title", bare_pdfium__text_result(env, item->title.text, item->title.units));
    assert(err == 0);
    err = js_set_named_property(env, node, "page", bare_pdfium__int_or_null(env, item->page));
    assert(err == 0);
    err = js_create_array(env, &children[i]);
    assert(err == 0);
    err = js_set_named_property(env, node, "children", children[i]);
    assert(err == 0);
    js_value_t *list = item->parent < 0 ? root : children[item->parent];
    uint32_t length;
    err = js_get_array_length(env, list, &length);
    assert(err == 0);
    err = js_set_element(env, list, length, node);
    assert(err == 0);
    free(item->title.text);
  }
  free(children);
  free(outline.items);
  return root;
}

typedef struct {
  bare_pdfium_box_t box;
  char *uri;
  int page;
} bare_pdfium_link_t;

static js_value_t *
bare_pdfium_links(js_env_t *env, js_callback_info_t *info) {
  js_value_t *argv[2];
  bare_pdfium_doc_t *handle = bare_pdfium__read_args(env, info, 2, argv);
  if (handle == NULL) return NULL;
  int32_t page_index;
  int err = js_get_value_int32(env, argv[1], &page_index);
  assert(err == 0);

  bare_pdfium__lock();
  FPDF_PAGE page = FPDF_LoadPage(handle->doc, page_index);
  if (page == NULL) {
    bare_pdfium__unlock();
    bare_pdfium__throw(env, BARE_PDFIUM_E_PAGE);
    return NULL;
  }
  bare_pdfium_link_t *links = NULL;
  size_t count = 0, capacity = 0;
  int position = 0;
  FPDF_LINK link;
  while (count < 100000 && FPDFLink_Enumerate(page, &position, &link)) {
    if (count == capacity) {
      capacity = capacity ? capacity * 2 : 16;
      bare_pdfium_link_t *grown = realloc(links, capacity * sizeof(bare_pdfium_link_t));
      if (grown == NULL) break;
      links = grown;
    }
    FS_RECTF rect = {0, 0, 0, 0};
    FPDFLink_GetAnnotRect(link, &rect);
    FPDF_ACTION action = FPDFLink_GetAction(link);
    char *uri = NULL;
    if (action && FPDFAction_GetType(action) == PDFACTION_URI) {
      unsigned long bytes = FPDFAction_GetURIPath(handle->doc, action, NULL, 0);
      uri = bytes > 1 ? malloc(bytes) : NULL;
      if (uri) FPDFAction_GetURIPath(handle->doc, action, uri, bytes);
    }
    links[count++] = (bare_pdfium_link_t){
      .box = {fmin(rect.left, rect.right), fmin(rect.bottom, rect.top), fmax(rect.left, rect.right), fmax(rect.bottom, rect.top)},
      .uri = uri,
      .page = bare_pdfium__dest_page(handle->doc, FPDFLink_GetDest(handle->doc, link), action),
    };
  }
  FPDF_ClosePage(page);
  bare_pdfium__unlock();

  js_value_t *result;
  err = js_create_array(env, &result);
  assert(err == 0);
  for (size_t i = 0; i < count; i++) {
    js_value_t *item = bare_pdfium__box_value(env, &links[i].box);
    js_value_t *uri;
    err = links[i].uri ? js_create_string_utf8(env, (const utf8_t *) links[i].uri, strlen(links[i].uri), &uri) : js_get_null(env, &uri);
    assert(err == 0);
    err = js_set_named_property(env, item, "uri", uri);
    assert(err == 0);
    err = js_set_named_property(env, item, "page", bare_pdfium__int_or_null(env, links[i].page));
    assert(err == 0);
    err = js_set_element(env, result, (uint32_t) i, item);
    assert(err == 0);
    free(links[i].uri);
  }
  free(links);
  return result;
}

typedef struct {
  int index;
  int length;
  size_t first_rect;
  size_t rect_count;
  bare_pdfium_string_t text;
} bare_pdfium_hit_t;

typedef struct {
  bare_pdfium_hit_t *hits;
  size_t hit_count, hit_capacity;
  bare_pdfium_box_t *rects;
  size_t rect_count, rect_capacity;
  bool failed;
} bare_pdfium_hits_t;

static bool
bare_pdfium__add_hit(bare_pdfium_hits_t *hits, FPDF_TEXTPAGE text_page, int index, int length) {
  if (hits->hit_count == hits->hit_capacity) {
    size_t capacity = hits->hit_capacity ? hits->hit_capacity * 2 : 16;
    bare_pdfium_hit_t *grown = realloc(hits->hits, capacity * sizeof(bare_pdfium_hit_t));
    if (grown == NULL) return false;
    hits->hits = grown;
    hits->hit_capacity = capacity;
  }
  int rects = FPDFText_CountRects(text_page, index, length);
  bare_pdfium_hit_t *hit = &hits->hits[hits->hit_count++];
  *hit = (bare_pdfium_hit_t){.index = index, .length = length, .first_rect = hits->rect_count, .rect_count = 0, .text = {NULL, 0}};
  for (int r = 0; r < rects; r++) {
    double left, top, right, bottom;
    if (!FPDFText_GetRect(text_page, r, &left, &top, &right, &bottom)) continue;
    if (hits->rect_count == hits->rect_capacity) {
      size_t capacity = hits->rect_capacity ? hits->rect_capacity * 2 : 32;
      bare_pdfium_box_t *grown = realloc(hits->rects, capacity * sizeof(bare_pdfium_box_t));
      if (grown == NULL) return false;
      hits->rects = grown;
      hits->rect_capacity = capacity;
    }
    hits->rects[hits->rect_count++] = (bare_pdfium_box_t){fmin(left, right), fmin(bottom, top), fmax(left, right), fmax(bottom, top)};
    hit->rect_count++;
  }
  return true;
}

static js_value_t *
bare_pdfium__hits_value(js_env_t *env, bare_pdfium_hits_t *hits, bool spans) {
  int err;
  js_value_t *result;
  err = js_create_array(env, &result);
  assert(err == 0);
  uint32_t out = 0;
  for (size_t i = 0; i < hits->hit_count; i++) {
    bare_pdfium_hit_t *hit = &hits->hits[i];
    if (spans) {
      if (hit->rect_count == 0) continue;
      js_value_t *item = bare_pdfium__box_value(env, &hits->rects[hit->first_rect]);
      err = js_set_named_property(env, item, "text", bare_pdfium__text_result(env, hit->text.text, hit->text.units));
      assert(err == 0);
      err = js_set_element(env, result, out++, item);
      assert(err == 0);
    } else {
      js_value_t *item;
      err = js_create_object(env, &item);
      assert(err == 0);
      bare_pdfium__set_int(env, item, "index", hit->index);
      bare_pdfium__set_int(env, item, "length", hit->length);
      js_value_t *rects;
      err = js_create_array(env, &rects);
      assert(err == 0);
      for (size_t r = 0; r < hit->rect_count; r++) {
        err = js_set_element(env, rects, (uint32_t) r, bare_pdfium__box_value(env, &hits->rects[hit->first_rect + r]));
        assert(err == 0);
      }
      err = js_set_named_property(env, item, "rects", rects);
      assert(err == 0);
      err = js_set_element(env, result, out++, item);
      assert(err == 0);
    }
    free(hit->text.text);
  }
  free(hits->hits);
  free(hits->rects);
  return result;
}

static js_value_t *
bare_pdfium_find_text(js_env_t *env, js_callback_info_t *info) {
  js_value_t *argv[4];
  bare_pdfium_doc_t *handle = bare_pdfium__read_args(env, info, 4, argv);
  if (handle == NULL) return NULL;
  int32_t page_index;
  int err = js_get_value_int32(env, argv[1], &page_index);
  assert(err == 0);
  utf16_t *query = bare_pdfium__utf16(env, argv[2]);
  uint32_t flags;
  err = js_get_value_uint32(env, argv[3], &flags);
  assert(err == 0);

  bare_pdfium_hits_t hits = {0};
  const char *error = NULL;
  bare_pdfium__lock();
  FPDF_PAGE page = FPDF_LoadPage(handle->doc, page_index);
  FPDF_TEXTPAGE text_page = page ? FPDFText_LoadPage(page) : NULL;
  FPDF_SCHHANDLE search = text_page ? FPDFText_FindStart(text_page, (FPDF_WIDESTRING) query, flags, 0) : NULL;
  if (search == NULL) {
    error = page == NULL ? BARE_PDFIUM_E_PAGE : BARE_PDFIUM_E_SEARCH;
  } else {
    while (hits.hit_count < 10000 && FPDFText_FindNext(search)) {
      if (!bare_pdfium__add_hit(&hits, text_page, FPDFText_GetSchResultIndex(search), FPDFText_GetSchCount(search))) {
        error = BARE_PDFIUM_E_MEMORY;
        break;
      }
    }
    FPDFText_FindClose(search);
  }
  if (text_page) FPDFText_ClosePage(text_page);
  if (page) FPDF_ClosePage(page);
  bare_pdfium__unlock();
  free(query);

  if (error) {
    free(hits.hits);
    free(hits.rects);
    bare_pdfium__throw(env, error);
    return NULL;
  }
  return bare_pdfium__hits_value(env, &hits, false);
}

static js_value_t *
bare_pdfium_text_spans(js_env_t *env, js_callback_info_t *info) {
  js_value_t *argv[2];
  bare_pdfium_doc_t *handle = bare_pdfium__read_args(env, info, 2, argv);
  if (handle == NULL) return NULL;
  int32_t page_index;
  int err = js_get_value_int32(env, argv[1], &page_index);
  assert(err == 0);

  bare_pdfium_hits_t hits = {0};
  const char *error = NULL;
  bare_pdfium__lock();
  FPDF_PAGE page = FPDF_LoadPage(handle->doc, page_index);
  FPDF_TEXTPAGE text_page = page ? FPDFText_LoadPage(page) : NULL;
  if (text_page == NULL) {
    error = BARE_PDFIUM_E_PAGE;
  } else {
    int rects = FPDFText_CountRects(text_page, 0, -1);
    for (int r = 0; r < rects && error == NULL; r++) {
      double left, top, right, bottom;
      if (!FPDFText_GetRect(text_page, r, &left, &top, &right, &bottom)) continue;
      int units = FPDFText_GetBoundedText(text_page, left, top, right, bottom, NULL, 0);
      if (hits.hit_count == hits.hit_capacity) {
        size_t capacity = hits.hit_capacity ? hits.hit_capacity * 2 : 64;
        bare_pdfium_hit_t *grown = realloc(hits.hits, capacity * sizeof(bare_pdfium_hit_t));
        bare_pdfium_box_t *boxes = grown ? realloc(hits.rects, capacity * sizeof(bare_pdfium_box_t)) : NULL;
        if (grown) hits.hits = grown;
        if (boxes) hits.rects = boxes;
        if (grown == NULL || boxes == NULL) {
          error = BARE_PDFIUM_E_MEMORY;
          break;
        }
        hits.hit_capacity = hits.rect_capacity = capacity;
      }
      unsigned short *buffer = units > 0 ? malloc((size_t) (units + 1) * sizeof(unsigned short)) : NULL;
      if (buffer) FPDFText_GetBoundedText(text_page, left, top, right, bottom, buffer, units + 1);
      hits.rects[hits.rect_count] = (bare_pdfium_box_t){fmin(left, right), fmin(bottom, top), fmax(left, right), fmax(bottom, top)};
      hits.hits[hits.hit_count++] = (bare_pdfium_hit_t){.first_rect = hits.rect_count++, .rect_count = 1, .text = {buffer, buffer ? (size_t) units : 0}};
    }
  }
  if (text_page) FPDFText_ClosePage(text_page);
  if (page) FPDF_ClosePage(page);
  bare_pdfium__unlock();

  if (error) {
    for (size_t i = 0; i < hits.hit_count; i++)
      free(hits.hits[i].text.text);
    free(hits.hits);
    free(hits.rects);
    bare_pdfium__throw(env, error);
    return NULL;
  }
  return bare_pdfium__hits_value(env, &hits, true);
}

static js_value_t *
bare_pdfium_load_image(js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 5;
  js_value_t *argv[5];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_pdfium_doc_t *handle = bare_pdfium__handle(env, argv[0]);
  if (!bare_pdfium__usable(env, handle)) return NULL;

  void *data;
  size_t len;
  err = js_get_typedarray_info(env, argv[1], NULL, &data, &len, NULL, NULL);
  assert(err == 0);

  bool jpeg;
  err = js_get_value_bool(env, argv[2], &jpeg);
  assert(err == 0);

  int32_t pixel_width, pixel_height;
  err = js_get_value_int32(env, argv[3], &pixel_width);
  assert(err == 0);
  err = js_get_value_int32(env, argv[4], &pixel_height);
  assert(err == 0);

  bare_pdfium__lock();
  const char *error = bare_pdfium__load_image(handle, (const uint8_t *) data, len, jpeg, pixel_width, pixel_height);
  size_t index = handle->image_count - 1;
  bare_pdfium__unlock();

  if (error) {
    bare_pdfium__throw(env, error);
    return NULL;
  }

  js_value_t *result;
  err = js_create_uint32(env, (uint32_t) index, &result);
  assert(err == 0);
  return result;
}

static js_value_t *
bare_pdfium_exports(js_env_t *env, js_value_t *exports) {
  int err;

  bare_pdfium__lock();
  bare_pdfium_envs++;
  bare_pdfium__unlock();

  err = js_add_teardown_callback(env, bare_pdfium__on_env_teardown, NULL);
  assert(err == 0);

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
  V("newPage", bare_pdfium_new_page)
  V("loadFont", bare_pdfium_load_font)
  V("measure", bare_pdfium_measure)
  V("fontMetrics", bare_pdfium_font_metrics)
  V("draw", bare_pdfium_draw)
  V("drawAsync", bare_pdfium_draw_async)
  V("loadImage", bare_pdfium_load_image)
  V("deletePages", bare_pdfium_delete_pages)
  V("deletePagesAsync", bare_pdfium_delete_pages_async)
  V("movePages", bare_pdfium_move_pages)
  V("movePagesAsync", bare_pdfium_move_pages_async)
  V("flatten", bare_pdfium_flatten)
  V("flattenAsync", bare_pdfium_flatten_async)
  V("metadata", bare_pdfium_metadata)
  V("pageLabel", bare_pdfium_page_label)
  V("outline", bare_pdfium_outline)
  V("links", bare_pdfium_links)
  V("findText", bare_pdfium_find_text)
  V("textSpans", bare_pdfium_text_spans)
#undef V

#define V(name, n) \
  { \
    js_value_t *val; \
    err = js_create_uint32(env, n, &val); \
    assert(err == 0); \
    err = js_set_named_property(env, exports, name, val); \
    assert(err == 0); \
  }

  V("DRAW_TEXT", BARE_PDFIUM_DRAW_TEXT)
  V("DRAW_RECT", BARE_PDFIUM_DRAW_RECT)
  V("DRAW_LINE", BARE_PDFIUM_DRAW_LINE)
  V("DRAW_IMAGE", BARE_PDFIUM_DRAW_IMAGE)
  V("MATCH_CASE", FPDF_MATCHCASE)
  V("MATCH_WHOLE_WORD", FPDF_MATCHWHOLEWORD)
#undef V

  return exports;
}

BARE_MODULE(bare_pdfium, bare_pdfium_exports)
