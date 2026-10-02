const { invalid, outOfRange, failure } = require('./errors')
const { bytes, finite } = require('./args')

const PAGE_SIZES = {
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008]
}

const FAMILIES = {
  Helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  Times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  Courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique']
}

const HEADING_SCALE = [2, 1.64, 1.36, 1.18, 1.09, 1]
const MIN_COLUMN_WIDTH = 10

const INK = [26, 26, 26]
const MUTED = [90, 90, 90]
const RULE = [190, 190, 190]
const SHADE = [242, 242, 242]
const HEADER_SHADE = [230, 230, 230]

const BLOCK_TYPES = new Set([
  'heading',
  'paragraph',
  'list',
  'table',
  'image',
  'code',
  'quote',
  'rule',
  'pageBreak'
])

function fontBytes(value, where) {
  try {
    const data = bytes(value, where)
    return data.byteLength > 0 ? data : null
  } catch {
    return null
  }
}

function fontSources(font, where = 'font') {
  if (typeof font === 'string') {
    if (!Object.hasOwn(FAMILIES, font)) {
      throw invalid(
        `${where} must be ${Object.keys(FAMILIES).join(', ')} or TrueType font bytes, got '${font}'`
      )
    }
    return FAMILIES[font]
  }
  const single = fontBytes(font, where)
  if (single) return [single, single, single, single]
  if (font && typeof font === 'object' && fontBytes(font.regular, where)) {
    const regular = fontBytes(font.regular, where)
    const pick = (name, fallback) => {
      if (font[name] === undefined || font[name] === null) return fallback
      const data = fontBytes(font[name], where)
      if (!data) throw invalid(`${where}.${name} must be TrueType font bytes`)
      return data
    }
    const bold = pick('bold', regular)
    return [regular, bold, pick('italic', regular), pick('boldItalic', bold)]
  }
  throw invalid(
    `${where} must be a family name, TrueType font bytes, or { regular, bold, italic, boldItalic }`
  )
}

function pageSize(size, landscape) {
  let dimensions = size
  if (typeof size === 'string') {
    dimensions = Object.hasOwn(PAGE_SIZES, size) ? PAGE_SIZES[size] : null
    if (!dimensions) {
      throw invalid(
        `pageSize must be ${Object.keys(PAGE_SIZES).join(', ')} or [width, height], got '${size}'`
      )
    }
  }
  if (
    !Array.isArray(dimensions) ||
    dimensions.length !== 2 ||
    !dimensions.every((n) => typeof n === 'number' && n >= 72 && n <= 14400)
  ) {
    throw invalid('pageSize must be a name or [width, height] in points, each 72 to 14400')
  }
  const [width, height] = dimensions
  return landscape ? [Math.max(width, height), Math.min(width, height)] : [width, height]
}

const LINK =
  /^!?\[((?:[^\]\\]|\\.)*)\]\((?=(\s*))\2(?:<[^>]*>|(?:[^()\s]|\([^()\s]*\))*)(?:(?=(\s+))\3(?:"[^"]*"|'[^']*'))?(?=(\s*))\4\)/
const BREAK = /^<br\s*\/?>/i
const MAX_LIST_DEPTH = 100

function nextClose(text, from) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === ']') return i
  }
  return -1
}

