const binding = require('./binding')

let pending = Promise.resolve()

function serialize(job) {
  const result = pending.then(job)
  pending = result.catch(() => {})
  return result
}

function textOptions(opts) {
  const { clip = false, hyphens = 'join' } = opts
  if (hyphens !== 'join' && hyphens !== 'keep' && hyphens !== 'raw') {
    throw new TypeError(`hyphens must be 'join', 'keep' or 'raw', got '${hyphens}'`)
  }
  return { clip: clip === true, hyphens }
}

function applyHyphens(text, hyphens) {
  if (hyphens === 'join') return text.replaceAll('\uFFFE', '')
  if (hyphens === 'keep') return text.replaceAll('\uFFFE', '-')
  return text
}

function closedError() {
  return Promise.reject(new Error('document is closed'))
}

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

  renderAsync(page, opts = {}) {
    const { scale = 1 } = opts
    const handle = this._handle
    if (!handle) return closedError()
    return serialize(() => binding.renderAsync(handle, page, scale)).then(
      ({ width, height, data }) => ({ width, height, data: Buffer.from(data) })
    )
  }

  extractText(page, opts = {}) {
    const { clip, hyphens } = textOptions(opts)
    return applyHyphens(binding.extractText(this._handle, page, clip), hyphens)
  }

  extractTextAsync(page, opts = {}) {
    let options
    try {
      options = textOptions(opts)
    } catch (err) {
      return Promise.reject(err)
    }
    const handle = this._handle
    if (!handle) return closedError()
    return serialize(() => binding.extractTextAsync(handle, page, options.clip)).then((text) =>
      applyHyphens(text, options.hyphens)
    )
  }

  *textPages(opts = {}) {
    const count = this.pageCount()
    for (let page = 0; page < count; page++) {
      yield { page, text: this.extractText(page, opts) }
    }
  }

  async *textPagesAsync(opts = {}) {
    const count = this.pageCount()
    for (let page = 0; page < count; page++) {
      yield { page, text: await this.extractTextAsync(page, opts) }
    }
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

exports.openFile = function openFile(path, opts = {}) {
  return new Doc(binding.openFile(path, opts.password ?? ''))
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

exports.textPages = function* textPages(pdf, opts = {}) {
  const doc = exports.open(pdf, opts)
  try {
    yield* doc.textPages(opts)
  } finally {
    doc.close()
  }
}
