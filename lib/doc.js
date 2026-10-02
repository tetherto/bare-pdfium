const binding = require('../binding')
const { invalid, outOfRange, failure } = require('./errors')
const { serialize, queue, closedError } = require('./queue')
const { STANDARD_FONTS, prepareText } = require('./text')
const { drawItem, packColor } = require('./draw')
const { groupFields, prepareFill, checkFill } = require('./fields')

let encryptPdf = null

function encrypted(data, encrypt) {
  if (encrypt === undefined || encrypt === null) return data
  if (typeof encrypt !== 'object') throw invalid('encrypt must be an object with a password')
  encryptPdf ??= require('./encrypt')
  return encryptPdf(data, encrypt)
}

function textOptions(opts) {
  const { clip = false, hyphens = 'join' } = opts
  if (hyphens !== 'join' && hyphens !== 'keep' && hyphens !== 'raw') {
    throw invalid(`hyphens must be 'join', 'keep' or 'raw', got '${hyphens}'`)
  }
  return { clip: clip === true, hyphens }
}

function applyHyphens(text, hyphens) {
  if (hyphens === 'join') return text.replaceAll('\uFFFE', '')
  if (hyphens === 'keep') return text.replaceAll('\uFFFE', '-')
  return text
}

function pageList(count, pages) {
  if (pages === undefined) return Int32Array.from({ length: count }, (_, i) => i)
  if (!Array.isArray(pages)) throw invalid('pages must be an array of page indexes')
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 0 || page >= count) {
      throw outOfRange(
        `page ${page} is out of range; the document has ${count} pages`,
        'PAGE_RANGE'
      )
    }
  }
  return Int32Array.from(pages)
}

function quarterTurns(degrees) {
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) {
    throw invalid(`degrees must be a multiple of 90, got ${degrees}`)
  }
  return (degrees / 90) % 4
}

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

  _open() {
    if (!this._handle) throw failure('CLOSED', 'document is closed')
    return this._handle
  }

  _importArgs(source, opts) {
    const handle = this._open()
    const from = source._open()
    const { pages, at = -1 } = opts
    if (!Number.isInteger(at) || at < -1 || at > this.pageCount()) {
      throw outOfRange(`at must be a page index from 0 to ${this.pageCount()}, got ${at}`)
    }
    return [handle, from, pageList(source.pageCount(), pages), at]
  }

  importPages(source, opts = {}) {
    binding.importPages(...this._importArgs(source, opts))
  }

  importPagesAsync(source, opts = {}) {
    return queue(() => this._importArgs(source, opts), binding.importPagesAsync)
  }

  _rotateArgs(degrees, opts) {
    const handle = this._open()
    const turns = quarterTurns(degrees)
    return [handle, pageList(this.pageCount(), opts.pages), turns]
  }

  rotate(degrees, opts = {}) {
    binding.rotate(...this._rotateArgs(degrees, opts))
  }

  rotateAsync(degrees, opts = {}) {
    return queue(() => this._rotateArgs(degrees, opts), binding.rotateAsync)
  }

  _watermarkArgs(text, opts) {
    const handle = this._open()
    const {
      pages,
      size = 0,
      angle = 45,
      color = [128, 128, 128],
      opacity = 0.3,
      position = 'over',
      font = null
    } = opts
    if (typeof text !== 'string' || text.length === 0) {
      throw invalid('watermark text must be a non-empty string')
    }
    if (position !== 'over' && position !== 'under') {
      throw invalid(`position must be 'over' or 'under', got '${position}'`)
    }
    const drawable = prepareText(text, font === null).trim()
    if (!drawable) throw invalid('watermark text has nothing that can be drawn')
    return [
      handle,
      pageList(this.pageCount(), pages),
      drawable,
      font,
      size,
      angle,
      packColor(color, opacity),
      position === 'under'
    ]
  }

  watermark(text, opts = {}) {
    binding.watermark(...this._watermarkArgs(text, opts))
  }

  watermarkAsync(text, opts = {}) {
    return queue(() => this._watermarkArgs(text, opts), binding.watermarkAsync)
  }

  fields() {
    return groupFields(binding.formWidgets(this._open()))
  }

  fieldsAsync() {
    return queue(() => [this._open()], binding.formWidgetsAsync).then(groupFields)
  }

  fillFields(values) {
    const handle = this._open()
    const { names, filled } = prepareFill(this.fields(), values)
    binding.fillForm(handle, names, filled)
    return checkFill(this.fields(), names, filled, values)
  }

  fillFieldsAsync(values) {
    return serialize(async () => {
      const handle = this._open()
      const before = groupFields(await binding.formWidgetsAsync(handle))
      const { names, filled } = prepareFill(before, values)
      await binding.fillFormAsync(handle, names, filled)
      const after = groupFields(await binding.formWidgetsAsync(handle))
      return checkFill(after, names, filled, values)
    })
  }

  addPage(opts = {}) {
    const handle = this._open()
    const count = this.pageCount()
    const { width = 595.28, height = 841.89, at = count } = opts
    for (const [name, value] of Object.entries({ width, height })) {
      if (typeof value !== 'number' || value < 1 || value > 14400) {
        throw outOfRange(`${name} must be 1 to 14400 points, got ${value}`)
      }
    }
    if (!Number.isInteger(at) || at < 0 || at > count) {
      throw outOfRange(`at must be a page index from 0 to ${count}, got ${at}`)
    }
    binding.newPage(handle, at, width, height)
    return at
  }

  loadFont(font) {
    const handle = this._open()
    if (typeof font === 'string') {
      if (!STANDARD_FONTS.has(font)) {
        throw invalid(
          `font must be TrueType bytes or a built-in font name: ${[...STANDARD_FONTS].join(', ')}`
        )
      }
    } else if (!ArrayBuffer.isView(font) || font.byteLength === 0) {
      throw invalid('font must be TrueType bytes or a built-in font name')
    }
    return binding.loadFont(handle, font)
  }

  measureText(text, font, size) {
    if (typeof text !== 'string') throw invalid('text must be a string')
    return (binding.measure(this._open(), font, text) * size) / 1000
  }

  fontMetrics(font, size) {
    const { ascent, descent } = binding.fontMetrics(this._open(), font)
    return { ascent: (ascent * size) / 1000, descent: (descent * size) / 1000 }
  }

  _drawArgs(page, items) {
    const handle = this._open()
    const count = this.pageCount()
    if (!Number.isInteger(page) || page < 0 || page >= count) {
      throw outOfRange(
        `page ${page} is out of range; the document has ${count} pages`,
        'PAGE_RANGE'
      )
    }
    if (!Array.isArray(items)) throw invalid('draw takes an array of items')
    return [handle, page, items.map(drawItem)]
  }

  draw(page, items) {
    binding.draw(...this._drawArgs(page, items))
  }

  drawAsync(page, items) {
    return queue(() => this._drawArgs(page, items), binding.drawAsync)
  }

  _saveArgs(opts) {
    const { removeSecurity = false, encrypt = null } = opts
    return [this._open(), removeSecurity === true || encrypt !== null]
  }

  save(opts = {}) {
    return encrypted(Buffer.from(binding.save(...this._saveArgs(opts))), opts.encrypt)
  }

  saveAsync(opts = {}) {
    return queue(() => this._saveArgs(opts), binding.saveAsync).then((data) =>
      encrypted(Buffer.from(data), opts.encrypt)
    )
  }

  close() {
    if (this._handle) {
      binding.close(this._handle)
      this._handle = null
    }
  }
}

// Open a PDF (Buffer/Uint8Array). `password` unlocks an encrypted file.

module.exports = Doc
