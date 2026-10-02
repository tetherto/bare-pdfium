const { invalid, failure } = require('./errors')
const { options, passwordBytes } = require('./args')
const crypto = require('bare-crypto')

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

const PERMISSION_BITS = {
  print: 3,
  modify: 4,
  copy: 5,
  annotate: 6,
  fillForms: 9,
  assemble: 11,
  printHighQuality: 12
}

function isRegular(byte) {
  return byte !== undefined && !WHITESPACE.has(byte) && !DELIMITERS.has(byte)
}

function isHexDigit(byte) {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x46) ||
    (byte >= 0x61 && byte <= 0x66)
  )
}

class Lexer {
  constructor(pdf, pos = 0) {
    this.pdf = pdf
    this.pos = pos
  }

  skip() {
    const { pdf } = this
    while (this.pos < pdf.length) {
      const byte = pdf[this.pos]
      if (WHITESPACE.has(byte)) {
        this.pos++
      } else if (byte === 0x25) {
        while (this.pos < pdf.length && pdf[this.pos] !== 0x0a && pdf[this.pos] !== 0x0d) this.pos++
      } else {
        break
      }
    }
  }

  next() {
    this.skip()
    const { pdf } = this
    const start = this.pos
    const byte = pdf[start]
    if (byte === undefined) throw failure('ENCRYPT', 'unexpected end of PDF')

    if (byte === 0x3c && pdf[start + 1] === 0x3c) {
      this.pos += 2
      return { type: 'open', start, end: this.pos }
    }
    if (byte === 0x3e && pdf[start + 1] === 0x3e) {
      this.pos += 2
      return { type: 'close', start, end: this.pos }
    }
    if (byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d) {
      this.pos++
      return { type: 'punct', start, end: this.pos }
    }
    if (byte === 0x28) {
      this.pos++
      return { type: 'string', start, bytes: this.literal(), end: this.pos }
    }
    if (byte === 0x3c) {
      this.pos++
      return { type: 'string', start, bytes: this.hex(), end: this.pos }
    }
    if (byte === 0x2f) {
      this.pos++
      while (isRegular(pdf[this.pos])) this.pos++
      return { type: 'name', start, end: this.pos, text: this.text(start, this.pos) }
    }
    if (byte === 0x29 || byte === 0x3e) {
      throw failure('ENCRYPT', `unexpected '${String.fromCharCode(byte)}' in PDF`)
    }

    while (isRegular(pdf[this.pos])) this.pos++
    return { type: 'word', start, end: this.pos, text: this.text(start, this.pos) }
  }

  text(start, end) {
    return this.pdf.subarray(start, end).toString('latin1')
  }

  literal() {
    const { pdf } = this
    const bytes = []
    let depth = 1
    while (true) {
      const byte = pdf[this.pos++]
      if (byte === undefined) throw failure('ENCRYPT', 'unterminated string in PDF')
      if (byte === 0x5c) {
        const escaped = pdf[this.pos++]
        if (escaped === 0x6e) bytes.push(0x0a)
        else if (escaped === 0x72) bytes.push(0x0d)
        else if (escaped === 0x74) bytes.push(0x09)
        else if (escaped === 0x62) bytes.push(0x08)
        else if (escaped === 0x66) bytes.push(0x0c)
        else if (escaped === 0x0d) {
          if (pdf[this.pos] === 0x0a) this.pos++
        } else if (escaped === 0x0a) {
          continue
        } else if (escaped >= 0x30 && escaped <= 0x37) {
          let value = escaped - 0x30
          for (let i = 0; i < 2 && pdf[this.pos] >= 0x30 && pdf[this.pos] <= 0x37; i++) {
            value = value * 8 + (pdf[this.pos++] - 0x30)
          }
          bytes.push(value & 0xff)
        } else if (escaped !== undefined) {
          bytes.push(escaped)
        }
      } else if (byte === 0x28) {
        depth++
        bytes.push(byte)
      } else if (byte === 0x29) {
        if (--depth === 0) break
        bytes.push(byte)
      } else if (byte === 0x0d) {
        if (pdf[this.pos] === 0x0a) this.pos++
        bytes.push(0x0a)
      } else {
        bytes.push(byte)
      }
    }
    return Buffer.from(bytes)
  }

