const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const crypto = require('bare-crypto')
const addon = require('.')

// Assemble a PDF from object bodies with a correct xref, so no binary fixture
// has to be checked in. Latin1 keeps every byte 1:1 for the offset math.
function buildPdf(bodies, trailer = '') {
  let pdf = '%PDF-1.4\n'
  const offsets = []
  bodies.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

function textPdf() {
  const content = 'BT /F1 24 Tf 40 100 Td (Hello PDF) Tj ET'
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ])
}

// A page whose only content is a 2x2 image scaled to fill it — no text layer.
function imagePdf() {
  const draw = 'q 200 0 0 200 0 0 cm /Im0 Do Q'
  // 2x2 RGB: red, green, blue, white
  const px = '\xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\xff'
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>',
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${px.length} >>\nstream\n${px}\nendstream`
  ])
}

function formXObjectPdf() {
  const page = 'q 1 0 0 1 0 0 cm /Fm0 Do Q'
  const form = 'q 100 0 0 50 20 30 cm /Im0 Do Q BT /F1 12 Tf 20 120 Td (Inside a form) Tj ET'
  const px = '\xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\xff'
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Contents 4 0 R /Resources << /XObject << /Fm0 5 0 R >> >> >>',
    `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Matrix [2 0 0 2 10 10] /Resources << /XObject << /Im0 6 0 R >> /Font << /F1 7 0 R >> >> /Length ${form.length} >>\nstream\n${form}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${px.length} >>\nstream\n${px}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ])
}

function twoPageTextPdf() {
  const one = 'BT /F1 24 Tf 40 100 Td (Page One) Tj ET'
  const two = 'BT /F1 24 Tf 40 100 Td (Page Two) Tj ET'
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    `<< /Length ${one.length} >>\nstream\n${one}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    `<< /Length ${two.length} >>\nstream\n${two}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ])
}

function hyphenPdf() {
  const content = 'BT /F1 12 Tf 20 150 Td (the infer-) Tj 0 -14 Td (ence book) Tj ET'
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ])
}

function offPagePdf() {
  const content = 'BT /F1 12 Tf 20 100 Td (inside) Tj ET BT /F1 12 Tf 300 50 Td (outside) Tj ET'
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ])
}

function encryptedPdf() {
  const hash = '<' + 'ab'.repeat(32) + '>'
  return buildPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
      `<< /Filter /Standard /V 1 /R 2 /O ${hash} /U ${hash} /P -4 >>`
    ],
    `/Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] `
  )
}

test('pageCount: one-shot and via a handle agree', (t) => {
  t.is(addon.pageCount(textPdf()), 1)
  const doc = addon.open(textPdf())
  t.is(doc.pageCount(), 1)
  doc.close()
})

test('pageSize reports points without rendering', (t) => {
  const doc = addon.open(textPdf())
  t.alike(doc.pageSize(0), { width: 200, height: 200 })
  doc.close()
})

test('render returns RGBA sized by scale, white background', (t) => {
  const { width, height, data } = addon.render(textPdf(), 0, { scale: 2 })
  t.is(width, 400)
  t.is(height, 400)
  t.is(data.length, width * height * 4)
  t.alike([data[0], data[1], data[2], data[3]], [255, 255, 255, 255])
})

test('pageFlags classifies a text page', (t) => {
  const doc = addon.open(textPdf())
  t.alike(doc.pageFlags(0), { hasImage: false, hasText: true })
  t.is(doc.extractImages(0).length, 0, 'a text page yields no images')
  doc.close()
})

test('pageFlags and extractImages find a page image', (t) => {
  const doc = addon.open(imagePdf())
  const flags = doc.pageFlags(0)
  t.is(flags.hasImage, true, 'the full-page image is detected')
  t.is(flags.hasText, false, 'an image-only page has no text layer')
  const images = doc.extractImages(0)
  t.ok(images.length >= 1, 'the embedded image is extracted')
  const [first] = images
  t.is(first.data.length, first.width * first.height * 4, 'extracted image is RGBA')
  doc.close()
})

test('extractImages reports where each image sits on the page', (t) => {
  const doc = addon.open(imagePdf())
  const [image] = doc.extractImages(0)
  t.alike(image.bounds, { x: 0, y: 0, width: 200, height: 200 })
  doc.close()
})

test('pageFlags and extractImages look inside form XObjects', (t) => {
  const doc = addon.open(formXObjectPdf())
  t.alike(doc.pageFlags(0), { hasImage: true, hasText: true })
  const images = doc.extractImages(0)
  t.is(images.length, 1, 'the image drawn by the form is found')
  t.alike(
    images[0].bounds,
    { x: 50, y: 70, width: 200, height: 100 },
    'bounds include the form matrix'
  )
  doc.close()
})

test('pageFlags hasText agrees with the text layer on every fixture page', (t) => {
  const path = require('bare-path')
  let pages = 0
  for (const dir of ['test/fixtures/pdfium', 'test/fixtures/hostile']) {
    for (const name of fs
      .readdirSync(path.join(__dirname, dir))
      .filter((f) => f.endsWith('.pdf'))) {
      let doc
      try {
        doc = addon.open(fs.readFileSync(path.join(__dirname, dir, name)))
      } catch {
        continue
      }
      for (let page = 0; page < Math.min(doc.pageCount(), 20); page++) {
        let flags, text
        try {
          flags = doc.pageFlags(page)
          text = doc.extractText(page, { hyphens: 'raw' })
        } catch {
          continue
        }
        pages++
        if (flags.hasText !== text.length > 0) {
          t.fail(`${name} page ${page}: hasText ${flags.hasText}`)
        }
      }
      doc.close()
    }
  }
  t.ok(pages > 100, `${pages} pages agree`)
})

