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

function pageList(count, pages) {
  if (pages === undefined) return Int32Array.from({ length: count }, (_, i) => i)
  if (!Array.isArray(pages)) throw new TypeError('pages must be an array of page indexes')
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 0 || page >= count) {
      throw new RangeError(`page ${page} is out of range; the document has ${count} pages`)
    }
  }
  return Int32Array.from(pages)
}

function quarterTurns(degrees) {
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) {
    throw new TypeError(`degrees must be a multiple of 90, got ${degrees}`)
  }
  return (degrees / 90) % 4
}

function packColor(color, opacity) {
  if (!Array.isArray(color) || color.length !== 3) {
    throw new TypeError('color must be [r, g, b] with each channel 0-255')
  }
  if (typeof opacity !== 'number' || opacity < 0 || opacity > 1) {
    throw new TypeError(`opacity must be between 0 and 1, got ${opacity}`)
  }
  const channels = [...color, Math.round(opacity * 255)].map((channel) => {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new TypeError('color must be [r, g, b] with each channel 0-255')
    }
    return channel
  })
  return ((channels[0] << 24) | (channels[1] << 16) | (channels[2] << 8) | channels[3]) >>> 0
}

function groupFields(widgets) {
  const fields = new Map()
  for (const widget of widgets) {
    let field = fields.get(widget.name)
    if (!field) {
      field = { widgets: [], ...widget }
      fields.set(widget.name, field)
    }
    field.widgets.push(widget)
  }

  return [...fields.values()].map((field) => {
    const { type } = field
    const result = {
      name: field.name,
      type,
      value: null,
      page: field.page,
      readOnly: field.readOnly,
      required: field.required
    }

    if (type === 'text') {
      result.value = field.value
    } else if (type === 'checkbox') {
      result.value = field.widgets.some((widget) => widget.checked)
      const exports = [...new Set(field.widgets.map((widget) => widget.exportValue))]
      if (exports.length > 1) result.options = exports
    } else if (type === 'radio') {
      const checked = field.widgets.find((widget) => widget.checked)
      result.value = checked ? checked.exportValue : null
      result.options = [...new Set(field.widgets.map((widget) => widget.exportValue))]
    } else if (type === 'combobox') {
      result.value = field.value || null
      result.options = field.options
      result.editable = field.editable
    } else if (type === 'listbox') {
      const selected = field.options.filter((_, i) => field.selected[i])
      result.multiSelect = field.multiSelect
      result.value = result.multiSelect ? selected : (selected[0] ?? null)
      result.options = field.options
    }

    return result
  })
}

function queue(args, call) {
  return serialize(() => call(...args()))
}

function prepareFill(list, values) {
  const fields = new Map(list.map((field) => [field.name, field]))
  const names = Object.keys(values)
  if (names.length === 0) throw new TypeError('pass at least one field to fill')

  const filled = names.map((name) => {
    const field = fields.get(name)
    if (!field) {
      const known = [...fields.keys()]
      throw new Error(
        known.length
          ? `no field named '${name}'; the form has ${JSON.stringify(known)}`
          : 'the document has no form fields'
      )
    }
    return fillValue(field, values[name])
  })

  return { names, filled }
}

function checkFill(list, names, filled, values) {
  const after = new Map(list.map((field) => [field.name, field]))
  for (const [i, name] of names.entries()) {
    if (!sameValue(after.get(name), filled[i])) {
      throw new Error(`field '${name}' did not take the value ${JSON.stringify(values[name])}`)
    }
  }
  return names.map((name) => after.get(name))
}

function sameValue(field, value) {
  if (field.type === 'listbox' && field.multiSelect) {
    return field.value.length === value.length && value.every((item) => field.value.includes(item))
  }
  if (Array.isArray(value)) return field.value === value[0]
  if (field.type === 'checkbox' && typeof value === 'string') {
    return field.value === (value !== 'Off')
  }
  return field.value === value
}