function parseInline(source) {
  let text = source
  const runs = []
  let bold = null
  let italic = null
  let buffer = ''
  let closeFrom = -1
  let closeAt = -1
  let failedClose = -1

  const style = () => ({ bold: bold !== null, italic: italic !== null })
  const flush = () => {
    if (buffer) runs.push({ text: buffer, ...style() })
    buffer = ''
  }
  const isSpace = (ch) => ch === undefined || /\s/.test(ch)
  const isWord = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)
  const closeAfter = (i) => {
    if (closeFrom === -1 || i < closeFrom || (closeAt !== -1 && i > closeAt)) {
      closeFrom = i
      closeAt = nextClose(text, i)
    }
    return closeAt
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (ch === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(text[i + 1])) {
      buffer += text[++i]
      continue
    }

    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i) {
        flush()
        runs.push({ text: text.slice(i + 1, end), code: true, ...style() })
        i = end
        continue
      }
    }

    if (ch === '<') {
      const match = BREAK.exec(text.slice(i, i + 8))
      if (match) {
        buffer += '\n'
        i += match[0].length - 1
        continue
      }
    }

    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const close = closeAfter(ch === '!' ? i + 2 : i + 1)
      if (close !== -1 && close !== failedClose && text[close + 1] === '(') {
        const match = LINK.exec(text.slice(i))
        if (match) {
          text = text.slice(0, i) + match[1] + text.slice(i + match[0].length)
          closeFrom = -1
          failedClose = -1
          i--
          continue
        }
        failedClose = close
      }
    }

    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const before = text[i - 1]
      const after = text[i + 2]
      const opens = bold === null && !isSpace(after) && (ch === '*' || !isWord(before))
      const closes = bold !== null && !isSpace(before) && (ch === '*' || !isWord(after))
      if (opens || closes) {
        flush()
        bold = opens ? { at: runs.length, marker: ch + ch } : null
      } else {
        buffer += ch + ch
      }
      i++
      continue
    }

    if (ch === '*' || ch === '_') {
      const before = text[i - 1]
      const after = text[i + 1]
      const opens = italic === null && !isSpace(after) && (ch === '*' || !isWord(before))
      const closes = italic !== null && !isSpace(before) && (ch === '*' || !isWord(after))
      if (opens || closes) {
        flush()
        italic = opens ? { at: runs.length, marker: ch } : null
        continue
      }
    }

    buffer += ch
  }

  flush()
  for (const [open, key] of [
    [bold, 'bold'],
    [italic, 'italic']
  ]) {
    if (open === null) continue
    for (let r = open.at; r < runs.length; r++) runs[r][key] = false
    if (open.at < runs.length) runs[open.at].text = open.marker + runs[open.at].text
    else runs.push({ text: open.marker, ...style(), [key]: false })
  }
  return runs
}

function toRuns(value, where) {
  if (typeof value === 'number') value = String(value)
  if (typeof value === 'string') return parseInline(value)
  if (Array.isArray(value)) {
    return value.map((run) => {
      if (typeof run === 'string') return { text: run }
      if (run && typeof run.text === 'string') return run
      throw invalid(`${where} runs must be strings or { text, bold, italic, code }`)
    })
  }
  throw invalid(`${where} must be a string or an array of runs`)
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING_START = /^\s{0,3}(#{1,6})\s+/
const PAGE_BREAK = /^\s*\\(pagebreak|newpage)\s*$/
const IMAGE_START = /^\s*!\[([^\]]*)\]\(/

function indentOf(line) {
  let n = 0
  while (n < line.length && line[n] === ' ') n++
  return n
}

function parseHeading(line) {
  const match = HEADING_START.exec(line)
  if (!match) return null
  let text = line.slice(match[0].length).trimEnd()
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end--
  if (end === 0) text = ''
  else if (end < text.length && /\s/.test(text[end - 1])) text = text.slice(0, end).trimEnd()
  return { level: match[1].length, text }
}

function isRule(line) {
  if (indentOf(line) > 3) return false
  const chars = line.replace(/[ \t]/g, '')
  if (chars.length < 3) return false
  const ch = chars[0]
  if (ch !== '-' && ch !== '*' && ch !== '_') return false
  for (const c of chars) if (c !== ch) return false
  return true
}

function isTableDivider(line) {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)
  if (!row.includes('-')) return false
  return row.split('|').every((cell) => /^:?-+:?$/.test(cell.trim()))
}

function parseImageLine(line) {
  const match = IMAGE_START.exec(line)
  if (!match) return null
  let rest = line.slice(match[0].length).trim()
  if (!rest.endsWith(')')) return null
  rest = rest.slice(0, -1).trim()
  const space = rest.search(/\s/)
  const src = space === -1 ? rest : rest.slice(0, space)
  const title = space === -1 ? '' : rest.slice(space).trim()
  if (!src || src.includes(')') || (title && !/^"[^"]*"$/.test(title))) return null
  return { alt: match[1], src }
}

function isClosingFence(line, marker) {
  if (indentOf(line) > 3) return false
  const trimmed = line.trim()
  let n = 0
  while (n < trimmed.length && trimmed[n] === marker[0]) n++
  return n >= marker.length && trimmed.slice(n).trim() === ''
}

function splitRow(line) {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells = []
  let cell = ''
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
    } else if (row[i] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += row[i]
    }
  }
  cells.push(cell.trim())
  return cells
}

function dataUri(src) {
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(src)
  if (!match) return null
  try {
    const data = Buffer.from(match[2], 'base64')
    return data.length ? data : null
  } catch {
    return null
  }
}

