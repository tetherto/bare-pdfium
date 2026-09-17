const binding = require('./binding')

// An open PDF. Loading parses the whole file once; every page operation reuses
// that, so batch work (classify then render a few pages) goes through here
// rather than the one-shot helpers below. Always close() it.
class Doc {
  constructor(handle) {
    this._handle = handle
  }

  pageCount() {
    return binding.pageCount(this._handle)
  }

  // page dimensions in PDF points (1/72"), without rendering
  pageSize(page) {
    return binding.pageSize(this._handle, page)
  }

  // { hasImage, hasText } — hasImage ignores decorative images below a fraction
  // of the page; hasText is false for a scanned page with no text layer
  pageFlags(page) {
    return binding.pageFlags(this._handle, page)
  }

  // Rasterize one page to an RGBA Buffer. `scale` maps points to pixels: 1 is
  // 72 DPI, 2 is 150 DPI.
  render(page, opts = {}) {
    const { scale = 1 } = opts
    const { width, height, data } = binding.render(this._handle, page, scale)
    return { width, height, data: Buffer.from(data) }
  }

  // The page's embedded raster images, each rendered to an RGBA Buffer — the
  // pictures themselves, not the whole page.
  extractImages(page) {
    return binding.extractImages(this._handle, page).map((image) => ({
      width: image.width,
      height: image.height,
      data: Buffer.from(image.data)
    }))
  }

  extractText(page) {
    return binding.extractText(this._handle, page)
  }

  close() {
    if (this._handle) {
      binding.close(this._handle)
      this._handle = null
    }
  }
}

// Open a PDF (Buffer/Uint8Array). `password` unlocks an encrypted file.
exports.open = function open(pdf, opts = {}) {
  return new Doc(binding.open(pdf, opts.password ?? ''))
}

exports.Doc = Doc

// One-shot helpers for a single operation — they open and close a Doc for you.
exports.pageCount = function pageCount(pdf, opts = {}) {
  const doc = exports.open(pdf, opts)
  try {
    return doc.pageCount()
  } finally {
    doc.close()
  }
}

exports.render = function render(pdf, page, opts = {}) {
  const doc = exports.open(pdf, opts)
  try {
    return doc.render(page, opts)
  } finally {
    doc.close()
  }
}