test('extractText returns the page text layer', (t) => {
  const doc = addon.open(textPdf())
  t.ok(doc.extractText(0).includes('Hello PDF'), 'the drawn text is extracted')
  doc.close()
})

test('extractText is empty for a page with no text layer', (t) => {
  const doc = addon.open(imagePdf())
  t.is(doc.extractText(0), '', 'an image-only page yields no text')
  doc.close()
})

test('extractText rejects an out-of-range page', (t) => {
  const doc = addon.open(textPdf())
  t.exception.all(() => doc.extractText(5))
  doc.close()
})

test('textPages streams every page in order', (t) => {
  const doc = addon.open(twoPageTextPdf())
  const pages = [...doc.textPages()]
  t.is(pages.length, 2)
  t.is(pages[0].page, 0)
  t.ok(pages[0].text.includes('Page One'), 'first page text')
  t.is(pages[1].page, 1)
  t.ok(pages[1].text.includes('Page Two'), 'second page text')
  doc.close()
})

test('textPages one-shot opens and closes around the stream', (t) => {
  const pages = [...addon.textPages(twoPageTextPdf())]
  t.is(pages.length, 2)
  t.ok(pages[1].text.includes('Page Two'), 'reaches the last page')
})

test('openFile reads a PDF from disk on demand', (t) => {
  const file = `${os.tmpdir()}/bare-pdfium-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`
  fs.writeFileSync(file, twoPageTextPdf())
  try {
    const doc = addon.openFile(file)
    t.is(doc.pageCount(), 2, 'reads the page count')
    t.ok(doc.extractText(0).includes('Page One'), 'reads page text')
    t.is([...doc.textPages()].length, 2, 'streams both pages')
    doc.close()
  } finally {
    fs.unlinkSync(file)
  }
})

test('openFile throws on a missing path', (t) => {
  t.exception(() => addon.openFile(`${os.tmpdir()}/bare-pdfium-does-not-exist.pdf`))
})

test('open accepts a password on an unencrypted PDF', (t) => {
  const doc = addon.open(textPdf(), { password: 'unused' })
  t.is(doc.pageCount(), 1)
  doc.close()
})

test('close is idempotent', (t) => {
  const doc = addon.open(textPdf())
  doc.close()
  doc.close()
  t.pass('a second close does not throw')
})

test('render does not deadlock when a GC finalizes unclosed documents', (t) => {
  for (let i = 0; i < 200; i++) addon.open(textPdf())
  for (let i = 0; i < 100; i++) addon.render(textPdf(), 0, { scale: 10 })
  t.pass()
})

test('render rejects an out-of-range page', (t) => {
  t.exception.all(() => addon.render(textPdf(), 5, { scale: 1 }))
})

test('extractText joins a word hyphenated across a line break by default', (t) => {
  const doc = addon.open(hyphenPdf())
  const text = doc.extractText(0)
  t.ok(text.includes('inference'), 'the word is rejoined')
  t.absent(text.includes('\uFFFE'), 'no U+FFFE marker is left')
  doc.close()
})

test('extractText hyphens option keeps or passes through the marker', (t) => {
  const doc = addon.open(hyphenPdf())
  t.ok(doc.extractText(0, { hyphens: 'keep' }).includes('infer-ence'), 'keep restores the hyphen')
  t.ok(doc.extractText(0, { hyphens: 'raw' }).includes('infer\uFFFEence'), 'raw is untouched')
  t.exception.all(() => doc.extractText(0, { hyphens: 'nope' }), /hyphens must be/)
  doc.close()
})

test('extractText clip drops text outside the page box', (t) => {
  const doc = addon.open(offPagePdf())
  t.ok(doc.extractText(0).includes('outside'), 'unclipped text includes off-page text')
  const clipped = doc.extractText(0, { clip: true })
  t.ok(clipped.includes('inside'), 'on-page text is kept')
  t.absent(clipped.includes('outside'), 'off-page text is dropped')
  doc.close()
})

test('extractText clip handles the hyphen marker like the unclipped path', (t) => {
  const doc = addon.open(hyphenPdf())
  t.ok(doc.extractText(0, { clip: true }).includes('inference'), 'join rejoins the word')
  t.ok(
    doc.extractText(0, { clip: true, hyphens: 'keep' }).includes('infer-ence'),
    'keep restores the hyphen'
  )
  t.ok(
    doc.extractText(0, { clip: true, hyphens: 'raw' }).includes('infer\uFFFEence'),
    'raw carries U+FFFE'
  )
  t.absent(
    doc.extractText(0, { clip: true, hyphens: 'raw' }).includes('\u0002'),
    'no U+0002 is left'
  )
  doc.close()
})

test('extractText clip is empty for a page with no text layer', (t) => {
  const doc = addon.open(imagePdf())
  t.is(doc.extractText(0, { clip: true }), '')
  doc.close()
})

test('open reports FORMAT for bytes that are not a PDF', (t) => {
  try {
    addon.open(Buffer.from('not a pdf'))
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'FORMAT')
  }
})

