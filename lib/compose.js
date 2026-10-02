const { invalid, failure } = require('./errors')

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

function isFontBytes(value) {
  return ArrayBuffer.isView(value) && value.byteLength > 0
}

function fontSources(font) {
  if (typeof font === 'string') {
    const family = FAMILIES[font]
    if (!family) {
      throw invalid(
        `font must be ${Object.keys(FAMILIES).join(', ')} or TrueType font bytes, got '${font}'`
      )
    }
    return family
  }
  if (isFontBytes(font)) return [font, font, font, font]
  if (font && typeof font === 'object' && isFontBytes(font.regular)) {
    const { regular, bold = regular, italic = regular, boldItalic = bold } = font
    for (const [name, value] of Object.entries({ bold, italic, boldItalic })) {
      if (!isFontBytes(value)) throw invalid(`font.${name} must be TrueType font bytes`)
    }
    return [regular, bold, italic, boldItalic]
  }
  throw invalid(
    'font must be a family name, TrueType font bytes, or { regular, bold, italic, boldItalic }'
  )
}

function pageSize(size, landscape) {
  let dimensions = size
  if (typeof size === 'string') {
    dimensions = PAGE_SIZES[size]
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
  /^!?\[((?:[^\]\\]|\\.)*)\]\(\s*(?:<[^>]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/
const BREAK = /^<br\s*\/?>/i

function parseInline(source) {
  let text = source
  const runs = []
  let bold = false
  let italic = false
  let buffer = ''

  const flush = () => {
    if (buffer) runs.push({ text: buffer, bold, italic })
    buffer = ''
  }
  const isSpace = (ch) => ch === undefined || /\s/.test(ch)
  const isWord = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)

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
        runs.push({ text: text.slice(i + 1, end), code: true, bold, italic })
        i = end
        continue
      }
    }

    if (ch === '<') {
      const match = BREAK.exec(text.slice(i))
      if (match) {
        buffer += '\n'
        i += match[0].length - 1
        continue
      }
    }

    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const match = LINK.exec(text.slice(i))
      if (match) {
        text = text.slice(0, i) + match[1] + text.slice(i + match[0].length)
        i--
        continue
      }
    }

    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const before = text[i - 1]
      const after = text[i + 2]
      const opens = !bold && !isSpace(after) && (ch === '*' || !isWord(before))
      const closes = bold && !isSpace(before) && (ch === '*' || !isWord(after))
      if (opens || closes) {
        flush()
        bold = !bold
      } else {
        buffer += ch + ch
      }
      i++
      continue
    }

    if (ch === '*' || ch === '_') {
      const before = text[i - 1]
      const after = text[i + 1]
      const opens = !italic && !isSpace(after) && (ch === '*' || !isWord(before))
      const closes = italic && !isSpace(before) && (ch === '*' || !isWord(after))
      if (opens || closes) {
        flush()
        italic = !italic
        continue
      }
    }

    buffer += ch
  }

  flush()
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
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const RULE_LINE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)\s*$/
const PAGE_BREAK = /^\s*\\(pagebreak|newpage)\s*$/

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
  return match ? Buffer.from(match[2], 'base64') : null
}

function startsBlock(line, next) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE_LINE.test(line) ||
    /^\s*>/.test(line) ||
    LIST_ITEM.test(line) ||
    PAGE_BREAK.test(line) ||
    IMAGE_LINE.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_DIVIDER.test(next))
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
      if (last && indent > last.indent && parent !== last.list) {
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
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++])
      i++
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      i++
      continue
    }

    if (PAGE_BREAK.test(line)) {
      blocks.push({ type: 'pageBreak' })
      i++
      continue
    }

    if (RULE_LINE.test(line)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }

    if (/^\s*>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i]))
        body.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'quote', text: body.join(' ').trim() })
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = splitRow(line)
      const rows = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim())
        rows.push(splitRow(lines[i++]))
      blocks.push({ type: 'table', header, rows })
      continue
    }

    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i)
      blocks.push(block)
      i = next
      continue
    }

    const image = IMAGE_LINE.exec(line)
    if (image) {
      const data = dataUri(image[2])
      blocks.push(
        data
          ? { type: 'image', data, caption: image[1] || undefined }
          : { type: 'paragraph', text: [{ text: `[${image[1] || 'image'}]`, italic: true }] }
      )
      i++
      continue
    }

    const body = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      const current = lines[i]
      const hardBreak = / {2,}$/.test(current) || /\\$/.test(current)
      body.push(current.replace(/\\$/, '').trim() + (hardBreak ? '\n' : ' '))
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