function startsBlock(line, next) {
  return (
    FENCE.test(line) ||
    parseHeading(line) !== null ||
    isRule(line) ||
    /^\s*>/.test(line) ||
    LIST_ITEM.test(line) ||
    PAGE_BREAK.test(line) ||
    parseImageLine(line) !== null ||
    (line.includes('|') && next !== undefined && isTableDivider(next))
  )
}

function listMarker(match) {
  const ordered = /\d/.test(match[2])
  return { ordered, start: ordered ? parseInt(match[2], 10) : 1 }
}

function parseList(lines, start) {
  const root = { items: [], indent: null, ordered: false, start: 1 }
  const stack = [root]
  let i = start
  let last = null

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      let next = i + 1
      while (next < lines.length && !lines[next].trim()) next++
      const following = next < lines.length ? LIST_ITEM.exec(lines[next]) : null
      if (!following) break
      const indent = following[1].replace(/\t/g, '    ').length
      if (indent <= root.indent && listMarker(following).ordered !== root.ordered) break
      i = next
      continue
    }

    const match = LIST_ITEM.exec(line)
    if (match) {
      const indent = match[1].replace(/\t/g, '    ').length
      const marker = listMarker(match)
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop()
      let parent = stack[stack.length - 1]
      if (last && indent > last.indent && parent !== last.list && stack.length < MAX_LIST_DEPTH) {
        last.list = { items: [], indent, ...marker }
        last.item.list = last.list
        stack.push(last.list)
        parent = last.list
      }
      if (parent === root) {
        if (root.indent === null) Object.assign(root, { indent }, marker)
        else if (indent <= root.indent && marker.ordered !== root.ordered) break
      }
      const item = { text: match[3] }
      parent.items.push(item)
      last = { item, indent, list: null }
      i++
    } else if (last && /^\s+/.test(line) && !startsBlock(line.trim())) {
      last.item.text += ' ' + line.trim()
      i++
    } else {
      break
    }
  }

  const toItems = (items) =>
    items.map((item) =>
      item.list
        ? {
            text: item.text,
            items: toItems(item.list.items),
            ordered: item.list.ordered,
            start: item.list.start
          }
        : item.text
    )

  return {
    block: { type: 'list', ordered: root.ordered, start: root.start, items: toItems(root.items) },
    next: i
  }
}

function parseMarkdown(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const body = []
      i++
      while (i < lines.length && !isClosingFence(lines[i], marker)) body.push(lines[i++])
      i++
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }

    const heading = parseHeading(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading.level, text: heading.text })
      i++
      continue
    }

    if (PAGE_BREAK.test(line)) {
      blocks.push({ type: 'pageBreak' })
      i++
      continue
    }

    if (isRule(line)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }

    if (/^\s*>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i++].replace(/^\s*>\s?/, ''))
      }
      blocks.push({ type: 'quote', text: body.join(' ').trim() })
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const header = splitRow(line)
      const rows = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i++]))
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i)
      blocks.push(block)
      i = next
      continue
    }

    const image = parseImageLine(line)
    if (image) {
      const data = dataUri(image.src)
      const alt = { type: 'paragraph', text: [{ text: `[${image.alt || 'image'}]`, italic: true }] }
      blocks.push(
        data ? { type: 'image', data, caption: image.alt || undefined, fallback: alt } : alt
      )
      i++
      continue
    }

    const body = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      const current = lines[i]
      const last =
        i + 1 >= lines.length || !lines[i + 1].trim() || startsBlock(lines[i + 1], lines[i + 2])
      const backslash = current.endsWith('\\') && !last
      const hardBreak = current.endsWith('  ') || backslash
      body.push((backslash ? current.slice(0, -1) : current).trim() + (hardBreak ? '\n' : ' '))
      i++
    }
    if (body.length === 0) {
      body.push(line.trim())
      i++
    }
    blocks.push({ type: 'paragraph', text: body.join('').trim() })
  }

  return blocks
}

function jpegSize(bytes) {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8]
      }
    }
    offset += 2 + length
  }
  return null
}

let png = null

const DECODED = Symbol('decoded image')
const MAX_IMAGE_PIXELS = 40000000

function decoded(image) {
  if (image.pixelWidth * image.pixelHeight > MAX_IMAGE_PIXELS) {
    throw failure(
      'IMAGE',
      `image is ${image.pixelWidth}x${image.pixelHeight} pixels; at most ${MAX_IMAGE_PIXELS} pixels are supported`
    )
  }
  return Object.freeze({ ...image, [DECODED]: true })
}