test('open reports PASSWORD for an encrypted PDF without its password', (t) => {
  try {
    addon.open(encryptedPdf())
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'PASSWORD')
  }
})

test('openFile reports FILE for a missing path', (t) => {
  try {
    addon.openFile(`${os.tmpdir()}/bare-pdfium-does-not-exist.pdf`)
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'FILE')
  }
})

test('extractTextAsync matches extractText', async (t) => {
  const doc = addon.open(hyphenPdf())
  t.is(await doc.extractTextAsync(0), doc.extractText(0))
  t.is(await doc.extractTextAsync(0, { hyphens: 'raw' }), doc.extractText(0, { hyphens: 'raw' }))
  doc.close()
})

test('extractTextAsync with clip drops off-page text', async (t) => {
  const doc = addon.open(offPagePdf())
  t.absent((await doc.extractTextAsync(0, { clip: true })).includes('outside'))
  doc.close()
})

test('extractTextAsync with clip handles the hyphen marker', async (t) => {
  const doc = addon.open(hyphenPdf())
  for (const hyphens of ['join', 'keep', 'raw']) {
    t.is(
      await doc.extractTextAsync(0, { clip: true, hyphens }),
      doc.extractText(0, { hyphens }),
      hyphens
    )
  }
  doc.close()
})

test('renderAsync matches render', async (t) => {
  const doc = addon.open(textPdf())
  const expected = doc.render(0, { scale: 2 })
  const actual = await doc.renderAsync(0, { scale: 2 })
  t.is(actual.width, expected.width)
  t.is(actual.height, expected.height)
  t.ok(Buffer.compare(actual.data, expected.data) === 0, 'same pixels')
  doc.close()
})

function busyDoc() {
  const doc = addon.create()
  doc.addPage({ width: 600, height: 600 })
  const items = []
  for (let i = 0; i < 40000; i++) {
    items.push({
      type: 'rect',
      x: (i * 7) % 590,
      y: (i * 13) % 590,
      width: 6,
      height: 6,
      fill: [i % 255, 80, 160],
      opacity: 0.5
    })
  }
  doc.draw(0, items)
  return doc
}

test('render clip draws one region at the full-page scale', (t) => {
  const doc = busyDoc()
  const full = doc.render(0, { scale: 2 })
  const tile = doc.render(0, { scale: 2, clip: { x: 100, y: 200, width: 150, height: 100 } })
  t.alike([tile.width, tile.height], [300, 200])
  let same = true
  for (let y = 0; y < tile.height && same; y++) {
    const row = tile.data.subarray(y * tile.width * 4, (y + 1) * tile.width * 4)
    const start = ((y + 600) * full.width + 200) * 4
    same = row.equals(full.data.subarray(start, start + tile.width * 4))
  }
  t.ok(same, 'the tile matches the same crop of a full render')
  doc.close()
})

test('render clip validates its box', (t) => {
  const doc = addon.open(textPdf())
  t.exception.all(
    () => doc.render(0, { clip: { x: 0, y: 0, width: 0, height: 10 } }),
    /greater than 0/
  )
  t.exception.all(() => doc.render(0, { clip: { x: 'a', y: 0, width: 5, height: 10 } }), /clip x/)
  t.exception.all(() => doc.render(0, { clip: 5 }), /clip must be an object/)
  doc.close()
})

test('renderAsync with a signal renders the same pixels', async (t) => {
  const { AbortController } = require('bare-abort-controller')
  const doc = busyDoc()
  const plain = doc.render(0, { scale: 1 })
  const signalled = await doc.renderAsync(0, { scale: 1, signal: new AbortController().signal })
  t.ok(plain.data.equals(signalled.data))
  doc.close()
})

test('renderAsync rejects with ABORTED when its signal aborts', async (t) => {
  const { AbortController } = require('bare-abort-controller')
  const doc = busyDoc()

  const early = new AbortController()
  early.abort(new Error('before'))
  await t.exception(doc.renderAsync(0, { signal: early.signal }), /aborted/)

  const queued = new AbortController()
  const first = doc.renderAsync(0, { scale: 3 })
  const second = doc.renderAsync(0, { scale: 3, signal: queued.signal })
  queued.abort(new Error('scrolled away'))
  await first
  const err = await second.catch((e) => e)
  t.is(err.code, 'ABORTED', 'a queued render is skipped')
  t.is(err.cause.message, 'scrolled away', 'the reason is kept as the cause')

  const running = new AbortController()
  const started = Date.now()
  const pending = doc.renderAsync(0, { scale: 4, signal: running.signal })
  setTimeout(() => running.abort(), 5)
  const stopped = await pending.catch((e) => e)
  t.is(stopped.code, 'ABORTED', `a running render stops (after ${Date.now() - started} ms)`)

  await t.exception.all(doc.renderAsync(0, { signal: {} }), /AbortSignal/)
  doc.close()
})

test('async calls reject on an out-of-range page', async (t) => {
  const doc = addon.open(textPdf())
  await t.exception.all(doc.extractTextAsync(5))
  await t.exception.all(doc.renderAsync(5))
  doc.close()
})

