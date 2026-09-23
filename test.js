const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
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
  t.exception(() => doc.extractText(5))
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

test('render rejects an out-of-range page', (t) => {
  t.exception(() => addon.render(textPdf(), 5, { scale: 1 }))
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

test('renderAsync matches render', async (t) => {
  const doc = addon.open(textPdf())
  const expected = doc.render(0, { scale: 2 })
  const actual = await doc.renderAsync(0, { scale: 2 })
  t.is(actual.width, expected.width)
  t.is(actual.height, expected.height)
  t.ok(Buffer.compare(actual.data, expected.data) === 0, 'same pixels')
  doc.close()
})

test('async calls reject on an out-of-range page', async (t) => {
  const doc = addon.open(textPdf())
  await t.exception(doc.extractTextAsync(5))
  await t.exception(doc.renderAsync(5))
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
