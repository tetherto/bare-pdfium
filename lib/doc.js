const binding = require('../binding')
const { invalid, outOfRange, failure } = require('./errors')
const { serialize, queue } = require('./queue')
const { STANDARD_FONTS, prepareText } = require('./text')
const { drawItem, packColor } = require('./draw')
const { groupFields, prepareFill, checkFill, needsTrial, restoreValues } = require('./fields')
const { describe, options, bytes, finite, integer, pageIndex } = require('./args')
const coverage = require('./ttf')

let encryptPdf = null

function encrypted(data, encrypt) {
  if (encrypt === undefined || encrypt === null) return data
  if (typeof encrypt !== 'object' || Array.isArray(encrypt)) {
    throw invalid('encrypt must be an object with a password')
  }
  encryptPdf ??= require('./encrypt')
  return encryptPdf(data, encrypt)
}

function textOptions(opts) {
  const { clip = false, hyphens = 'join' } = options(opts)
  if (hyphens !== 'join' && hyphens !== 'keep' && hyphens !== 'raw') {
    throw invalid(`hyphens must be 'join', 'keep' or 'raw', got ${describe(hyphens)}`)
  }
  return { clip: clip === true, hyphens }
}

function applyHyphens(text, hyphens) {
  if (hyphens === 'join') return text.replaceAll('￾', '')
  if (hyphens === 'keep') return text.replaceAll('￾', '-')
  return text
}

function pageList(count, pages) {
  if (pages === undefined) return Int32Array.from({ length: count }, (_, i) => i)
  if (!Array.isArray(pages)) throw invalid('pages must be an array of page indexes')
  if (pages.length === 0) throw invalid('pages must list at least one page')
  for (let i = 0; i < pages.length; i++) {
    if (!(i in pages)) throw invalid(`pages has a hole at position ${i}`)
    pageIndex(pages[i], count)
  }
  return Int32Array.from(pages)
}

function quarterTurns(degrees) {
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) {
    throw invalid(`degrees must be a multiple of 90, got ${describe(degrees)}`)
  }
  return (degrees / 90) % 4
}

function scaleOf(opts) {
  const { scale = 1 } = options(opts)
  return finite(scale, 'scale', { min: 0.001, max: 100 })
}

function clipOf(clip) {
  if (clip === undefined || clip === null) return null
  const box = options(clip, 'clip')
  const width = finite(box.width, 'clip width', { min: 0 })
  const height = finite(box.height, 'clip height', { min: 0 })
  if (width === 0 || height === 0) throw invalid('clip width and height must be greater than 0')
  return { x: finite(box.x, 'clip x'), y: finite(box.y, 'clip y'), width, height }
}

function signalOf(signal) {
  if (signal === undefined || signal === null) return null
  if (
    typeof signal !== 'object' ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function'
  ) {
    throw invalid(`signal must be an AbortSignal, got ${describe(signal)}`)
  }
  return signal
}

function aborted(signal) {
  const err = failure('ABORTED', 'render was aborted')
  if (signal && signal.reason !== undefined) err.cause = signal.reason
  return err
}

function fontInfo(font) {
  if (typeof font === 'string') return { standard: true, covers: null }
  return { standard: false, covers: coverage(font) }
}

let compose = null

class Doc {
  constructor(handle) {
    this._handle = handle
    this._fonts = []
    this._images = new WeakMap()
  }

  pageCount() {
    return binding.pageCount(this._open())
  }

  // page dimensions in PDF points (1/72"), without rendering
  pageSize(page) {
    const handle = this._open()
    return binding.pageSize(handle, pageIndex(page, binding.pageCount(handle)))
  }

  // { hasImage, hasText } — hasImage ignores decorative images that cover less than
  // a fraction of the page between them; hasText is false for a scanned page with no text layer
  pageFlags(page) {
    const handle = this._open()
    return binding.pageFlags(handle, pageIndex(page, binding.pageCount(handle)))
  }

  _renderArgs(page, opts) {
    const handle = this._open()
    const scale = scaleOf(opts)
    const clip = clipOf(options(opts).clip)
    return [handle, pageIndex(page, binding.pageCount(handle)), scale, clip]
  }

  // Rasterize one page to an RGBA Buffer. `scale` maps points to pixels: 1 is
  // 72 DPI, 2 is 150 DPI.
  render(page, opts) {
    const { width, height, data } = binding.render(...this._renderArgs(page, opts))
    return { width, height, data: Buffer.from(data) }
  }