test('async calls interleave with sync calls and other documents', async (t) => {
  const one = addon.open(twoPageTextPdf())
  const two = addon.open(textPdf())
  const jobs = []
  for (let i = 0; i < 20; i++) {
    jobs.push(one.extractTextAsync(i % 2), two.renderAsync(0), two.extractTextAsync(0))
    t.ok(one.extractText(1).includes('Page Two'))
  }
  const results = await Promise.all(jobs)
  t.ok(results[0].includes('Page One'))
  t.ok(results[3].includes('Page Two'))
  t.is(results[1].width, 200)
  t.ok(results[2].includes('Hello PDF'))
  one.close()
  two.close()
})

test('async calls queued before close reject instead of crashing', async (t) => {
  const doc = addon.open(textPdf())
  const text = doc.extractTextAsync(0)
  const image = doc.renderAsync(0)
  doc.close()
  await t.exception(text, /document is closed/)
  await t.exception(image, /document is closed/)
  await t.exception(doc.extractTextAsync(0), /document is closed/)
})

test('textPagesAsync streams every page in order', async (t) => {
  const doc = addon.open(twoPageTextPdf())
  const pages = []
  for await (const page of doc.textPagesAsync()) pages.push(page)
  t.is(pages.length, 2)
  t.ok(pages[0].text.includes('Page One'))
  t.ok(pages[1].text.includes('Page Two'))
  doc.close()
})

function sizedPdf(width, height, text) {
  const content = `BT /F1 12 Tf 10 10 Td (${text}) Tj ET`
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ])
}

function formPdf() {
  const on = '0 g 2 2 11 11 re f'
  const widget = '/Type /Annot /Subtype /Widget /P 3 0 R /F 4'
  const states = (name) => `/AP << /N << /${name} 10 0 R /Off 11 0 R >> >>`
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R 6 0 R 9 0 R 13 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 12 0 R >> >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Annots [4 0 R 5 0 R 7 0 R 8 0 R 9 0 R 13 0 R] >>',
    `<< ${widget} /FT /Tx /T (name) /Rect [20 250 200 270] /DA (/Helv 12 Tf 0 g) >>`,
    `<< ${widget} /FT /Btn /T (agree) /Rect [20 220 35 235] /V /Off /AS /Off ${states('Yes')} >>`,
    '<< /FT /Btn /Ff 49152 /T (color) /V /Off /Kids [7 0 R 8 0 R] >>',
    `<< ${widget} /Parent 6 0 R /Rect [20 190 35 205] /AS /Off ${states('red')} >>`,
    `<< ${widget} /Parent 6 0 R /Rect [50 190 65 205] /AS /Off ${states('blue')} >>`,
    `<< ${widget} /FT /Ch /Ff 131072 /T (size) /Opt [(S) (M) (L)] /Rect [20 150 120 170] /DA (/Helv 12 Tf 0 g) >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 15 15] /Length ${on.length} >>\nstream\n${on}\nendstream`,
    '<< /Type /XObject /Subtype /Form /BBox [0 0 15 15] /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< ${widget} /FT /Tx /T (id) /Ff 1 /V (A-1) /Rect [20 120 200 140] /DA (/Helv 12 Tf 0 g) >>`
  ])
}

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = Buffer.alloc(data.length)
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255
    j = (j + s[i]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255]
  }
  return out
}

function md5(...parts) {
  return crypto.createHash('md5').update(Buffer.concat(parts)).digest()
}