function isDecoded(image) {
  return image !== null && typeof image === 'object' && image[DECODED] === true
}

function decodeImage(value) {
  let data
  try {
    data = Buffer.from(bytes(value, 'image data'))
  } catch {
    throw failure('IMAGE', 'image data must be PNG or JPEG bytes')
  }

  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    const size = jpegSize(data)
    if (!size || !size.width || !size.height) {
      throw failure('IMAGE', 'JPEG image has no readable size')
    }
    return decoded({ jpeg: 1, data, pixelWidth: size.width, pixelHeight: size.height })
  }

  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    png ??= require('bare-png')
    let image
    try {
      image = png.decode(data)
    } catch (err) {
      throw failure('IMAGE', `PNG image could not be decoded: ${err && err.message}`)
    }
    if (!image.width || !image.height || image.data.length !== image.width * image.height * 4) {
      throw failure('IMAGE', 'PNG image did not decode to RGBA')
    }
    return decoded({
      jpeg: 0,
      data: image.data,
      pixelWidth: image.width,
      pixelHeight: image.height
    })
  }

  throw failure('IMAGE', 'image data must be PNG or JPEG bytes')
}

class Layout {
  constructor(doc, opts) {
    const {
      pageSize: size = 'A4',
      landscape = false,
      margin = 56.69,
      font = 'Helvetica',
      fontSize = 11,
      lineHeight = 1.4,
      pageNumbers = false
    } = opts

    finite(margin, 'margin', { min: 0, max: 7200 })
    finite(fontSize, 'fontSize', { min: 4, max: 72 })
    finite(lineHeight, 'lineHeight', { min: 1, max: 3 })

    this.doc = doc
    ;[this.width, this.height] = pageSize(size, landscape)
    this.margin = margin
    this.contentWidth = this.width - 2 * margin
    this.contentHeight = this.height - 2 * margin
    if (this.contentWidth < 72 || this.contentHeight < 72) {
      throw invalid('margin leaves no room on the page')
    }

    this.size = fontSize
    this.leading = lineHeight
    this.pageNumbers = pageNumbers === true

    const loaded = new Map()
    const load = (source) => {
      if (!loaded.has(source)) loaded.set(source, doc.loadFont(source))
      return loaded.get(source)
    }
    this.standard = typeof font === 'string'
    this.fonts = fontSources(font).map(load)
    const mono = opts.monoFont === undefined || opts.monoFont === null ? 'Courier' : opts.monoFont
    this.monoStandard = typeof mono === 'string'
    this.mono = fontSources(mono, 'monoFont').slice(0, 2).map(load)
    this.images = new Map()

    this.widths = new Map()
    this.metrics = new Map()
    this.pages = []
    this.newPage()
  }

  fontFor(run) {
    if (run.code) return { font: this.mono[run.bold ? 1 : 0], standard: this.monoStandard }
    const index = (run.bold ? 1 : 0) + (run.italic ? 2 : 0)
    return { font: this.fonts[index], standard: this.standard }
  }

  measure(font, text) {
    let cache = this.widths.get(font)
    if (!cache) this.widths.set(font, (cache = new Map()))
    let width = cache.get(text)
    if (width === undefined) {
      width = this.doc.measureText(text, font, 1000)
      cache.set(text, width)
    }
    return width
  }

  ascent(font) {
    let metrics = this.metrics.get(font)
    if (!metrics) {
      metrics = this.doc.fontMetrics(font, 1)
      this.metrics.set(font, metrics)
    }
    return metrics
  }

  newPage() {
    this.page = []
    this.pages.push(this.page)
    this.y = 0
  }

  fits(height) {
    return this.y + height <= this.contentHeight + 0.01
  }

  ensure(height) {
    if (!this.fits(height) && this.y > 0) this.newPage()
  }

  space(amount) {
    if (this.y > 0) this.y = Math.min(this.y + amount, this.contentHeight)
  }

  top(offset) {
    return this.height - this.margin - offset
  }

  pieces(runs, preserve) {
    const pieces = []
    for (const run of runs) {
      const { font, standard } = this.fontFor(run)
      const text = this.doc._textFor(font, run.text).replace(/\t/g, preserve ? '    ' : ' ')
      const parts = preserve ? text.split(/(\n| )/) : text.split(/(\n|[^\S\n]+)/)
      for (const part of parts) {
        if (!part) continue
        if (part === '\n') {
          pieces.push({ newline: true })
        } else if (part === ' ' || (!preserve && /^\s+$/.test(part))) {
          pieces.push({ space: true, font, text: ' ' })
        } else {
          pieces.push({ font, text: part })
        }
      }
    }
    return pieces
  }

