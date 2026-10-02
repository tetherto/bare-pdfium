const { unsupportedText } = require('./errors')

const STANDARD_FONTS = new Set([
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique'
])

const WIN_ANSI = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split('').map((ch) => ch.codePointAt(0)))

function standardFontChar(code) {
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI.has(code)
}

const SUBSTITUTES = new Map(
  Object.entries({
    '→': '->',
    '⟶': '->',
    '⇒': '=>',
    '←': '<-',
    '⟵': '<-',
    '⇐': '<=',
    '↔': '<->',
    '⇔': '<=>',
    '↑': '^',
    '↓': 'v',
    '≥': '>=',
    '≤': '<=',
    '≠': '!=',
    '≈': '~',
    '∼': '~',
    '−': '-',
    '∗': '*',
    '∕': '/',
    '⁄': '/',
    '‐': '-',
    '‑': '-',
    '‒': '–',
    '―': '—',
    '′': "'",
    '″': '"',
    '‛': "'",
    '‟': '"',
    '◦': '•',
    '▪': '•',
    '▫': '•',
    '▸': '•',
    '▹': '•',
    '►': '•',
    '‣': '•',
    '●': '•',
    '○': '•',
    '■': '•',
    '□': '•',
    '◆': '•',
    '◇': '•',
    '⁃': '-',
    '∙': '·',
    '⋅': '·',
    '✓': 'v',
    '✔': 'v',
    '☑': 'v',
    '✅': 'v',
    '✗': 'x',
    '✘': 'x',
    '✕': 'x',
    '✖': 'x',
    '❌': 'x',
    '★': '*',
    '☆': '*',
    '⭐': '*',
    Ł: 'L',
    ł: 'l',
    Đ: 'D',
    đ: 'd',
    Ħ: 'H',
    ħ: 'h',
    ı: 'i',
    Ŧ: 'T',
    ŧ: 't',
    Ŀ: 'L',
    ŀ: 'l',
    ĸ: 'k'
  })
)

function isInvisibleOrEmoji(ch, code) {
  return (
    (code >= 0x200b && code <= 0x200d) ||
    code === 0x2060 ||
    code === 0xfeff ||
    code === 0x20e3 ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0x1f1e6 && code <= 0x1f1ff) ||
    (code >= 0x1f3fb && code <= 0x1f3ff) ||
    (code >= 0xe0000 && code <= 0xe01ef) ||
    /\p{Emoji_Presentation}/u.test(ch) ||
    (code >= 0x1f000 && /\p{Extended_Pictographic}/u.test(ch))
  )
}

function drawableText(text) {
  let out = ''
  for (const ch of text) {
    if (!isInvisibleOrEmoji(ch, ch.codePointAt(0))) out += ch
  }
  return out
}

function standardText(text) {
  let out = ''
  const missing = []
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0)
    if (ch === '\n' || ch === '\t' || standardFontChar(code)) {
      out += ch
      continue
    }
    const substitute = SUBSTITUTES.get(ch)
    if (substitute !== undefined) {
      out += substitute
      continue
    }
    if (isInvisibleOrEmoji(ch, code)) continue
    if (/\s/u.test(ch)) {
      out += ' '
      continue
    }
    const base = ch.normalize('NFKD').replace(/\p{M}/gu, '')
    if (base && [...base].every((c) => standardFontChar(c.codePointAt(0)))) {
      out += base
      continue
    }
    if (/[\p{L}\p{N}]/u.test(ch) && !missing.includes(ch)) missing.push(ch)
  }
  if (missing.length) {
    const named = missing
      .slice(0, 5)
      .map((ch) => `'${ch}' (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`)
      .join(', ')
    throw unsupportedText(
      `${named}${missing.length > 5 ? ' and more' : ''} cannot be drawn by the built-in fonts; pass a TrueType font that covers them`
    )
  }
  return out
}

function prepareText(text, standard) {
  return standard ? standardText(text) : drawableText(text)
}

module.exports = { STANDARD_FONTS, prepareText }