function lockedPdf(password) {
  const padding = Buffer.from(
    '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
    'hex'
  )
  const pad = (text) => Buffer.concat([Buffer.from(text, 'latin1'), padding]).subarray(0, 32)
  const id = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  const permissions = Buffer.alloc(4)
  permissions.writeInt32LE(-4)

  const owner = rc4(md5(pad('owner')).subarray(0, 5), pad(password))
  const key = md5(pad(password), owner, permissions, id).subarray(0, 5)
  const user = rc4(key, padding)

  const content = Buffer.from('BT /F1 24 Tf 40 100 Td (Secret) Tj ET', 'latin1')
  const objectKey = md5(key, Buffer.from([4, 0, 0, 0, 0])).subarray(0, 10)
  const stream = rc4(objectKey, content).toString('latin1')

  return buildPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`
    ],
    `/Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] `
  )
}

function pageTexts(pdf, opts) {
  return [...addon.textPages(pdf, opts)].map(({ text }) => text)
}

test('create and importPages build a document from other documents', (t) => {
  const merged = addon.create()
  t.is(merged.pageCount(), 0)
  const one = addon.open(twoPageTextPdf())
  const two = addon.open(textPdf())
  merged.importPages(one, { pages: [1] })
  merged.importPages(two)
  merged.importPages(one, { pages: [0], at: 0 })
  one.close()
  two.close()
  const texts = pageTexts(merged.save())
  merged.close()
  t.is(texts.length, 3)
  t.ok(texts[0].includes('Page One'))
  t.ok(texts[1].includes('Page Two'))
  t.ok(texts[2].includes('Hello PDF'))
})

test('merge concatenates PDFs in order', (t) => {
  const texts = pageTexts(addon.merge([textPdf(), twoPageTextPdf()]))
  t.is(texts.length, 3)
  t.ok(texts[0].includes('Hello PDF'))
  t.ok(texts[2].includes('Page Two'))
})

test('merge rejects an empty list', (t) => {
  t.exception.all(() => addon.merge([]), /array of PDFs/)
})

test('extractPages keeps and reorders the chosen pages', (t) => {
  const texts = pageTexts(addon.extractPages(twoPageTextPdf(), [1, 0]))
  t.is(texts.length, 2)
  t.ok(texts[0].includes('Page Two'))
  t.ok(texts[1].includes('Page One'))
})

test('extractPages rejects an out-of-range page', (t) => {
  t.exception.all(() => addon.extractPages(textPdf(), [3]), /out of range/)
})

test('rotate turns pages clockwise and adds to the existing rotation', (t) => {
  const once = addon.rotate(sizedPdf(200, 100, 'wide'), 90)
  t.alike(addon.open(once).pageSize(0), { width: 100, height: 200 })
  const twice = addon.rotate(once, -90)
  t.alike(addon.open(twice).pageSize(0), { width: 200, height: 100 })
  t.ok(pageTexts(once)[0].includes('wide'), 'content is kept')
})

test('rotate only touches the pages it is given', (t) => {
  const doc = addon.open(addon.merge([sizedPdf(200, 100, 'a'), sizedPdf(200, 100, 'b')]))
  doc.rotate(180, { pages: [1] })
  const rotated = addon.open(doc.save())
  doc.close()
  t.alike(rotated.pageSize(0), { width: 200, height: 100 })
  t.alike(rotated.pageSize(1), { width: 200, height: 100 })
  rotated.close()
})

test('rotate rejects angles that are not a multiple of 90', (t) => {
  t.exception.all(() => addon.rotate(textPdf(), 45), /multiple of 90/)
})

test('decrypt removes the password from an encrypted PDF', (t) => {
  const locked = lockedPdf('s3cret')
  try {
    addon.open(locked)
    t.fail('the fixture should need its password')
  } catch (err) {
    t.is(err.code, 'PASSWORD')
  }
  const unlocked = addon.decrypt(locked, 's3cret')
  t.ok(pageTexts(unlocked)[0].includes('Secret'), 'opens without a password')
})

test('decrypt reports PASSWORD for a wrong password', (t) => {
  try {
    addon.decrypt(lockedPdf('s3cret'), 'nope')
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'PASSWORD')
  }
})

test('save keeps the encryption unless asked to remove it', (t) => {
  const doc = addon.open(lockedPdf('s3cret'), { password: 's3cret' })
  const saved = doc.save()
  doc.close()
  t.exception(() => addon.open(saved), 'still needs the password')
  t.ok(pageTexts(saved, { password: 's3cret' })[0].includes('Secret'))
})

test('watermark stamps text on every page', (t) => {
  const stamped = addon.watermark(twoPageTextPdf(), 'DRAFT')
  const texts = pageTexts(stamped)
  t.ok(texts[0].includes('DRAFT') && texts[0].includes('Page One'))
  t.ok(texts[1].includes('DRAFT') && texts[1].includes('Page Two'))
})

test('watermark can target pages and go under the content', (t) => {
  const stamped = addon.watermark(twoPageTextPdf(), 'COPY', {
    pages: [1],
    position: 'under',
    size: 30
  })
  const texts = pageTexts(stamped)
  t.absent(texts[0].includes('COPY'))
  t.ok(texts[1].includes('COPY'))
})

test('watermark is drawn inside the page and changes its pixels', (t) => {
  const pdf = sizedPdf(300, 200, 'x')
  const before = addon.render(pdf, 0).data
  const after = addon.render(addon.watermark(pdf, 'DRAFT', { opacity: 1, color: [255, 0, 0] }), 0)
  let red = 0
  for (let i = 0; i < after.data.length; i += 4) {
    if (after.data[i] > 200 && after.data[i + 1] < 80 && before[i + 1] > 200) red++
  }
  t.ok(red > 500, `the stamp paints red pixels (${red})`)
})

test('watermark validates its options', (t) => {
  t.exception.all(() => addon.watermark(textPdf(), ''), /non-empty/)
  t.exception.all(() => addon.watermark(textPdf(), 'x', { position: 'side' }), /position/)
  t.exception.all(() => addon.watermark(textPdf(), 'x', { opacity: 2 }), /opacity/)
  t.exception.all(() => addon.watermark(textPdf(), '草稿'), /TrueType font/)
  t.exception.all(() => addon.watermark(textPdf(), '🌿🌿'), /nothing that can be drawn/)
  t.ok(pageTexts(addon.watermark(textPdf(), '🌿 DRAFT'))[0].includes('DRAFT'), 'emoji are dropped')
})

test('fields lists the form with types, values and options', (t) => {
  const fields = addon.fields(formPdf())
  t.alike(
    fields.map(({ name, type }) => [name, type]),
    [
      ['name', 'text'],
      ['agree', 'checkbox'],
      ['color', 'radio'],
      ['size', 'combobox'],
      ['id', 'text']
    ]
  )
  const byName = Object.fromEntries(fields.map((field) => [field.name, field]))
  t.is(byName.agree.value, false)
  t.alike(byName.color.options, ['red', 'blue'])
  t.is(byName.color.value, null)
  t.alike(byName.size.options, ['S', 'M', 'L'])
  t.is(byName.id.value, 'A-1')
  t.is(byName.id.readOnly, true)
})

test('fields is empty for a PDF without a form', (t) => {
  t.alike(addon.fields(textPdf()), [])
})

test('fillFields sets text, checkbox, radio and dropdown values', (t) => {
  const filled = addon.fillFields(formPdf(), {
    name: 'Ada Lovelace',
    agree: true,
    color: 'blue',
    size: 'M'
  })
  const byName = Object.fromEntries(addon.fields(filled).map((field) => [field.name, field]))
  t.is(byName.name.value, 'Ada Lovelace')
  t.is(byName.agree.value, true)
  t.is(byName.color.value, 'blue')
  t.is(byName.size.value, 'M')
  t.is(byName.id.value, 'A-1', 'untouched fields keep their value')
})

test('fillFields can clear a checkbox and change a radio choice', (t) => {
  const first = addon.fillFields(formPdf(), { agree: true, color: 'red' })
  const second = addon.fillFields(first, { agree: false, color: 'blue' })
  const byName = Object.fromEntries(addon.fields(second).map((field) => [field.name, field]))
  t.is(byName.agree.value, false)
  t.is(byName.color.value, 'blue')
})

test('fillFields explains bad input', (t) => {
  t.exception.all(() => addon.fillFields(formPdf(), { nope: 'x' }), /no field named 'nope'/)
  t.exception.all(() => addon.fillFields(formPdf(), { id: 'B-2' }), /read-only/)
  t.exception.all(() => addon.fillFields(formPdf(), { color: 'green' }), /radio group/)
  t.exception.all(() => addon.fillFields(formPdf(), { size: 'XL' }), /accepts one of/)
  t.exception.all(() => addon.fillFields(textPdf(), { name: 'x' }), /no form fields/)
})

test('edit methods throw once the document is closed', (t) => {
  const doc = addon.open(textPdf())
  doc.close()
  t.exception.all(() => doc.save(), /document is closed/)
  t.exception.all(() => doc.rotate(90), /document is closed/)
  t.exception.all(() => doc.fields(), /document is closed/)
})

test('async edits match their sync forms', async (t) => {
  t.alike(
    pageTexts(await addon.mergeAsync([textPdf(), twoPageTextPdf()])),
    pageTexts(addon.merge([textPdf(), twoPageTextPdf()]))
  )
  t.alike(
    pageTexts(await addon.extractPagesAsync(twoPageTextPdf(), [1, 0])),
    pageTexts(addon.extractPages(twoPageTextPdf(), [1, 0]))
  )

  const rotated = await addon.rotateAsync(sizedPdf(200, 100, 'wide'), 90)
  t.alike(addon.open(rotated).pageSize(0), { width: 100, height: 200 })

  t.ok(pageTexts(await addon.watermarkAsync(twoPageTextPdf(), 'DRAFT'))[1].includes('DRAFT'))
  t.ok(pageTexts(await addon.decryptAsync(lockedPdf('s3cret'), 's3cret'))[0].includes('Secret'))

  t.alike(await addon.fieldsAsync(formPdf()), addon.fields(formPdf()))
  const values = { name: 'Ada Lovelace', agree: true, color: 'blue', size: 'M' }
  t.alike(
    addon.fields(await addon.fillFieldsAsync(formPdf(), values)),
    addon.fields(addon.fillFields(formPdf(), values))
  )
})

test('Doc async edits apply in the order they were called', async (t) => {
  const doc = addon.create()
  const source = addon.open(twoPageTextPdf())
  const steps = [
    doc.importPagesAsync(source, { pages: [1] }),
    doc.importPagesAsync(source, { pages: [0], at: 0 }),
    doc.rotateAsync(90, { pages: [1] }),
    doc.watermarkAsync('COPY', { pages: [0] })
  ]
  await Promise.all(steps)
  const saved = await doc.saveAsync()
  doc.close()
  source.close()
  const texts = pageTexts(saved)
  t.ok(texts[0].includes('Page One') && texts[0].includes('COPY'))
  t.ok(texts[1].includes('Page Two') && !texts[1].includes('COPY'))
})

test('fillFieldsAsync returns the filled fields', async (t) => {
  const doc = addon.open(formPdf())
  const filled = await doc.fillFieldsAsync({ name: 'Grace Hopper', size: 'L' })
  t.alike(
    filled.map(({ name, value }) => [name, value]),
    [
      ['name', 'Grace Hopper'],
      ['size', 'L']
    ]
  )
  doc.close()
})

test('fillFieldsAsync keeps its place in the queue', async (t) => {
  const doc = addon.open(formPdf())
  const filling = doc.fillFieldsAsync({ name: 'Ada Lovelace' })
  const saved = await doc.saveAsync()
  await filling
  doc.close()
  const name = addon.fields(saved).find((field) => field.name === 'name')
  t.is(name.value, 'Ada Lovelace', 'the save made after the fill sees the filled value')
})

test('async edits reject bad input instead of throwing', async (t) => {
  const rejection = (promise) =>
    promise.then(
      () => null,
      (err) => err.message
    )
  const doc = addon.open(textPdf())
  const pending = doc.rotateAsync(45)
  t.ok(pending instanceof Promise, 'a validation error still returns a promise')
  t.ok(/multiple of 90/.test(await rejection(pending)))
  t.ok(/non-empty/.test(await rejection(doc.watermarkAsync(''))))
  t.ok(
    /out of range/.test(
      await rejection(doc.importPagesAsync(addon.open(textPdf()), { pages: [4] }))
    )
  )
  t.ok(/no form fields/.test(await rejection(doc.fillFieldsAsync({ name: 'x' }))))
  t.ok(/array of PDFs/.test(await rejection(addon.mergeAsync([]))))
  t.ok(/password/.test(await rejection(addon.decryptAsync(lockedPdf('s3cret'), 'nope'))))
  doc.close()
})

test('async edits queued before close reject instead of crashing', async (t) => {
  const doc = addon.open(twoPageTextPdf())
  const rotate = doc.rotateAsync(90)
  const save = doc.saveAsync()
  const fields = doc.fieldsAsync()
  doc.close()
  const rejection = (promise) =>
    promise.then(
      () => null,
      (err) => err.message
    )
  t.is(await rejection(rotate), 'document is closed')
  t.is(await rejection(save), 'document is closed')
  t.is(await rejection(fields), 'document is closed')
  t.is(await rejection(doc.saveAsync()), 'document is closed')

  const target = addon.create()
  const source = addon.open(textPdf())
  const imported = target.importPagesAsync(source)
  source.close()
  t.is(await rejection(imported), 'document is closed')
  target.close()
})

test('async edits interleave with async reads on other documents', async (t) => {
  const reader = addon.open(twoPageTextPdf())
  const jobs = []
  for (let i = 0; i < 10; i++) {
    jobs.push(
      addon.watermarkAsync(textPdf(), `W${i}`),
      reader.extractTextAsync(i % 2),
      reader.renderAsync(0)
    )
  }
  const results = await Promise.all(jobs)
  t.ok(pageTexts(results[0])[0].includes('W0'))
  t.ok(pageTexts(results[27])[0].includes('W9'))
  t.ok(results[1].includes('Page One'))
  t.is(results[2].width, 200)
  reader.close()
})

function objectStreamPdf() {
  const content = 'BT /F1 24 Tf 40 100 Td (Packed) Tj ET'
  const packed = [
    '<< /Type /Catalog /Pages 3 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 200 200] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>'
  ]
  let index = ''
  let body = ''
  packed.forEach((object, i) => {
    index += `${i + 2} ${body.length} `
    body += object + '\n'
  })
  const objstm = index + body

  let pdf = '%PDF-1.5\n'
  const offsets = {}
  const add = (number, text) => {
    offsets[number] = pdf.length
    pdf += `${number} 0 obj\n${text}\nendobj\n`
  }
  add(
    1,
    `<< /Type /ObjStm /N 3 /First ${index.length} /Length ${objstm.length} >>\nstream\n${objstm}\nendstream`
  )
  add(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  add(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  const row = (type, a, b) =>
    String.fromCharCode(
      type,
      (a >>> 24) & 255,
      (a >>> 16) & 255,
      (a >>> 8) & 255,
      a & 255,
      (b >>> 8) & 255,
      b & 255
    )
  const xrefOffset = pdf.length
  const rows =
    row(0, 0, 65535) +
    row(1, offsets[1], 0) +
    row(2, 1, 0) +
    row(2, 1, 1) +
    row(2, 1, 2) +
    row(1, offsets[5], 0) +
    row(1, offsets[6], 0) +
    row(1, xrefOffset, 0)
  pdf += `7 0 obj\n<< /Type /XRef /Size 8 /W [1 4 2] /Root 2 0 R /Length ${rows.length} >>\nstream\n${rows}\nendstream\nendobj\n`
  pdf += `startxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