  wrap(runs, size, maxWidth, preserve = false) {
    const scale = size / 1000
    const lines = []
    let line = []
    let width = 0
    let pendingSpace = null

    const pushLine = () => {
      lines.push(line)
      line = []
      width = 0
      pendingSpace = null
    }

    const words = []
    let word = null
    for (const piece of this.pieces(runs, preserve)) {
      if (piece.newline || piece.space) {
        if (word) words.push(word)
        word = null
        words.push(piece)
      } else {
        word ??= { parts: [] }
        word.parts.push(piece)
      }
    }
    if (word) words.push(word)

    const place = (part) => {
      const last = line[line.length - 1]
      const w = this.measure(part.font, part.text) * scale
      if (last && last.font === part.font) {
        last.text += part.text
        last.width += w
      } else {
        line.push({ font: part.font, text: part.text, width: w })
      }
      width += w
    }

    for (const item of words) {
      if (item.newline) {
        pushLine()
        continue
      }
      if (item.space) {
        if (preserve) {
          if (width + this.measure(item.font, ' ') * scale > maxWidth) pushLine()
          else place(item)
        } else if (line.length) {
          pendingSpace = item
        }
        continue
      }

      const wordWidth = item.parts.reduce(
        (sum, part) => sum + this.measure(part.font, part.text) * scale,
        0
      )
      const spaceWidth = pendingSpace ? this.measure(pendingSpace.font, ' ') * scale : 0

      if (line.length && width + spaceWidth + wordWidth > maxWidth) pushLine()
      else if (pendingSpace) place(pendingSpace)
      pendingSpace = null

      if (wordWidth <= maxWidth) {
        for (const part of item.parts) place(part)
        continue
      }

      for (const part of item.parts) {
        for (const ch of part.text) {
          const w = this.measure(part.font, ch) * scale
          if (line.length && width + w > maxWidth) pushLine()
          place({ font: part.font, text: ch })
        }
      }
    }

    if (line.length || !lines.length) lines.push(line)
    return lines
  }

  lineHeight(size) {
    return size * this.leading
  }

  baseline(size, lineHeight) {
    const { ascent, descent } = this.ascent(this.fonts[0])
    const a = ascent * size
    const d = -descent * size
    return (lineHeight - (a + d)) / 2 + a
  }

  drawLine(line, x, top, size, color) {
    const lineHeight = this.lineHeight(size)
    const baseline = this.top(top + this.baseline(size, lineHeight))
    let offset = x
    for (const segment of line) {
      if (segment.text.trim()) {
        this.page.push({
          type: 'text',
          text: segment.text,
          font: segment.font,
          size,
          x: this.margin + offset,
          y: baseline,
          color
        })
      }
      offset += segment.width
    }
  }

  text(
    runs,
    {
      size = this.size,
      indent = 0,
      color = INK,
      align = 'left',
      decorate = null,
      first = null
    } = {}
  ) {
    const lineHeight = this.lineHeight(size)
    const maxWidth = this.contentWidth - indent
    const lines = this.wrap(runs, size, maxWidth)
    let i = 0
    while (i < lines.length) {
      const left = lines.length - i
      const room = Math.floor((this.contentHeight - this.y + 0.01) / lineHeight)
      let take = left
      if (room < left) {
        take = Math.min(room, left - 2)
        if (take < 2) {
          if (this.y > 0) {
            this.newPage()
            continue
          }
          take = Math.max(1, room)
        }
      }
      for (const [n, line] of lines.slice(i, i + take).entries()) {
        const width = line.reduce((sum, segment) => sum + segment.width, 0)
        const x = indent + (align === 'center' ? Math.max(0, (maxWidth - width) / 2) : 0)
        if (first && i + n === 0) first(this.y, lineHeight)
        if (decorate) decorate(this.y, lineHeight)
        this.drawLine(line, x, this.y, size, color)
        this.y += lineHeight
      }
      i += take
      if (i < lines.length) this.newPage()
    }
  }

  startLines(count) {
    return count <= 3 ? count : 2
  }