  // Where each of the page's embedded raster images sits, without decoding any
  imageBounds(page) {
    const handle = this._open()
    return binding.imageBounds(handle, pageIndex(page, binding.pageCount(handle)))
  }

  // The page's embedded raster images, each rendered to an RGBA Buffer — the
  // pictures themselves, not the whole page.
  extractImages(page) {
    const handle = this._open()
    return binding
      .extractImages(handle, pageIndex(page, binding.pageCount(handle)))
      .map((image) => ({
        width: image.width,
        height: image.height,
        data: Buffer.from(image.data),
        bounds: image.bounds
      }))
  }

  renderAsync(page, opts) {
    let signal
    try {
      signal = signalOf(options(opts).signal)
    } catch (err) {
      return Promise.reject(err)
    }
    if (signal && signal.aborted) return Promise.reject(aborted(signal))

    const cell = signal ? new Uint8Array(1) : null
    const onAbort = () => {
      cell[0] = 1
    }
    if (signal) signal.addEventListener('abort', onAbort)
    const settle = () => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
    }

    return queue(() => {
      if (signal && signal.aborted) throw aborted(signal)
      return [...this._renderArgs(page, opts), cell]
    }, binding.renderAsync).then(
      ({ width, height, data }) => {
        settle()
        return { width, height, data: Buffer.from(data) }
      },
      (err) => {
        settle()
        if (err && err.code === 'ABORTED' && signal && signal.reason !== undefined) {
          err.cause = signal.reason
        }
        throw err
      }
    )
  }

  _textArgs(page, opts) {
    const handle = this._open()
    const text = textOptions(opts)
    return { args: [handle, pageIndex(page, binding.pageCount(handle)), text.clip], text }
  }

  extractText(page, opts) {
    const { args, text } = this._textArgs(page, opts)
    return applyHyphens(binding.extractText(...args), text.hyphens)
  }

  extractTextAsync(page, opts) {
    let hyphens
    return queue(() => {
      const prepared = this._textArgs(page, opts)
      hyphens = prepared.text.hyphens
      return prepared.args
    }, binding.extractTextAsync).then((text) => applyHyphens(text, hyphens))
  }

  *textPages(opts) {
    textOptions(opts)
    const count = this.pageCount()
    for (let page = 0; page < count; page++) {
      yield { page, text: this.extractText(page, opts) }
    }
  }

  async *textPagesAsync(opts) {
    textOptions(opts)
    const count = this.pageCount()
    for (let page = 0; page < count; page++) {
      yield { page, text: await this.extractTextAsync(page, opts) }
    }
  }

  _open() {
    if (!this._handle) throw failure('CLOSED', 'document is closed')
    return this._handle
  }

  _textFor(font, text) {
    const info = this._fonts[font]
    if (!info) throw failure('FONT', `font ${describe(font)} is not loaded in this document`)
    return prepareText(text, info.standard, info.covers)
  }

  _importArgs(source, opts) {
    const handle = this._open()
    if (!(source instanceof Doc)) throw invalid('importPages takes a source document')
    const from = source._open()
    const { pages, at = -1 } = options(opts)
    const count = this.pageCount()
    if (!Number.isInteger(at) || at < -1 || at > count) {
      throw outOfRange(`at must be a page index from 0 to ${count}, got ${describe(at)}`)
    }
    return [handle, from, pageList(source.pageCount(), pages), at]
  }

  importPages(source, opts) {
    binding.importPages(...this._importArgs(source, opts))
  }

  importPagesAsync(source, opts) {
    return queue(() => this._importArgs(source, opts), binding.importPagesAsync)
  }

  _rotateArgs(degrees, opts) {
    const handle = this._open()
    const turns = quarterTurns(degrees)
    return [handle, pageList(this.pageCount(), options(opts).pages), turns]
  }

  rotate(degrees, opts) {
    binding.rotate(...this._rotateArgs(degrees, opts))
  }

  rotateAsync(degrees, opts) {
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
    } = options(opts)
    if (typeof text !== 'string' || text.length === 0) {
      throw invalid('watermark text must be a non-empty string')
    }
    if (position !== 'over' && position !== 'under') {
      throw invalid(`position must be 'over' or 'under', got ${describe(position)}`)
    }
    const fontData = font === null || font === undefined ? null : bytes(font, 'font')
    const covers = fontData ? coverage(fontData) : null
    const drawable = prepareText(text, fontData === null, covers).trim()
    if (!drawable) throw invalid('watermark text has nothing that can be drawn')
    return [
      handle,
      pageList(this.pageCount(), pages),
      drawable,
      fontData,
      finite(size, 'size', { min: 0, max: 10000 }),
      finite(angle, 'angle', { min: -36000, max: 36000 }),
      packColor(color, opacity),
      position === 'under'
    ]
  }

  watermark(text, opts) {
    binding.watermark(...this._watermarkArgs(text, opts))
  }

  watermarkAsync(text, opts) {
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
    const before = this.fields()
    const { names, filled } = prepareFill(before, values)
    if (needsTrial(before, names)) {
      const trial = binding.open(new Uint8Array(binding.save(handle, true)), '')
      try {
        binding.fillForm(trial, names, filled)
        checkFill(groupFields(binding.formWidgets(trial)), names, filled, values)
      } finally {
        binding.close(trial)
      }
    }
    binding.fillForm(handle, names, filled)
    try {
      return checkFill(this.fields(), names, filled, values)
    } catch (err) {
      const restore = restoreValues(before, names)
      if (restore.names.length) binding.fillForm(handle, restore.names, restore.values)
      throw err
    }
  }

  fillFieldsAsync(values) {
    return serialize(async () => {
      const handle = this._open()
      const before = groupFields(await binding.formWidgetsAsync(handle))
      const { names, filled } = prepareFill(before, values)
      if (needsTrial(before, names)) {
        const trial = binding.open(new Uint8Array(await binding.saveAsync(handle, true)), '')
        try {
          await binding.fillFormAsync(trial, names, filled)
          checkFill(groupFields(await binding.formWidgetsAsync(trial)), names, filled, values)
        } finally {
          binding.close(trial)
        }
      }
      await binding.fillFormAsync(handle, names, filled)
      const after = groupFields(await binding.formWidgetsAsync(handle))
      try {
        return checkFill(after, names, filled, values)
      } catch (err) {
        const restore = restoreValues(before, names)
        if (restore.names.length) await binding.fillFormAsync(handle, restore.names, restore.values)
        throw err
      }
    })
  }

  _deleteArgs(pages) {
    const handle = this._open()
    if (pages === undefined) throw invalid('deletePages takes an array of page indexes')
    return [handle, pageList(this.pageCount(), pages)]
  }

  deletePages(pages) {
    binding.deletePages(...this._deleteArgs(pages))
  }

  deletePagesAsync(pages) {
    return queue(() => this._deleteArgs(pages), binding.deletePagesAsync)
  }

  _moveArgs(pages, to) {
    const handle = this._open()
    if (pages === undefined) throw invalid('movePages takes an array of page indexes')
    const count = this.pageCount()
    const list = pageList(count, pages)
    if (new Set(list).size !== list.length) throw invalid('movePages lists a page more than once')
    const last = count - list.length
    if (!Number.isInteger(to) || to < 0 || to > last) {
      throw outOfRange(`to must be a page index from 0 to ${last}, got ${describe(to)}`)
    }
    return [handle, list, to]
  }

  movePages(pages, to) {
    binding.movePages(...this._moveArgs(pages, to))
  }

  movePagesAsync(pages, to) {
    return queue(() => this._moveArgs(pages, to), binding.movePagesAsync)
  }

  _flattenArgs(opts) {
    const handle = this._open()
    return [handle, pageList(this.pageCount(), options(opts).pages)]
  }

  flatten(opts) {
    binding.flatten(...this._flattenArgs(opts))
  }

  flattenAsync(opts) {
    return queue(() => this._flattenArgs(opts), binding.flattenAsync)
  }

  metadata() {
    return binding.metadata(this._open())
  }

  outline() {
    return binding.outline(this._open())
  }

  pageLabel(page) {
    const handle = this._open()
    return binding.pageLabel(handle, pageIndex(page, binding.pageCount(handle)))
  }

  pageRotation(page) {
    const handle = this._open()
    return binding.pageRotation(handle, pageIndex(page, binding.pageCount(handle)))
  }

  // The part of the page that is displayed, in the points every position uses
  pageBox(page) {
    const handle = this._open()
    return binding.pageBox(handle, pageIndex(page, binding.pageCount(handle)))
  }

  links(page) {
    const handle = this._open()
    return binding.links(handle, pageIndex(page, binding.pageCount(handle)))
  }

  findText(page, query, opts) {
    const handle = this._open()
    const index = pageIndex(page, binding.pageCount(handle))
    if (typeof query !== 'string' || query.length === 0 || query.includes('\0')) {
      throw invalid('findText takes a non-empty string without NUL characters')
    }
    const { matchCase = false, wholeWord = false } = options(opts)
    const flags =
      (matchCase === true ? binding.MATCH_CASE : 0) |
      (wholeWord === true ? binding.MATCH_WHOLE_WORD : 0)
    return binding.findText(handle, index, query, flags)
  }

  textSpans(page) {
    const handle = this._open()
    return binding.textSpans(handle, pageIndex(page, binding.pageCount(handle)))
  }

  addPage(opts) {
    const handle = this._open()
    const count = this.pageCount()
    const { width = 595.28, height = 841.89, at = count } = options(opts)
    finite(width, 'width', { min: 1, max: 14400 })
    finite(height, 'height', { min: 1, max: 14400 })
    if (!Number.isInteger(at) || at < 0 || at > count) {
      throw outOfRange(`at must be a page index from 0 to ${count}, got ${describe(at)}`)
    }
    binding.newPage(handle, at, width, height)
    return at
  }

  loadFont(font) {
    const handle = this._open()
    let source = font
    if (typeof font === 'string') {
      if (!STANDARD_FONTS.has(font)) {
        throw invalid(
          `font must be TrueType bytes or a built-in font name: ${[...STANDARD_FONTS].join(', ')}`
        )
      }
    } else {
      try {
        source = bytes(font, 'font')
      } catch {
        throw invalid('font must be TrueType bytes or a built-in font name')
      }
      if (source.byteLength === 0) {
        throw invalid('font must be TrueType bytes or a built-in font name')
      }
    }
    const index = binding.loadFont(handle, source)
    this._fonts[index] = fontInfo(source)
    return index
  }

  _font(font) {
    integer(font, 'font')
    if (!this._fonts[font]) throw failure('FONT', `font ${font} is not loaded in this document`)
    return font
  }

  measureText(text, font, size) {
    const handle = this._open()
    if (typeof text !== 'string') throw invalid('text must be a string')
    finite(size, 'size', { min: 0, max: 100000 })
    return (binding.measure(handle, this._font(font), text) * size) / 1000
  }

  fontMetrics(font, size) {
    const handle = this._open()
    finite(size, 'size', { min: 0, max: 100000 })
    const { ascent, descent } = binding.fontMetrics(handle, this._font(font))
    return { ascent: (ascent * size) / 1000, descent: (descent * size) / 1000 }
  }

  _image(value) {
    const handle = this._open()
    const keyed = value !== null && typeof value === 'object'
    if (keyed && this._images.has(value)) return this._images.get(value)
    compose ??= require('./compose')
    const decoded = compose.isDecoded(value) ? value : compose.decodeImage(value)
    let index = this._images.get(decoded)
    if (index === undefined) {
      index = binding.loadImage(
        handle,
        decoded.data,
        decoded.jpeg === 1,
        decoded.pixelWidth,
        decoded.pixelHeight
      )
      this._images.set(decoded, index)
    }
    if (keyed) this._images.set(value, index)
    return index
  }

  _drawArgs(page, items) {
    const handle = this._open()
    pageIndex(page, this.pageCount())
    if (!Array.isArray(items)) throw invalid('draw takes an array of items')
    const images = (value) => this._image(value)
    const prepared = []
    for (let i = 0; i < items.length; i++) prepared.push(drawItem(items[i], this._fonts, images))
    return [handle, page, prepared]
  }

  draw(page, items) {
    binding.draw(...this._drawArgs(page, items))
  }

  drawAsync(page, items) {
    return queue(() => this._drawArgs(page, items), binding.drawAsync)
  }

  _saveArgs(opts) {
    const { removeSecurity = false, encrypt = null } = options(opts)
    return { args: [this._open(), removeSecurity === true || encrypt !== null], encrypt }
  }

  save(opts) {
    const { args, encrypt } = this._saveArgs(opts)
    return encrypted(Buffer.from(binding.save(...args)), encrypt)
  }

  saveAsync(opts) {
    let encrypt = null
    return queue(() => {
      const prepared = this._saveArgs(opts)
      encrypt = prepared.encrypt
      return prepared.args
    }, binding.saveAsync).then((data) => encrypted(Buffer.from(data), encrypt))
  }

  close() {
    if (this._handle) {
      binding.close(this._handle)
      this._handle = null
    }
  }
}

module.exports = Doc