  hex() {
    const { pdf } = this
    let digits = ''
    while (true) {
      const byte = pdf[this.pos++]
      if (byte === undefined) throw failure('ENCRYPT', 'unterminated hex string in PDF')
      if (byte === 0x3e) break
      if (isHexDigit(byte)) digits += String.fromCharCode(byte)
      else if (!WHITESPACE.has(byte)) throw failure('ENCRYPT', 'bad hex string in PDF')
    }
    if (digits.length % 2) digits += '0'
    return Buffer.from(digits, 'hex')
  }

  eol() {
    if (this.pdf[this.pos] === 0x0d) this.pos++
    if (this.pdf[this.pos] === 0x0a) this.pos++
  }
}

function readXref(pdf) {
  const tail = pdf.subarray(Math.max(0, pdf.length - 2048)).toString('latin1')
  const at = tail.lastIndexOf('startxref')
  if (at === -1) throw failure('ENCRYPT', 'saved PDF has no startxref')
  const match = /^startxref\s+(\d+)/.exec(tail.slice(at))
  if (!match) throw failure('ENCRYPT', 'saved PDF has a bad startxref')

  const lexer = new Lexer(pdf, Number(match[1]))
  if (lexer.next().text !== 'xref') {
    throw failure(
      'ENCRYPT',
      'saved PDF uses a cross-reference stream, which encryption does not support'
    )
  }

  const objects = []
  while (true) {
    const first = lexer.next()
    if (first.text === 'trailer') break
    const count = Number(lexer.next().text)
    for (let i = 0; i < count; i++) {
      const offset = Number(lexer.next().text)
      const generation = Number(lexer.next().text)
      const kind = lexer.next().text
      if (kind === 'n') objects.push({ number: Number(first.text) + i, generation, offset })
    }
  }

  const trailer = readTrailer(lexer)
  if (trailer.prev) {
    throw failure('ENCRYPT', 'saved PDF has incremental updates, which encryption does not support')
  }
  return { objects, trailer }
}

function readTrailer(lexer) {
  const trailer = { size: 0, root: null, info: null, id: null, prev: false }
  if (lexer.next().type !== 'open') throw failure('ENCRYPT', 'saved PDF has a bad trailer')

  let depth = 1
  while (depth > 0) {
    const token = lexer.next()
    if (token.type === 'open') depth++
    else if (token.type === 'close') depth--
    else if (depth === 1 && token.type === 'name') {
      if (token.text === '/Size') trailer.size = Number(lexer.next().text)
      else if (token.text === '/Root') trailer.root = reference(lexer)
      else if (token.text === '/Info') trailer.info = reference(lexer)
      else if (token.text === '/Prev') trailer.prev = true
      else if (token.text === '/ID') {
        lexer.next()
        const first = lexer.next()
        if (first.type === 'string') trailer.id = first.bytes
      }
    }
  }

  if (!trailer.root) throw failure('ENCRYPT', 'saved PDF has no /Root')
  return trailer
}

function reference(lexer) {
  const number = lexer.next().text
  const generation = lexer.next().text
  lexer.next()
  return `${number} ${generation} R`
}

function aes256(key, data) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([iv, cipher.update(data), cipher.final()])
}