  startHeight(block) {
    if (!block) return 0
    const body = this.lineHeight(this.size)
    if (block.type === 'paragraph' || block.type === 'quote') {
      const indent = block.type === 'quote' ? 14 : 0
      const lines = this.wrap(
        toRuns(block.text, `${block.type} text`),
        this.size,
        this.contentWidth - indent
      )
      return this.startLines(lines.length) * body
    }
    if (block.type === 'list' && Array.isArray(block.items) && block.items.length) {
      const entry = block.items[0]
      const text = typeof entry === 'string' || Array.isArray(entry) ? entry : entry && entry.text
      if (text === undefined) return body
      const lines = this.wrap(toRuns(text, 'list item'), this.size, this.contentWidth - 16)
      return this.startLines(lines.length) * body
    }
    if (block.type === 'table') {
      return this.lineHeight(this.size * 0.95) * (block.header ? 2 : 1) + 20
    }
    if (block.type === 'code') return this.lineHeight(this.size * 0.9) + 12
    if (block.type === 'rule') return this.size * 1.8 + body * 2
    if (block.type === 'image') {
      try {
        return this.imageBox(block).height + body
      } catch {
        return body * 2
      }
    }
    if (block.type === 'heading') {
      const level = HEADING_SCALE[(block.level ?? 1) - 1] ? (block.level ?? 1) : 1
      const size = this.size * HEADING_SCALE[level - 1]
      try {
        const lines = this.wrap(toRuns(block.text, 'heading text'), size, this.contentWidth).length
        return size * 0.9 + lines * this.lineHeight(size) + size * 0.35 + body * 2
      } catch {
        return body * 2
      }
    }
    return 0
  }

  heading(block, next) {
    const level = block.level ?? 1
    if (!Number.isInteger(level) || level < 1 || level > 6) {
      throw invalid('heading level must be 1 to 6')
    }
    const size = this.size * HEADING_SCALE[level - 1]
    const runs = toRuns(block.text, 'heading text').map((run) => ({ ...run, bold: true }))
    const gap = size * 0.35
    const lines = this.wrap(runs, size, this.contentWidth).length
    this.space(size * 0.9)
    this.ensure(lines * this.lineHeight(size) + gap + this.startHeight(next))
    this.text(runs, { size })
    this.y += gap
  }

  paragraph(block) {
    this.text(toRuns(block.text, 'paragraph text'), {
      align: block.align === 'center' ? 'center' : 'left'
    })
    this.y += this.size * 0.6
  }

  list(block, level = 0) {
    if (!Array.isArray(block.items)) throw invalid('list items must be an array')
    if (level >= MAX_LIST_DEPTH) throw invalid(`lists nest at most ${MAX_LIST_DEPTH} levels`)
    const indent = Math.min(level * 18, this.contentWidth * 0.5)
    const labelFont = this.fonts[0]
    const start = finite(block.start ?? 1, 'list start', { min: 0, max: 1e9 })
    const labelOf = (i) => (block.ordered ? `${start + i}.` : level % 2 ? '–' : '•')
    const widest = block.ordered
      ? this.measure(labelFont, labelOf(block.items.length - 1)) * (this.size / 1000)
      : 0
    const marker = Math.max(16, widest + 6)
    block.items.forEach((entry, i) => {
      const item = typeof entry === 'string' || Array.isArray(entry) ? { text: entry } : entry
      if (!item || item.text === undefined) {
        throw invalid('list items must be strings or { text, items }')
      }
      const label = labelOf(i)
      this.text(toRuns(item.text, 'list item'), {
        indent: indent + marker,
        first: (y, lineHeight) =>
          this.page.push({
            type: 'text',
            text: label,
            font: labelFont,
            size: this.size,
            x:
              this.margin +
              indent +
              marker -
              4 -
              this.measure(labelFont, label) * (this.size / 1000),
            y: this.top(y + this.baseline(this.size, lineHeight)),
            color: INK
          })
      })
      if (item.items) {
        this.list(
          { items: item.items, ordered: item.ordered === true, start: item.start },
          level + 1
        )
      }
      this.y += this.size * 0.15
    })
    if (level === 0) this.y += this.size * 0.45
  }

  quote(block) {
    const runs = toRuns(block.text, 'quote text').map((run) => ({ ...run, italic: !run.italic }))
    this.text(runs, {
      indent: 14,
      color: MUTED,
      decorate: (y, height) =>
        this.page.push({
          type: 'rect',
          x: this.margin,
          y: this.top(y + height),
          width: 3,
          height,
          fill: RULE
        })
    })
    this.y += this.size * 0.6
  }

