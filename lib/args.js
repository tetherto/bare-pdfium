const { invalid, outOfRange } = require('./errors')

const MAX_PASSWORD_BYTES = 127

function describe(value) {
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'string') return `'${value}'`
  try {
    return String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function options(opts, where = 'options') {
  const copy = Object.create(null)
  if (opts === undefined || opts === null) return copy
  if (typeof opts !== 'object' || Array.isArray(opts) || ArrayBuffer.isView(opts)) {
    throw invalid(`${where} must be an object, got ${describe(opts)}`)
  }
  try {
    for (const key of Object.keys(opts)) copy[key] = opts[key]
  } catch (err) {
    throw invalid(`${where} could not be read: ${err && err.message}`)
  }
  return copy
}

function bytes(value, where = 'input') {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw invalid(
    `${where} must be a Uint8Array, Buffer, typed array or ArrayBuffer, got ${describe(value)}`
  )
}

function finite(value, where, { min = -Infinity, max = Infinity, fallback } = {}) {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${where} must be a finite number, got ${describe(value)}`)
  }
  if (value < min || value > max) {
    throw outOfRange(`${where} must be between ${min} and ${max}, got ${value}`)
  }
  return value
}

function integer(value, where) {
  if (!Number.isInteger(value)) throw invalid(`${where} must be an integer, got ${describe(value)}`)
  return value
}

function pageIndex(page, count) {
  if (!Number.isInteger(page)) {
    throw invalid(`page must be an integer page index, got ${describe(page)}`)
  }
  if (page < 0 || page >= count) {
    throw outOfRange(`page ${page} is out of range; the document has ${count} pages`, 'PAGE_RANGE')
  }
  return page
}

const SPACES = /[   -   　]/g
const NOTHING = /[­͏᠆᠋-᠍​-‍⁠︀-️﻿]/g

function saslprep(password) {
  return password.replace(SPACES, ' ').replace(NOTHING, '').normalize('NFKC')
}

function truncate(password) {
  let length = 0
  let out = ''
  for (const ch of password) {
    const size = Buffer.byteLength(ch)
    if (length + size > MAX_PASSWORD_BYTES) break
    length += size
    out += ch
  }
  return out
}

function password(value, where = 'password') {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw invalid(`${where} must be a string, got ${describe(value)}`)
  if (value.includes('\0')) throw invalid(`${where} must not contain a NUL character`)
  return value
}

function passwordCandidates(value) {
  const raw = truncate(value)
  const prepared = truncate(saslprep(value))
  return raw === prepared ? [raw] : [raw, prepared]
}

function passwordBytes(value) {
  return Buffer.from(truncate(saslprep(value)), 'utf8')
}

module.exports = {
  describe,
  options,
  bytes,
  finite,
  integer,
  pageIndex,
  password,
  passwordCandidates,
  passwordBytes
}