function rejection(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  return null
}

test('encrypt locks a PDF behind a password', (t) => {
  const locked = addon.encrypt(twoPageTextPdf(), 'open sesame')
  t.is(rejection(() => addon.open(locked)).code, 'PASSWORD', 'needs the password')
  t.is(
    rejection(() => addon.open(locked, { password: 'wrong' })).code,
    'PASSWORD',
    'refuses a wrong one'
  )
  const texts = pageTexts(locked, { password: 'open sesame' })
  t.ok(texts[0].includes('Page One') && texts[1].includes('Page Two'), 'content survives')
})

test('encrypt keeps pages identical to the original', (t) => {
  const original = addon.render(imagePdf(), 0, { scale: 1 }).data
  const locked = addon.render(addon.encrypt(imagePdf(), 'pw'), 0, { scale: 1, password: 'pw' }).data
  t.ok(Buffer.compare(original, locked) === 0)
})

test('the owner password also opens an encrypted PDF', (t) => {
  const locked = addon.encrypt(textPdf(), 'user', { ownerPassword: 'owner' })
  t.ok(pageTexts(locked, { password: 'owner' })[0].includes('Hello PDF'))
  t.ok(pageTexts(locked, { password: 'user' })[0].includes('Hello PDF'))
})

test('permissions are written into the encryption settings', (t) => {
  const pFlag = (pdf) => Number(/\/P (-?\d+)/.exec(pdf.toString('latin1'))[1])
  t.is(pFlag(addon.encrypt(textPdf(), 'pw')), -4, 'everything allowed by default')
  t.is(
    pFlag(addon.encrypt(textPdf(), 'pw', { permissions: { copy: false, print: false } })) &
      (1 << 9),
    1 << 9,
    'bit 10 is always set, as PDF 2.0 requires'
  )
  t.exception.all(
    () => addon.encrypt(textPdf(), 'pw', { permissions: { extract: false } }),
    /unknown permission 'extract'/
  )
  t.is(pFlag(addon.encrypt(textPdf(), 'pw', { permissions: { copy: false } })), -4 & ~16)
  t.is(
    pFlag(addon.encrypt(textPdf(), 'pw', { permissions: { print: false, modify: false } })),
    -4 & ~4 & ~8
  )
})