  code(block) {
    if (typeof block.text !== 'string') throw invalid('code text must be a string')
    const size = this.size * 0.9
    const pad = 6
    const lineHeight = this.lineHeight(size)
    const lines = this.wrap(
      [{ text: block.text, code: true }],
      size,
      this.contentWidth - 2 * pad,
      true
    )
    this.ensure(lineHeight + pad)
    const shade = (y, height) =>
      this.page.push({
        type: 'rect',
        x: this.margin,
        y: this.top(y + height),
        width: this.contentWidth,
        height,
        fill: SHADE
      })
    shade(this.y, pad)
    this.y += pad
    for (const line of lines) {
      if (!this.fits(lineHeight)) {
        this.newPage()
      }
      shade(this.y, lineHeight)
      this.drawLine(line, pad, this.y, size, INK)
      this.y += lineHeight
    }
    if (this.fits(pad)) shade(this.y, pad)
    this.y += pad + this.size * 0.6
  }

  rule() {
    this.space(this.size * 0.4)
    this.ensure(this.size)
    const y = this.top(this.y + this.size * 0.5)
    this.page.push({
      type: 'line',
      x1: this.margin,
      y1: y,
      x2: this.margin + this.contentWidth,
      y2: y,
      color: RULE,
      lineWidth: 0.75
    })
    this.y += this.size * 1.4
  }

  imageBox(block) {
    let image = this.images.get(block.data)
    if (!image) {
      image = decodeImage(block.data)
      this.images.set(block.data, image)
    }
    const natural = image.pixelWidth * 0.75
    let width =
      block.width === undefined ? natural : finite(block.width, 'image width', { max: 1e6 })
    if (width <= 0) throw outOfRange(`image width must be positive, got ${width}`)
    width = Math.min(width, this.contentWidth)
    let height = (width * image.pixelHeight) / image.pixelWidth
    const captionHeight = block.caption ? this.lineHeight(this.size * 0.9) + 4 : 0
    const room = this.contentHeight - captionHeight
    if (height > room) {
      width *= room / height
      height = room
    }
    return { image, width, height, captionHeight }
  }

  image(block) {
    let box
    try {
      box = this.imageBox(block)
    } catch (err) {
      if (!block.fallback || err.code !== 'IMAGE') throw err
      this.paragraph(block.fallback)
      return
    }
    const { image, width, height, captionHeight } = box
    this.ensure(height + captionHeight)
    this.page.push({
      type: 'image',
      image,
      x: this.margin + (this.contentWidth - width) / 2,
      y: this.top(this.y + height),
      width,
      height
    })
    this.y += height + 4
    if (block.caption) {
      const runs = toRuns(block.caption, 'image caption').map((run) => ({ ...run, italic: true }))
      this.text(runs, { size: this.size * 0.9, color: MUTED, align: 'center' })
    }
    this.y += this.size * 0.6
  }

