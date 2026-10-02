const { invalid, failure } = require('./errors')
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

const MAX_PASSWORD_BYTES = 127

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
    if (byte === 0x29 || byte === 0x3e)
      throw failure('ENCRYPT', `unexpected '${String.fromCharCode(byte)}' in PDF`)

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
  if (trailer.prev)
    throw failure('ENCRYPT', 'saved PDF has incremental updates, which encryption does not support')
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
    if (!(name in PERMISSION_BITS)) {
      throw invalid(`unknown permission '${name}'; use ${Object.keys(PERMISSION_BITS).join(', ')}`)
    }
    if (typeof allowed !== 'boolean') throw invalid(`permission '${name}' must be true or false`)
  }
  for (const [name, bit] of Object.entries(PERMISSION_BITS)) {
    if (permissions[name] !== false) flags |= 1 << (bit - 1)
  }
  return flags | 0
}

function passwordBytes(password) {
  return Buffer.from(password, 'utf8').subarray(0, MAX_PASSWORD_BYTES)
}

function securityHandler(opts) {
  const {
    password,
    ownerPassword = crypto.randomBytes(32).toString('hex'),
    permissions = {}
  } = opts
  if (typeof password !== 'string') throw invalid('encrypt.password must be a string')
  if (typeof ownerPassword !== 'string') throw invalid('encrypt.ownerPassword must be a string')
  if (password === '' && opts.ownerPassword === undefined) {
    throw invalid('an empty password needs an ownerPassword, or anyone could lift the restrictions')
  }
  if (permissions === null || typeof permissions !== 'object') {
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

function directInteger(pdf, lexer, token, offsets) {
  const after = lexer.pos
  const generation = lexer.next()
  const keyword = generation.type === 'word' ? lexer.next() : null
  if (keyword && keyword.text === 'R') {
    const target = offsets.get(Number(token.text))
    if (target === undefined)
      throw failure('ENCRYPT', `stream length refers to missing object ${token.text}`)
    const inner = new Lexer(pdf, target)
    inner.next()
    inner.next()
    inner.next()
    return { value: Number(inner.next().text), end: lexer.pos }
  }
  lexer.pos = after
  return { value: Number(token.text), end: after }
}

function encryptObject(pdf, entry, fileKey, offsets) {
  const lexer = new Lexer(pdf, entry.offset)
  const number = lexer.next()
  const generation = lexer.next()
  const keyword = lexer.next()
  if (keyword.text !== 'obj' || Number(number.text) !== entry.number) {
    throw failure('ENCRYPT', `object ${entry.number} is not where the cross-reference table says`)
  }

  const tokens = []
  let depth = 0
  let length = null
  let type = null
  let stream = null

  while (true) {
    const token = lexer.next()
    if (token.type === 'word' && token.text === 'endobj') break
    if (token.type === 'word' && token.text === 'stream') {
      lexer.eol()
      if (length === null)
        throw failure('ENCRYPT', `stream in object ${entry.number} has no /Length`)
      stream = pdf.subarray(lexer.pos, lexer.pos + length.value)
      lexer.pos += length.value
      const end = lexer.next()
      if (end.text !== 'endstream')
        throw failure('ENCRYPT', `stream in object ${entry.number} has the wrong /Length`)
      continue
    }

    if (token.type === 'open') depth++
    else if (token.type === 'close') depth--

    tokens.push(token)

    if (depth === 1 && token.type === 'name' && tokens.length > 1) {
      if (token.text === '/Length') {
        const value = lexer.next()
        length = { start: value.start, ...directInteger(pdf, lexer, value, offsets) }
        tokens.push({ type: 'length' })
      } else if (token.text === '/Type') {
        const value = lexer.next()
        type = value.text
        tokens.push(value)
      }
    }
  }

  if (type === '/XRef') return null
  if (type === '/ObjStm') {
    throw failure(
      'ENCRYPT',
      'saved PDF contains an object stream, which encryption does not support'
    )
  }

  const encrypted = stream ? aes256(fileKey, stream) : null
  const body = tokens
    .map((token) => {
      if (token.type === 'string') return `<${aes256(fileKey, token.bytes).toString('hex')}>`
      if (token.type === 'length') {
        return encrypted
          ? String(encrypted.length)
          : pdf.subarray(length.start, length.end).toString('latin1')
      }
      return pdf.subarray(token.start, token.end).toString('latin1')
    })
    .join(' ')

  const head = Buffer.from(`${entry.number} ${generation.text} obj\n${body}\n`, 'latin1')
  if (!encrypted) return Buffer.concat([head, Buffer.from('endobj\n', 'latin1')])
  return Buffer.concat([
    head,
    Buffer.from('stream\n', 'latin1'),
    encrypted,
    Buffer.from('\nendstream\nendobj\n', 'latin1')
  ])
}

module.exports = function encrypt(pdf, opts) {
  const { fileKey, dictionary } = securityHandler(opts)
  const { objects, trailer } = readXref(pdf)
  objects.sort((a, b) => a.offset - b.offset)

  const offsets = new Map(objects.map((entry) => [entry.number, entry.offset]))
  const header = pdf.subarray(0, objects.length ? objects[0].offset : 0)
  const parts = [header]
  const written = new Map()
  let position = header.length

  for (const entry of objects) {
    const object = encryptObject(pdf, entry, fileKey, offsets)
    if (object === null) continue
    written.set(entry.number, { offset: position, generation: entry.generation })
    parts.push(object)
    position += object.length
  }

  const size = Math.max(trailer.size, ...objects.map((entry) => entry.number + 1))
  const encryptNumber = size
  const encryptObjectBytes = Buffer.from(
    `${encryptNumber} 0 obj\n${dictionary}\nendobj\n`,
    'latin1'
  )
  written.set(encryptNumber, { offset: position, generation: 0 })
  parts.push(encryptObjectBytes)
  position += encryptObjectBytes.length

  let xref = `xref\n0 ${size + 1}\n0000000000 65535 f\r\n`
  for (let number = 1; number <= size; number++) {
    const object = written.get(number)
    xref += object
      ? `${String(object.offset).padStart(10, '0')} ${String(object.generation).padStart(5, '0')} n\r\n`
      : '0000000000 00000 f\r\n'
  }

  const id = (trailer.id && trailer.id.length ? trailer.id : crypto.randomBytes(16)).toString('hex')
  const info = trailer.info ? ` /Info ${trailer.info}` : ''
  xref +=
    `trailer\n<< /Size ${size + 1} /Root ${trailer.root}${info}` +
    ` /ID [<${id}> <${id}>] /Encrypt ${encryptNumber} 0 R >>\n` +
    `startxref\n${position}\n%%EOF\n`

  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}
