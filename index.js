const binding = require('./binding')
const Doc = require('./lib/doc')
const { prepareText } = require('./lib/text')
const { invalid } = require('./lib/errors')

let compose = null

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
  if (!Array.isArray(pdfs) || pdfs.length === 0) throw invalid('merge takes an array of PDFs')
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

exports.encrypt = function encrypt(pdf, password, opts = {}) {
  const { ownerPassword, permissions } = opts
  return edit(pdf, {}, (doc) => doc.save({ encrypt: { password, ownerPassword, permissions } }))
}

function composeInto(content, opts) {
  compose ??= require('./lib/compose')
  const doc = exports.create()
  try {
    compose(doc, content, opts, prepareText)
    return doc
  } catch (err) {
    doc.close()
    throw err
  }
}

exports.compose = function composePdf(content, opts = {}) {
  const doc = composeInto(content, opts)
  try {
    return doc.save(opts.encrypt ? { encrypt: opts.encrypt } : {})
  } finally {
    doc.close()
  }
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
  if (!Array.isArray(pdfs) || pdfs.length === 0) throw invalid('merge takes an array of PDFs')
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

exports.encryptAsync = async function encryptAsync(pdf, password, opts = {}) {
  const { ownerPassword, permissions } = opts
  return editAsync(pdf, {}, (doc) =>
    doc.saveAsync({ encrypt: { password, ownerPassword, permissions } })
  )
}

exports.composeAsync = async function composeAsync(content, opts = {}) {
  const doc = composeInto(content, opts)
  try {
    return await doc.saveAsync(opts.encrypt ? { encrypt: opts.encrypt } : {})
  } finally {
    doc.close()
  }
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