  table(block) {
    if (block.header !== undefined && block.header !== null && !Array.isArray(block.header)) {
      throw invalid('table header must be an array of cells')
    }
    const header = block.header
      ? block.header.map((cell) =>
          toRuns(cell, 'table cell').map((run) => ({ ...run, bold: true }))
        )
      : null
    if (!Array.isArray(block.rows)) throw invalid('table rows must be an array of arrays')
    const rows = block.rows.map((row) => {
      if (!Array.isArray(row)) throw invalid('table rows must be an array of arrays')
      return row.map((cell) => toRuns(cell ?? '', 'table cell'))
    })
    let columns = header ? header.length : 0
    for (const row of rows) if (row.length > columns) columns = row.length
    if (columns === 0) return

    const maxColumns = Math.floor(this.contentWidth / MIN_COLUMN_WIDTH)
    if (columns > maxColumns) {
      throw invalid(
        `a table with ${columns} columns does not fit the page width; at most ${maxColumns} fit`
      )
    }

    const size = this.size * 0.95
    const pad = Math.max(1, Math.min(5, (this.contentWidth / columns - 6) / 2))
    const scale = size / 1000
    const natural = new Array(columns).fill(0)
    const minimum = new Array(columns).fill(0)

    for (const row of header ? [header, ...rows] : rows) {
      row.forEach((runs, c) => {
        let total = 0
        for (const piece of this.pieces(runs, false)) {
          if (piece.newline) continue
          const w = this.measure(piece.font, piece.text) * scale
          total += w
          if (!piece.space) minimum[c] = Math.max(minimum[c], w)
        }
        natural[c] = Math.max(natural[c], total)
      })
    }

    const available = this.contentWidth - columns * 2 * pad
    const floor = minimum.map((w) => Math.min(w, available / columns))
    let widths
    const naturalTotal = natural.reduce((a, b) => a + b, 0)
    const floorSum = floor.reduce((a, b) => a + b, 0)
    if (naturalTotal <= available) {
      const weights = natural.map((w) => w + 12)
      const weightTotal = weights.reduce((a, b) => a + b, 0)
      widths = weights.map((w) => (w * available) / weightTotal)
    } else if (floorSum >= available) {
      widths = floor.map((w) => (w * available) / floorSum)
    } else {
      const floorTotal = floor.reduce((a, b) => a + b, 0)
      const extra = natural.map((w, c) => Math.max(0, w - floor[c]))
      const extraTotal = extra.reduce((a, b) => a + b, 0) || 1
      widths = floor.map((w, c) => w + ((available - floorTotal) * extra[c]) / extraTotal)
    }
    widths = widths.map((w) => w + 2 * pad)

    const lineHeight = this.lineHeight(size)
    const drawRow = (cells, shaded) => {
      const wrapped = widths.map((w, c) => this.wrap(cells[c] ?? [], size, w - 2 * pad))
      const offsets = new Array(columns).fill(0)
      let remaining = Math.max(...wrapped.map((lines) => lines.length))
      let first = true
      while (remaining > 0) {
        let fit = Math.floor((this.contentHeight - this.y - 2 * pad) / lineHeight)
        if (fit < 1 || (first && fit < Math.min(remaining, 2) && this.y > 0)) {
          this.newPage()
          if (header && cells !== header) drawRow(header, true)
          fit = Math.floor((this.contentHeight - this.y - 2 * pad) / lineHeight)
        }
        const count = Math.min(remaining, Math.max(1, fit))
        const height = count * lineHeight + 2 * pad
        let x = 0
        widths.forEach((w, c) => {
          this.page.push({
            type: 'rect',
            x: this.margin + x,
            y: this.top(this.y + height),
            width: w,
            height,
            fill: shaded ? HEADER_SHADE : undefined,
            stroke: RULE,
            lineWidth: 0.5
          })
          const lines = wrapped[c].slice(offsets[c], offsets[c] + count)
          lines.forEach((line, l) =>
            this.drawLine(line, x + pad, this.y + pad + l * lineHeight, size, INK)
          )
          offsets[c] += count
          x += w
        })
        this.y += height
        remaining -= count
        first = false
      }
    }

    this.ensure(lineHeight * (header ? 2 : 1) + 4 * pad)
    if (header) drawRow(header, true)
    for (const row of rows) drawRow(row, false)
    this.y += this.size * 0.8
  }

  block(block, next) {
    if (!block || !BLOCK_TYPES.has(block.type)) {
      throw invalid(
        `block type must be one of ${[...BLOCK_TYPES].join(', ')}, got '${block && block.type}'`
      )
    }
    if (block.type === 'pageBreak') {
      if (this.y > 0) this.newPage()
      return
    }
    if (block.type === 'heading') this.heading(block, next)
    else this[block.type](block)
  }

  finish() {
    const count = this.pages.length
    this.pages.forEach((items, index) => {
      if (this.pageNumbers) {
        const label = `${index + 1} / ${count}`
        const size = this.size * 0.8
        const width = this.measure(this.fonts[0], label) * (size / 1000)
        items.push({
          type: 'text',
          text: label,
          font: this.fonts[0],
          size,
          x: (this.width - width) / 2,
          y: Math.max(this.margin / 2, size * 0.25),
          color: MUTED
        })
      }
      this.doc.addPage({ width: this.width, height: this.height, at: index })
      this.doc.draw(index, items)
    })
  }
}

module.exports = function compose(doc, content, opts) {
  let blocks
  if (typeof content === 'string') blocks = parseMarkdown(content)
  else if (Array.isArray(content)) blocks = content
  else throw invalid('content must be a Markdown string or an array of blocks')

  const layout = new Layout(doc, opts)
  blocks.forEach((block, i) => layout.block(block, blocks[i + 1]))
  layout.finish()
  return layout.pages.length
}

module.exports.parseMarkdown = parseMarkdown
module.exports.decodeImage = decodeImage
module.exports.isDecoded = isDecoded