function decodeImage(bytes) {
  if (!ArrayBuffer.isView(bytes)) throw failure('IMAGE', 'image data must be PNG or JPEG bytes')
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    const size = jpegSize(data)
    if (!size || !size.width || !size.height)
      throw failure('IMAGE', 'JPEG image has no readable size')
    return { jpeg: 1, data, pixelWidth: size.width, pixelHeight: size.height }
  }

  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    png ??= require('bare-png')
    const decoded = png.decode(data)
    const pixels = decoded.width * decoded.height
    if (decoded.data.length !== pixels * 4)
      throw failure('IMAGE', 'PNG image did not decode to RGBA')
    return { jpeg: 0, data: decoded.data, pixelWidth: decoded.width, pixelHeight: decoded.height }
  }

  throw failure('IMAGE', 'image data must be PNG or JPEG bytes')
}

class Layout {
  constructor(doc, opts, prepareText) {
    const {
      pageSize: size = 'A4',
      landscape = false,
      margin = 56.69,
      font = 'Helvetica',
      fontSize = 11,
      lineHeight = 1.4,
      pageNumbers = false
    } = opts

    if (typeof margin !== 'number' || margin < 0) throw invalid('margin must be a number of points')
    if (typeof fontSize !== 'number' || fontSize < 4 || fontSize > 72) {
      throw invalid('fontSize must be between 4 and 72 points')
    }
    if (typeof lineHeight !== 'number' || lineHeight < 1 || lineHeight > 3) {
      throw invalid('lineHeight must be between 1 and 3')
    }

    this.doc = doc
    this.prepareText = prepareText
    ;[this.width, this.height] = pageSize(size, landscape)
    this.margin = margin
    this.contentWidth = this.width - 2 * margin
    this.contentHeight = this.height - 2 * margin
    if (this.contentWidth < 72 || this.contentHeight < 72)
      throw invalid('margin leaves no room on the page')

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
    const mono = opts.monoFont === undefined ? 'Courier' : opts.monoFont
    this.monoStandard = typeof mono === 'string'
    this.mono = fontSources(mono).slice(0, 2).map(load)

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
      const text = this.prepareText(run.text, standard).replace(/\t/g, preserve ? '    ' : ' ')
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
    if (block.type === 'heading' || block.type === 'image') return body * 2
    return 0
  }

  heading(block, next) {
    const level = block.level ?? 1
    if (!Number.isInteger(level) || level < 1 || level > 6)
      throw invalid('heading level must be 1 to 6')
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
    const indent = level * 18
    const marker = 16
    block.items.forEach((entry, i) => {
      const item = typeof entry === 'string' || Array.isArray(entry) ? { text: entry } : entry
      if (!item || item.text === undefined)
        throw invalid('list items must be strings or { text, items }')
      const label = block.ordered ? `${(block.start ?? 1) + i}.` : level % 2 ? '–' : '•'
      const labelFont = this.fonts[0]
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

  image(block) {
    const image = decodeImage(block.data)
    let width = typeof block.width === 'number' ? block.width : image.pixelWidth * 0.75
    width = Math.min(width, this.contentWidth)
    let height = (width * image.pixelHeight) / image.pixelWidth
    const captionHeight = block.caption ? this.lineHeight(this.size * 0.9) + 4 : 0
    const room = this.contentHeight - captionHeight
    if (height > room) {
      width *= room / height
      height = room
    }
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
    const columns = Math.max(header ? header.length : 0, ...rows.map((row) => row.length))
    if (columns === 0) return

    const size = this.size * 0.95
    const pad = 5
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
          y: this.margin / 2,
          color: MUTED
        })
      }
      this.doc.addPage({ width: this.width, height: this.height, at: index })
      this.doc.draw(index, items)
    })
  }
}

module.exports = function compose(doc, content, opts, prepareText) {
  let blocks
  if (typeof content === 'string') blocks = parseMarkdown(content)
  else if (Array.isArray(content)) blocks = content
  else throw invalid('content must be a Markdown string or an array of blocks')

  const layout = new Layout(doc, opts, prepareText)
  blocks.forEach((block, i) => layout.block(block, blocks[i + 1]))
  layout.finish()
  return layout.pages.length
}

module.exports.parseMarkdown = parseMarkdown
module.exports.decodeImage = decodeImage
