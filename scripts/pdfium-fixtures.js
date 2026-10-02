const fs = require('bare-fs')
const path = require('bare-path')
const png = require('bare-png')
const pdfium = require('..')

const [checkout] = Bare.argv.slice(2)

if (!checkout) {
  console.error('usage: bare scripts/pdfium-fixtures.js <pdfium checkout>')
  Bare.exit(1)
}

const pixel = path.join(checkout, 'testing', 'resources', 'pixel')
const out = path.join(__dirname, '..', 'test', 'fixtures', 'pdfium')

const before = new Set(fs.readdirSync(out).filter((f) => f.endsWith('.png')))

for (const f of before) {
  fs.unlinkSync(path.join(out, f))
  fs.rmSync(path.join(out, f.replace(/\.\d+\.png$/, '.pdf')), { force: true })
}

const after = new Set()
let skipped = 0

// PDFium expects these pages to render differently per platform, so one PNG cannot pin them everywhere.
const perPlatform = new Set()
for (const expected of fs.readdirSync(pixel)) {
  const match = expected.match(/^(.+)_expected_(?:agg_)?(?:mac|win|linux)\.pdf\.(\d+)\.png$/)
  if (match) perPlatform.add(`${match[1]}.${match[2]}`)
}

for (const expected of fs.readdirSync(pixel).sort()) {
  const match = expected.match(/^(.+)_expected\.pdf\.(\d+)\.png$/)
  if (!match) continue

  const [, name, page] = match
  if (perPlatform.has(`${name}.${page}`)) continue
  const pdf = load(name)
  if (pdf === null) continue

  const image = png.decode(fs.readFileSync(path.join(pixel, expected)))

  let actual
  try {
    const doc = pdfium.open(pdf)
    actual = doc.render(Number(page), { scale: 1 })
    doc.close()
  } catch {
    skipped++
    continue
  }

  if (
    actual.width !== image.width ||
    actual.height !== image.height ||
    !Buffer.from(actual.data).equals(image.data)
  ) {
    skipped++
    continue
  }

  const fixture = `${name}.${page}.png`
  fs.copyFileSync(path.join(pixel, expected), path.join(out, fixture))
  fs.writeFileSync(path.join(out, `${name}.pdf`), pdf)
  after.add(fixture)
}

fs.copyFileSync(path.join(checkout, 'LICENSE'), path.join(out, 'LICENSE'))

const added = [...after].filter((f) => !before.has(f))
const dropped = [...before].filter((f) => !after.has(f))

console.log(`${after.size} pages match PDFium's expected renders, ${skipped} do not`)
if (added.length) console.log(`added: ${added.join(' ')}`)
if (dropped.length) console.log(`dropped: ${dropped.join(' ')}`)

function load(name) {
  const pdf = path.join(pixel, `${name}.pdf`)
  if (fs.existsSync(pdf)) return fs.readFileSync(pdf)

  const template = path.join(pixel, `${name}.in`)
  if (!fs.existsSync(template)) return null

  const source = fs.readFileSync(template, 'latin1')
  if (source.includes('{{include')) return null

  return expand(source)
}

// Port of PDFium's testing/tools/fixup_pdf_template.py, without {{include}}.
function expand(source) {
  const lines = source.split(/(?<=\n)/)
  const lengths = []

  let state = 'start'
  for (const line of lines) {
    if (line.includes('{{streamlen}}')) {
      state = 'stream'
      lengths.push(0)
    } else if (state === 'stream' && line.trimEnd() === 'stream') {
      state = 'endstream'
    } else if (state === 'endstream') {
      if (line.trimEnd() === 'endstream') {
        state = 'start'
        lengths[lengths.length - 1] -= 1
      } else {
        lengths[lengths.length - 1] += line.length
      }
    }
  }

  const objects = new Map()
  let offset = 0
  let xref = 0
  let max = 0
  let result = ''

  for (let line of lines) {
    line = line.replace('{{header}}', '%PDF-1.7\n%\xa0\xf2\xa4\xf4')
    line = line.replace('{{streamlen}}', () => `/Length ${lengths.shift()}`)

    if (line.includes('{{xref}}')) {
      xref = offset
      line = `xref\n0 ${max + 1}\n`
      for (let i = 0; i <= max; i++) {
        const entry = objects.get(i)
        line += entry
          ? `${String(entry[0]).padStart(10, '0')} ${String(entry[1]).padStart(5, '0')} n \n`
          : '0000000000 65535 f \n'
      }
    }

    line = line.replace('{{trailer}}', `trailer <<\n  /Root 1 0 R\n  /Size ${max + 1}\n>>`)
    line = line.replace('{{trailersize}}', `/Size ${max + 1}`)
    line = line.replace('{{startxref}}', `startxref\n${xref}`)

    const object = line.match(/^{{object\s+(\d+)\s+(\d+)}}/)
    if (object) {
      objects.set(Number(object[1]), [offset, Number(object[2])])
      max = Math.max(max, Number(object[1]))
      line = line.replace(object[0], `${object[1]} ${object[2]} obj`)
    }

    const startxref = line.match(/^{{startxrefobj\s+(\d+)\s+(\d+)}}/)
    if (startxref) {
      line = line.replace(startxref[0], `startxref\n${objects.get(Number(startxref[1]))[0]}`)
    }

    offset += line.length
    result += line
  }

  return Buffer.from(result, 'latin1')
}
