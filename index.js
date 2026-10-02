const binding = require('./binding')
const Doc = require('./lib/doc')
const { invalid } = require('./lib/errors')
const { options, bytes, password, passwordCandidates, describe } = require('./lib/args')

let compose = null

function openWith(load, opts) {
  const candidates = passwordCandidates(password(options(opts).password))
  let last = null
  for (const candidate of candidates) {
    try {
      return new Doc(load(candidate))
    } catch (err) {
      if (err.code !== 'PASSWORD') throw err
      last = err
    }
  }
  throw last
}

exports.open = function open(pdf, opts) {
  const data = bytes(pdf, 'pdf')
  return openWith((candidate) => binding.open(data, candidate), opts)
}

exports.openFile = function openFile(path, opts) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw invalid(`path must be a non-empty string, got ${describe(path)}`)
  }
  return openWith((candidate) => binding.openFile(path, candidate), opts)
}

exports.create = function create() {
  return new Doc(binding.create())
}

exports.Doc = Doc

function pdfList(pdfs) {
  if (!Array.isArray(pdfs) || pdfs.length === 0) throw invalid('merge takes an array of PDFs')
  const list = []
  for (let i = 0; i < pdfs.length; i++) {
    if (!(i in pdfs)) throw invalid(`merge input has a hole at position ${i}`)
    list.push(bytes(pdfs[i], `merge input ${i}`))
  }
  return list
}

exports.pageCount = function pageCount(pdf, opts) {
  return edit(pdf, opts, (doc) => doc.pageCount())
}

exports.render = function render(pdf, page, opts) {
  return edit(pdf, opts, (doc) => doc.render(page, opts))
}

exports.textPages = function* textPages(pdf, opts) {
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
  const list = pdfList(pdfs)
  const merged = exports.create()
  try {
    for (const pdf of list) edit(pdf, {}, (doc) => merged.importPages(doc))
    return merged.save()
  } finally {
    merged.close()
  }
}

exports.extractPages = function extractPages(pdf, pages, opts) {
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

exports.rotate = function rotate(pdf, degrees, opts) {
  return edit(pdf, opts, (doc) => {
    doc.rotate(degrees, opts)
    return doc.save()
  })
}

exports.decrypt = function decrypt(pdf, secret) {
  return edit(pdf, { password: password(secret) }, (doc) => doc.save({ removeSecurity: true }))
}

function encryptOptions(secret, opts) {
  const { ownerPassword, permissions } = options(opts)
  return { encrypt: { password: secret, ownerPassword, permissions } }
}

exports.encrypt = function encrypt(pdf, secret, opts) {
  const saveOptions = encryptOptions(secret, opts)
  return edit(pdf, {}, (doc) => doc.save(saveOptions))
}

function composeInto(content, opts) {
  compose ??= require('./lib/compose')
  const doc = exports.create()
  try {
    compose(doc, content, opts)
    return doc
  } catch (err) {
    doc.close()
    throw err
  }
}

exports.compose = function composePdf(content, opts) {
  const own = options(opts)
  const doc = composeInto(content, own)
  try {
    return doc.save(own.encrypt ? { encrypt: own.encrypt } : {})
  } finally {
    doc.close()
  }
}

exports.watermark = function watermark(pdf, text, opts) {
  return edit(pdf, opts, (doc) => {
    doc.watermark(text, opts)
    return doc.save()
  })
}

exports.fields = function fields(pdf, opts) {
  return edit(pdf, opts, (doc) => doc.fields())
}

exports.fillFields = function fillFields(pdf, values, opts) {
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
  const list = pdfList(pdfs)
  const merged = exports.create()
  try {
    for (const pdf of list) await editAsync(pdf, {}, (doc) => merged.importPagesAsync(doc))
    return await merged.saveAsync()
  } finally {
    merged.close()
  }
}

exports.extractPagesAsync = async function extractPagesAsync(pdf, pages, opts) {
  return await editAsync(pdf, opts, async (doc) => {
    const part = exports.create()
    try {
      await part.importPagesAsync(doc, { pages })
      return await part.saveAsync()
    } finally {
      part.close()
    }
  })
}

exports.rotateAsync = async function rotateAsync(pdf, degrees, opts) {
  return await editAsync(pdf, opts, async (doc) => {
    await doc.rotateAsync(degrees, opts)
    return await doc.saveAsync()
  })
}

exports.decryptAsync = async function decryptAsync(pdf, secret) {
  return await editAsync(pdf, { password: password(secret) }, (doc) =>
    doc.saveAsync({ removeSecurity: true })
  )
}

exports.encryptAsync = async function encryptAsync(pdf, secret, opts) {
  const saveOptions = encryptOptions(secret, opts)
  return await editAsync(pdf, {}, (doc) => doc.saveAsync(saveOptions))
}

exports.composeAsync = async function composeAsync(content, opts) {
  const own = options(opts)
  const doc = composeInto(content, own)
  try {
    return await doc.saveAsync(own.encrypt ? { encrypt: own.encrypt } : {})
  } finally {
    doc.close()
  }
}

exports.watermarkAsync = async function watermarkAsync(pdf, text, opts) {
  return await editAsync(pdf, opts, async (doc) => {
    await doc.watermarkAsync(text, opts)
    return await doc.saveAsync()
  })
}

exports.fieldsAsync = async function fieldsAsync(pdf, opts) {
  return await editAsync(pdf, opts, (doc) => doc.fieldsAsync())
}

exports.fillFieldsAsync = async function fillFieldsAsync(pdf, values, opts) {
  return await editAsync(pdf, opts, async (doc) => {
    await doc.fillFieldsAsync(values)
    return await doc.saveAsync()
  })
}