test('encrypt then decrypt gives back an open PDF', (t) => {
  const open = addon.decrypt(addon.encrypt(textPdf(), 'pw'), 'pw')
  t.ok(pageTexts(open)[0].includes('Hello PDF'))
})

test('save can re-encrypt a PDF under a new password', (t) => {
  const doc = addon.open(addon.encrypt(textPdf(), 'old'), { password: 'old' })
  const relocked = doc.save({ encrypt: { password: 'new' } })
  doc.close()
  t.is(rejection(() => addon.open(relocked, { password: 'old' })).code, 'PASSWORD')
  t.ok(pageTexts(relocked, { password: 'new' })[0].includes('Hello PDF'))
})

test('encrypt applies after other edits and keeps form fields', (t) => {
  const doc = addon.open(formPdf())
  doc.fillFields({ name: 'Ada Lovelace', agree: true })
  doc.watermark('DRAFT')
  const locked = doc.save({ encrypt: { password: 'pw' } })
  const expected = doc.fields()
  doc.close()
  t.alike(
    addon.fields(locked, { password: 'pw' }),
    expected,
    'field names and values are decrypted intact'
  )
  t.ok(pageTexts(locked, { password: 'pw' })[0].includes('DRAFT'))
})

test('encrypt handles a PDF packed into object streams', (t) => {
  const locked = addon.encrypt(objectStreamPdf(), 'pw')
  t.ok(pageTexts(locked, { password: 'pw' })[0].includes('Packed'))
})