function rawCipher(algorithm, key, iv, data) {
  const cipher = crypto.createCipheriv(algorithm, key, iv)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

function sha(algorithm, ...parts) {
  return crypto.createHash(algorithm).update(Buffer.concat(parts)).digest()
}

function hardenedHash(password, salt, userKey) {
  let key = sha('sha256', password, salt, userKey)
  let block = Buffer.alloc(0)
  for (let round = 0; round < 64 || block[block.length - 1] > round - 32; round++) {
    const repeated = Buffer.concat(Array(64).fill(Buffer.concat([password, key, userKey])))
    block = rawCipher('aes-128-cbc', key.subarray(0, 16), key.subarray(16, 32), repeated)
    let sum = 0
    for (let i = 0; i < 16; i++) sum += block[i]
    key = sha(['sha256', 'sha384', 'sha512'][sum % 3], block)
  }
  return key.subarray(0, 32)
}

function permissionFlags(permissions) {
  let flags = 0xfffff2c0
  for (const [name, allowed] of Object.entries(permissions)) {
    if (!Object.hasOwn(PERMISSION_BITS, name)) {
      throw invalid(`unknown permission '${name}'; use ${Object.keys(PERMISSION_BITS).join(', ')}`)
    }
    if (typeof allowed !== 'boolean') throw invalid(`permission '${name}' must be true or false`)
  }
  for (const [name, bit] of Object.entries(PERMISSION_BITS)) {
    if (permissions[name] !== false) flags |= 1 << (bit - 1)
  }
  return flags | 0
}

function secret(value, where) {
  if (typeof value !== 'string') throw invalid(`${where} must be a string`)
  if (value.includes('\0')) throw invalid(`${where} must not contain a NUL character`)
  return value
}

function securityHandler(opts) {
  const own = options(opts, 'encrypt')
  const password = secret(own.password, 'encrypt.password')
  const given = own.ownerPassword !== undefined && own.ownerPassword !== null
  const ownerPassword = given
    ? secret(own.ownerPassword, 'encrypt.ownerPassword')
    : crypto.randomBytes(32).toString('hex')
  const permissions = own.permissions ?? {}
  if (password === '' && !given) {
    throw invalid('an empty password needs an ownerPassword, or anyone could lift the restrictions')
  }
  if (given && ownerPassword === '') {
    throw invalid('encrypt.ownerPassword must not be empty, or anyone could lift the restrictions')
  }
  if (given && passwordBytes(ownerPassword).equals(passwordBytes(password))) {
    throw invalid('encrypt.ownerPassword must differ from encrypt.password')
  }
  if (typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw invalid('encrypt.permissions must be an object')
  }

  const flags = permissionFlags(permissions)
  const fileKey = crypto.randomBytes(32)
  const user = passwordBytes(password)
  const owner = passwordBytes(ownerPassword)
  const zeroIV = Buffer.alloc(16)

  const userSalts = crypto.randomBytes(16)
  const U = Buffer.concat([
    hardenedHash(user, userSalts.subarray(0, 8), Buffer.alloc(0)),
    userSalts
  ])
  const UE = rawCipher(
    'aes-256-cbc',
    hardenedHash(user, userSalts.subarray(8, 16), Buffer.alloc(0)),
    zeroIV,
    fileKey
  )

  const ownerSalts = crypto.randomBytes(16)
  const O = Buffer.concat([hardenedHash(owner, ownerSalts.subarray(0, 8), U), ownerSalts])
  const OE = rawCipher(
    'aes-256-cbc',
    hardenedHash(owner, ownerSalts.subarray(8, 16), U),
    zeroIV,
    fileKey
  )

  const perms = Buffer.alloc(16)
  perms.writeInt32LE(flags, 0)
  perms.writeUInt32LE(0xffffffff, 4)
  perms.write('Tadb', 8, 'latin1')
  crypto.randomBytes(4).copy(perms, 12)

  const dictionary =
    '<< /Filter /Standard /V 5 /R 6 /Length 256' +
    ' /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF' +
    ` /O <${O.toString('hex')}> /U <${U.toString('hex')}>` +
    ` /OE <${OE.toString('hex')}> /UE <${UE.toString('hex')}>` +
    ` /Perms <${rawCipher('aes-256-ecb', fileKey, Buffer.alloc(0), perms).toString('hex')}>` +
    ` /P ${flags} /EncryptMetadata true >>`

  return { fileKey, dictionary }
}

const MAX_DEPTH = 512
const INTEGER = /^\d+$/

function punct(pdf, token) {
  return token.type === 'punct' ? String.fromCharCode(pdf[token.start]) : null
}

function parseValue(lexer, token, refs, depth) {
  if (depth > MAX_DEPTH) throw failure('ENCRYPT', 'saved PDF nests objects too deeply')
  const { pdf } = lexer

  if (token.type === 'open') {
    const entries = []
    while (true) {
      const key = lexer.next()
      if (key.type === 'close') return { kind: 'dict', entries }
      if (key.type !== 'name') {
        throw failure('ENCRYPT', 'saved PDF has a dictionary key that is not a name')
      }
      entries.push([key, parseValue(lexer, lexer.next(), refs, depth + 1)])
    }
  }

  if (punct(pdf, token) === '[') {
    const items = []
    while (true) {
      const next = lexer.next()
      if (punct(pdf, next) === ']') return { kind: 'array', items }
      items.push(parseValue(lexer, next, refs, depth + 1))
    }
  }

  if (token.type === 'string') return { kind: 'string', bytes: token.bytes }

  if (token.type === 'word' && INTEGER.test(token.text)) {
    const saved = lexer.pos
    const generation = lexer.next()
    if (generation.type === 'word' && INTEGER.test(generation.text)) {
      const keyword = lexer.next()
      if (keyword.type === 'word' && keyword.text === 'R') {
        refs.add(Number(token.text))
        return { kind: 'ref', number: Number(token.text), start: token.start, end: keyword.end }
      }
    }
    lexer.pos = saved
  }

  return { kind: 'atom', start: token.start, end: token.end, text: token.text }
}

function entry(node, key) {
  if (node.kind !== 'dict') return null
  const found = node.entries.find(([name]) => name.text === key)
  return found ? found[1] : null
}

function emit(pdf, node, fileKey, length) {
  if (node.kind === 'dict') {
    const parts = node.entries.map(([key, value]) => {
      const raw = pdf.subarray(key.start, key.end).toString('latin1')
      const text =
        length !== null && key.text === '/Length' ? String(length) : emit(pdf, value, fileKey, null)
      return `${raw} ${text}`
    })
    return `<< ${parts.join(' ')} >>`
  }
  if (node.kind === 'array') {
    return `[${node.items.map((item) => emit(pdf, item, fileKey, null)).join(' ')}]`
  }
  if (node.kind === 'string') return `<${aes256(fileKey, node.bytes).toString('hex')}>`
  return pdf.subarray(node.start, node.end).toString('latin1')
}

function streamLength(pdf, node, offsets, number) {
  const value = entry(node, '/Length')
  if (value === null) throw failure('ENCRYPT', `stream in object ${number} has no /Length`)
  if (value.kind === 'atom' && INTEGER.test(value.text)) return Number(value.text)
  if (value.kind === 'ref') {
    const target = offsets.get(value.number)
    if (target === undefined) {
      throw failure(
        'ENCRYPT',
        `stream length in object ${number} refers to missing object ${value.number}`
      )
    }
    const inner = new Lexer(pdf, target)
    inner.next()
    inner.next()
    inner.next()
    const length = inner.next()
    if (length.type === 'word' && INTEGER.test(length.text)) return Number(length.text)
  }
  throw failure('ENCRYPT', `stream in object ${number} has an unreadable /Length`)
}

function encryptObject(pdf, item, fileKey, offsets, refs) {
  const lexer = new Lexer(pdf, item.offset)
  const number = lexer.next()
  const generation = lexer.next()
  const keyword = lexer.next()
  if (keyword.text !== 'obj' || Number(number.text) !== item.number) {
    throw failure('ENCRYPT', `object ${item.number} is not where the cross-reference table says`)
  }

  const value = parseValue(lexer, lexer.next(), refs, 0)
  const type = entry(value, '/Type')
  const typeName = type && type.kind === 'atom' ? type.text : null
  if (typeName === '/XRef') return null
  if (typeName === '/ObjStm') {
    throw failure(
      'ENCRYPT',
      'saved PDF contains an object stream, which encryption does not support'
    )
  }

  const next = lexer.next()
  let encrypted = null
  if (next.type === 'word' && next.text === 'stream') {
    lexer.eol()
    const length = streamLength(pdf, value, offsets, item.number)
    const stream = pdf.subarray(lexer.pos, lexer.pos + length)
    lexer.pos += length
    if (lexer.next().text !== 'endstream') {
      throw failure('ENCRYPT', `stream in object ${item.number} has the wrong /Length`)
    }
    encrypted = aes256(fileKey, stream)
  } else if (!(next.type === 'word' && next.text === 'endobj')) {
    throw failure('ENCRYPT', `object ${item.number} has more than one value`)
  }

  const body = emit(pdf, value, fileKey, encrypted ? encrypted.length : null)
  const head = Buffer.from(`${item.number} ${generation.text} obj\n${body}\n`, 'latin1')
  if (!encrypted) return Buffer.concat([head, Buffer.from('endobj\n', 'latin1')])
  return Buffer.concat([
    head,
    Buffer.from('stream\n', 'latin1'),
    encrypted,
    Buffer.from('\nendstream\nendobj\n', 'latin1')
  ])
}

function crossReference(written) {
  const numbers = [...written.keys()].sort((a, b) => a - b)
  let xref = 'xref\n0 1\n0000000000 65535 f\r\n'
  for (let i = 0; i < numbers.length;) {
    let j = i
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++
    xref += `${numbers[i]} ${j - i + 1}\n`
    for (let k = i; k <= j; k++) {
      const object = written.get(numbers[k])
      xref += `${String(object.offset).padStart(10, '0')} ${String(object.generation).padStart(5, '0')} n\r\n`
    }
    i = j + 1
  }
  return xref
}

module.exports = function encrypt(pdf, opts) {
  const { fileKey, dictionary } = securityHandler(opts)
  const { objects, trailer } = readXref(pdf)
  objects.sort((a, b) => a.offset - b.offset)

  const offsets = new Map(objects.map((item) => [item.number, item.offset]))
  const header = pdf.subarray(0, objects.length ? objects[0].offset : 0)
  const parts = [header]
  const written = new Map()
  const refs = new Set()
  let position = header.length

  for (const item of objects) {
    const object = encryptObject(pdf, item, fileKey, offsets, refs)
    if (object === null) continue
    written.set(item.number, { offset: position, generation: item.generation })
    parts.push(object)
    position += object.length
  }

  let highest = trailer.size - 1
  for (const item of objects) if (item.number > highest) highest = item.number
  for (const number of refs) if (number > highest) highest = number
  const encryptNumber = highest + 1
  const encryptObjectBytes = Buffer.from(
    `${encryptNumber} 0 obj\n${dictionary}\nendobj\n`,
    'latin1'
  )
  written.set(encryptNumber, { offset: position, generation: 0 })
  parts.push(encryptObjectBytes)
  position += encryptObjectBytes.length

  const id = (trailer.id && trailer.id.length ? trailer.id : crypto.randomBytes(16)).toString('hex')
  const info = trailer.info ? ` /Info ${trailer.info}` : ''
  const xref =
    crossReference(written) +
    `trailer\n<< /Size ${encryptNumber + 1} /Root ${trailer.root}${info}` +
    ` /ID [<${id}> <${id}>] /Encrypt ${encryptNumber} 0 R >>\n` +
    `startxref\n${position}\n%%EOF\n`

  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}