function fillValue(field, value) {
  const { name, type } = field

  if (field.readOnly) throw new Error(`field '${name}' is read-only`)

  if (type === 'text') {
    if (typeof value === 'number') value = String(value)
    if (typeof value !== 'string') throw new TypeError(`field '${name}' is text; pass a string`)
    return value
  }

  if (type === 'checkbox') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string' && (value === 'Off' || (field.options || []).includes(value))) {
      return value
    }
    throw new TypeError(`field '${name}' is a checkbox; pass true or false`)
  }

  if (type === 'radio') {
    if (!field.options.includes(value)) {
      throw new TypeError(
        `field '${name}' is a radio group; pass one of ${JSON.stringify(field.options)}`
      )
    }
    return value
  }

  if (type === 'combobox') {
    if (typeof value !== 'string')
      throw new TypeError(`field '${name}' is a dropdown; pass a string`)
    if (field.options.includes(value)) return [value]
    if (field.editable) return value
    throw new TypeError(`field '${name}' accepts one of ${JSON.stringify(field.options)}`)
  }

  if (type === 'listbox') {
    const items = Array.isArray(value) ? value : [value]
    if (!field.multiSelect && items.length > 1) {
      throw new TypeError(`field '${name}' takes a single selection`)
    }
    for (const item of items) {
      if (!field.options.includes(item)) {
        throw new TypeError(`field '${name}' accepts ${JSON.stringify(field.options)}`)
      }
    }
    return items
  }

  throw new Error(`field '${name}' is a ${type} and cannot be filled`)
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

  _open() {
    if (!this._handle) throw new Error('document is closed')
    return this._handle
  }

  _importArgs(source, opts) {
    const handle = this._open()
    const from = source._open()
    const { pages, at = -1 } = opts
    if (!Number.isInteger(at) || at < -1 || at > this.pageCount()) {
      throw new RangeError(`at must be a page index from 0 to ${this.pageCount()}, got ${at}`)
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
      throw new TypeError('watermark text must be a non-empty string')
    }
    if (position !== 'over' && position !== 'under') {
      throw new TypeError(`position must be 'over' or 'under', got '${position}'`)
    }
    if (font === null && /[^\x20-\xff]/.test(text)) {
      throw new TypeError('text outside Latin-1 needs a TrueType font passed as opts.font')
    }
    return [
      handle,
      pageList(this.pageCount(), pages),
      text,
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

  _saveArgs(opts) {
    const { removeSecurity = false } = opts
    return [this._open(), removeSecurity === true]
  }

  save(opts = {}) {
    return Buffer.from(binding.save(...this._saveArgs(opts)))
  }

  saveAsync(opts = {}) {
    return queue(() => this._saveArgs(opts), binding.saveAsync).then((data) => Buffer.from(data))
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

exports.create = function create() {
  return new Doc(binding.create())
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

function edit(pdf, opts, fn) {
  const doc = exports.open(pdf, opts)
  try {
    return fn(doc)
  } finally {
    doc.close()
  }
}

exports.merge = function merge(pdfs) {
  if (!Array.isArray(pdfs) || pdfs.length === 0) throw new TypeError('merge takes an array of PDFs')
  const merged = exports.create()
  try {
    for (const pdf of pdfs) edit(pdf, {}, (doc) => merged.importPages(doc))
    return merged.save()
  } finally {
    merged.close()
  }
}

exports.extractPages = function extractPages(pdf, pages, opts = {}) {
  return edit(pdf, opts, (doc) => {
    const part = exports.create()
    try {
      part.importPages(doc, { pages })
      return part.save()
    } finally {
      part.close()
    }
  })
}

exports.rotate = function rotate(pdf, degrees, opts = {}) {
  return edit(pdf, opts, (doc) => {
    doc.rotate(degrees, opts)
    return doc.save()
  })
}

exports.decrypt = function decrypt(pdf, password) {
  return edit(pdf, { password }, (doc) => doc.save({ removeSecurity: true }))
}

exports.watermark = function watermark(pdf, text, opts = {}) {
  return edit(pdf, opts, (doc) => {
    doc.watermark(text, opts)
    return doc.save()
  })
}

exports.fields = function fields(pdf, opts = {}) {
  return edit(pdf, opts, (doc) => doc.fields())
}

exports.fillFields = function fillFields(pdf, values, opts = {}) {
  return edit(pdf, opts, (doc) => {
    doc.fillFields(values)
    return doc.save()
  })
}

async function editAsync(pdf, opts, fn) {
  const doc = exports.open(pdf, opts)
  try {
    return await fn(doc)
  } finally {
    doc.close()
  }
}

exports.mergeAsync = async function mergeAsync(pdfs) {
  if (!Array.isArray(pdfs) || pdfs.length === 0) throw new TypeError('merge takes an array of PDFs')
  const merged = exports.create()
  try {
    for (const pdf of pdfs) await editAsync(pdf, {}, (doc) => merged.importPagesAsync(doc))
    return await merged.saveAsync()
  } finally {
    merged.close()
  }
}

exports.extractPagesAsync = async function extractPagesAsync(pdf, pages, opts = {}) {
  return editAsync(pdf, opts, async (doc) => {
    const part = exports.create()
    try {
      await part.importPagesAsync(doc, { pages })
      return await part.saveAsync()
    } finally {
      part.close()
    }
  })
}

exports.rotateAsync = async function rotateAsync(pdf, degrees, opts = {}) {
  return editAsync(pdf, opts, async (doc) => {
    await doc.rotateAsync(degrees, opts)
    return doc.saveAsync()
  })
}

exports.decryptAsync = async function decryptAsync(pdf, password) {
  return editAsync(pdf, { password }, (doc) => doc.saveAsync({ removeSecurity: true }))
}

exports.watermarkAsync = async function watermarkAsync(pdf, text, opts = {}) {
  return editAsync(pdf, opts, async (doc) => {
    await doc.watermarkAsync(text, opts)
    return doc.saveAsync()
  })
}

exports.fieldsAsync = async function fieldsAsync(pdf, opts = {}) {
  return editAsync(pdf, opts, (doc) => doc.fieldsAsync())
}

exports.fillFieldsAsync = async function fillFieldsAsync(pdf, values, opts = {}) {
  return editAsync(pdf, opts, async (doc) => {
    await doc.fillFieldsAsync(values)
    return doc.saveAsync()
  })
}