test('encryptAsync and saveAsync with encrypt match the sync forms', async (t) => {
  const one = await addon.encryptAsync(twoPageTextPdf(), 'pw', { ownerPassword: 'owner' })
  t.ok(pageTexts(one, { password: 'owner' })[1].includes('Page Two'))
  const doc = addon.open(textPdf())
  const two = await doc.saveAsync({ encrypt: { password: 'pw' } })
  doc.close()
  t.is(rejection(() => addon.open(two)).code, 'PASSWORD')
  t.ok(pageTexts(two, { password: 'pw' })[0].includes('Hello PDF'))
})

test('encrypt validates its options', (t) => {
  t.exception.all(() => addon.encrypt(textPdf(), 42), /password must be a string/)
  t.exception.all(() => addon.encrypt(textPdf(), ''), /empty password needs an ownerPassword/)
  t.exception.all(
    () => addon.encrypt(textPdf(), 'pw', { permissions: { share: false } }),
    /unknown permission 'share'/
  )
  t.exception.all(
    () => addon.encrypt(textPdf(), 'pw', { permissions: { copy: 'no' } }),
    /true or false/
  )
  t.exception.all(() => addon.open(textPdf()).save({ encrypt: 'pw' }), /encrypt must be an object/)
  const blank = addon.encrypt(textPdf(), '', { ownerPassword: 'owner' })
  t.ok(pageTexts(blank)[0].includes('Hello PDF'), 'an empty user password opens without one')
})

function codeOf(fn) {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return null
}

async function asyncCodeOf(promise) {
  try {
    await promise
  } catch (err) {
    return err.code
  }
  return null
}

test('native errors carry a code', (t) => {
  const doc = addon.open(textPdf())
  t.is(
    codeOf(() => doc.pageSize(9)),
    'PAGE_RANGE'
  )
  t.is(
    codeOf(() => doc.render(9)),
    'PAGE_RANGE'
  )
  t.is(
    codeOf(() => doc.extractText(9)),
    'PAGE_RANGE'
  )
  t.is(
    codeOf(() => doc.render(0, { scale: 100 })),
    'LIMIT'
  )
  doc.close()
  t.is(
    codeOf(() => addon.openFile(`${os.tmpdir()}/bare-pdfium-missing.pdf`)),
    'FILE'
  )
  t.is(
    codeOf(() => addon.open(Buffer.from('nope'))),
    'FORMAT'
  )
})

test('async errors carry a code', async (t) => {
  const doc = addon.open(textPdf())
  t.is(await asyncCodeOf(doc.renderAsync(9)), 'PAGE_RANGE')
  t.is(await asyncCodeOf(doc.rotateAsync(90, { pages: [9] })), 'PAGE_RANGE')
  const pending = doc.extractTextAsync(0)
  doc.close()
  t.is(await asyncCodeOf(pending), 'CLOSED')
  t.is(await asyncCodeOf(doc.saveAsync()), 'CLOSED')
})

test('argument and form errors carry a code', (t) => {
  t.is(
    codeOf(() => addon.rotate(textPdf(), 45)),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => addon.extractPages(textPdf(), [5])),
    'PAGE_RANGE'
  )
  t.is(
    codeOf(() => addon.watermark(textPdf(), '草稿')),
    'UNSUPPORTED_TEXT'
  )
  t.is(
    codeOf(() => addon.fillFields(formPdf(), { nope: 'x' })),
    'FIELD_NOT_FOUND'
  )
  t.is(
    codeOf(() => addon.fillFields(formPdf(), { id: 'x' })),
    'FIELD_READ_ONLY'
  )
  t.is(
    codeOf(() => addon.fillFields(textPdf(), { name: 'x' })),
    'NO_FORM'
  )
  t.is(
    codeOf(() => addon.encrypt(textPdf(), 42)),
    'INVALID_ARGUMENT'
  )
  const closed = addon.open(textPdf())
  closed.close()
  t.is(
    codeOf(() => closed.save()),
    'CLOSED'
  )
})
