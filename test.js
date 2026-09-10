const test = require('brittle')
const addon = require('.')

// Assemble a PDF from object bodies with a correct xref, so no binary fixture
// has to be checked in. Latin1 keeps every byte 1:1 for the offset math.
function buildPdf(bodies) {
  let pdf = '%PDF-1.4\n'
  const offsets = []
  bodies.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
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
