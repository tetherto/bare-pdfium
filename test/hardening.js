const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const pdfium = require('..')

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'hostile', name))
}

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

function textPdf(text = 'Hello PDF') {
  const content = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ])
}

function metadataPdf(secret) {
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/">${secret}</x:xmpmeta>`
  const content = 'BT /F1 24 Tf 40 100 Td (Body) Tj ET'
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Metadata /Subtype /XML /Length ${xmp.length} >>\nstream\n${xmp}\nendstream`
  ])
}

function choicePdf() {
  const w = '/Type /Annot /Subtype /Widget /P 3 0 R /F 4 /DA (/Helv 12 Tf 0 g)'
  const rect = (i) => `/Rect [10 ${280 - i * 22} 200 ${298 - i * 22}]`
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R 6 0 R 7 0 R 8 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 9 0 R >> >> /NeedAppearances true >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Annots [4 0 R 5 0 R 6 0 R 7 0 R 8 0 R] >>',
    `<< ${w} /FT /Ch /Ff 131072 /T (pairs) /Opt [[(e1) (Label One)] [(e2) (Label Two)]] ${rect(0)} >>`,
    `<< ${w} /FT /Ch /Ff 2097152 /T (multi) /Opt [(A) (B) (C)] ${rect(1)} >>`,
    `<< ${w} /FT /Ch /Ff 393216 /T (edit) /Opt [(X) (Y)] ${rect(2)} >>`,
    `<< ${w} /FT /Tx /Ff 4096 /T (multiline) ${rect(3)} >>`,
    `<< ${w} /FT /Tx /T (single) /V (keep) ${rect(4)} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ])
}

function radioPdf() {
  const w = '/Type /Annot /Subtype /Widget /P 3 0 R /F 4 /DA (/Helv 12 Tf 0 g)'
  const on = '0 g 2 2 11 11 re f'
  const states = (name) => `/AP << /N << /${name} 10 0 R /Off 11 0 R >> >>`
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 7 0 R 8 0 R 9 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 12 0 R >> >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R] >>',
    '<< /FT /Btn /Ff 49152 /T (r) /V /Off /Kids [5 0 R 6 0 R] >>',
    `<< ${w} /Parent 4 0 R /Rect [20 250 35 265] /AS /Off ${states('A')} >>`,
    `<< ${w} /Parent 4 0 R /Rect [50 250 65 265] /AS /Off ${states('B')} >>`,
    `<< ${w} /FT /Ch /Ff 131072 /T (fixed) /Opt [(X) (Y)] /Rect [20 200 120 220] >>`,
    `<< ${w} /FT /Tx /T (single) /V (keep) /Rect [20 150 200 170] >>`,
    `<< ${w} /FT /Tx /T (other) /V (old) /Rect [20 100 200 120] >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 15 15] /Length ${on.length} >>\nstream\n${on}\nendstream`,
    '<< /Type /XObject /Subtype /Form /BBox [0 0 15 15] /Length 0 >>\nstream\n\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ])
}

function bigImagePdf(width, height) {
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 0 >>\nstream\n\nendstream`
  ])
}

function codeOf(fn) {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return null
}

async function asyncCodeOf(fn) {
  try {
    await fn()
  } catch (err) {
    return err.code
  }
  return null
}

function rotation(pdf) {
  return (pdf.toString('latin1').match(/\/Rotate\s*-?\d+/g) || []).join(',')
}

test('every page method throws CLOSED after close', (t) => {
  const doc = pdfium.open(textPdf())
  doc.close()
  for (const call of [
    () => doc.pageCount(),
    () => doc.pageSize(0),
    () => doc.pageFlags(0),
    () => doc.render(0),
    () => doc.extractImages(0),
    () => doc.extractText(0),
    () => [...doc.textPages()]
  ]) {
    t.is(codeOf(call), 'CLOSED')
  }
})

test('open accepts any byte view and rejects other inputs with a code', (t) => {
  const pdf = textPdf()
  const buffer = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.length)
  t.is(pdfium.open(buffer).pageCount(), 1, 'ArrayBuffer')
  t.is(pdfium.open(new DataView(buffer)).pageCount(), 1, 'DataView')
  t.is(pdfium.open(new Uint16Array(buffer, 0, pdf.length >> 1)).pageCount(), 1, 'Uint16Array')
  t.is(
    codeOf(() => pdfium.open('abc')),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.open(5)),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.openFile(5)),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.merge([pdf, , pdf])),
    'INVALID_ARGUMENT'
  )
})

test('non-string passwords are rejected with a code', (t) => {
  for (const value of [5, {}, true, ['x'], Symbol('s'), 5n]) {
    t.is(
      codeOf(() => pdfium.open(textPdf(), { password: value })),
      'INVALID_ARGUMENT'
    )
    t.is(
      codeOf(() => pdfium.decrypt(textPdf(), value)),
      'INVALID_ARGUMENT'
    )
  }
})

test('importing a document into itself works at any index', async (t) => {
  const doc = pdfium.open(textPdf())
  doc.importPages(doc, { pages: [0], at: 0 })
  t.is(doc.pageCount(), 2)
  await doc.importPagesAsync(doc, { pages: [0, 1], at: 1 })
  t.is(doc.pageCount(), 4)
  doc.close()
})

test('draw rejects fake decoded images and odd font inputs', (t) => {
  const doc = pdfium.create()
  doc.addPage()
  t.is(
    codeOf(() =>
      doc.draw(0, [
        {
          type: 'image',
          image: { pixelWidth: 1000, pixelHeight: 1000, data: Buffer.alloc(4) },
          x: 0,
          y: 0,
          width: 10,
          height: 10
        }
      ])
    ),
    'IMAGE'
  )
  t.is(
    codeOf(() => doc.draw(0, [null])),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => doc.draw(0, [{ type: 'constructor' }])),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => doc.loadFont(new DataView(new ArrayBuffer(8)))),
    'FONT'
  )
  doc.close()
})

test('save of an encrypted document keeps XMP metadata encrypted', (t) => {
  const locked = pdfium.encrypt(metadataPdf('XMPSECRET'), 'pw')
  t.absent(locked.toString('latin1').includes('XMPSECRET'), 'encrypt hides the metadata')
  const doc = pdfium.open(locked, { password: 'pw' })
  doc.rotate(90)
  const saved = doc.save()
  doc.close()
  t.absent(saved.toString('latin1').includes('XMPSECRET'), 'save keeps it encrypted')
  t.is(pdfium.pageCount(saved, { password: 'pw' }), 1)
})

test('encrypt rejects owner passwords that would lift the restrictions', (t) => {
  t.is(
    codeOf(() => pdfium.encrypt(textPdf(), '', { ownerPassword: '' })),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.encrypt(textPdf(), 'same', { ownerPassword: 'same' })),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.encrypt(textPdf(), 'pw', { permissions: ['print'] })),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.encrypt(textPdf(), 'pw', { permissions: { toString: true } })),
    'INVALID_ARGUMENT'
  )
})

test('passwords round-trip: NUL rejected, long and normalized ones reopen', (t) => {
  const pdf = textPdf()
  t.is(
    codeOf(() => pdfium.encrypt(pdf, 'a\0b')),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.open(pdf, { password: 'a\0b' })),
    'INVALID_ARGUMENT'
  )
  const long = 'x'.repeat(200)
  t.is(pdfium.pageCount(pdfium.encrypt(pdf, long), { password: long }), 1)
  const split = 'x'.repeat(126) + 'é'
  t.is(pdfium.pageCount(pdfium.encrypt(pdf, split), { password: split }), 1)
  t.is(pdfium.pageCount(pdfium.encrypt(pdf, 'é'), { password: 'é' }), 1, 'NFD and NFC')
  t.is(pdfium.pageCount(pdfium.encrypt(pdf, 'ﬁle'), { password: 'file' }), 1, 'ligature')
})

test('encrypt keeps objects whose names look like structural keys', (t) => {
  for (const name of [
    'checkbox_length.pdf',
    'name_value_length.pdf',
    'zz_type_xref.pdf',
    'zz_type_objstm.pdf'
  ]) {
    const pdf = fixture(name)
    const before = pdfium.open(pdf)
    const expected = {
      pages: before.pageCount(),
      text: before.extractText(0),
      fields: before.fields().map((field) => [field.name, field.value])
    }
    before.close()
    const after = pdfium.open(pdfium.encrypt(pdf, 'pw'), { password: 'pw' })
    t.alike(
      {
        pages: after.pageCount(),
        text: after.extractText(0),
        fields: after.fields().map((field) => [field.name, field.value])
      },
      expected,
      name
    )
    after.close()
  }
})

test('encrypt numbers its dictionary above dangling references', (t) => {
  const pdf = fixture('m0052_bug_1286_flip.pdf')
  t.is(pdfium.pageCount(pdfium.encrypt(pdf, 'pw'), { password: 'pw' }), pdfium.pageCount(pdf))
})

test('encrypt writes a sparse xref for huge object numbers', (t) => {
  const pdf = fixture('big_objnum_8388607.pdf')
  const out = pdfium.encrypt(pdf, 'pw')
  t.ok(out.length < 10000, `${out.length} bytes`)
  t.is(pdfium.pageCount(out, { password: 'pw' }), 1)
})

test('a self-recursive form XObject loads within a budget', (t) => {
  const doc = pdfium.open(fixture('xobject_recursion.pdf'))
  const start = Date.now()
  doc.extractText(0)
  doc.render(0)
  t.ok(Date.now() - start < 5000, `${Date.now() - start} ms`)
  doc.close()
})

test('rotate and watermark touch a repeated page once', (t) => {
  const pdf = fixture('same_page_twice.pdf')
  const start = Date.now()
  pdfium.watermark(pdf, 'WM')
  t.ok(Date.now() - start < 5000, `${Date.now() - start} ms`)
  t.is(rotation(pdfium.rotate(textPdf(), 90, { pages: [0, 0] })), '/Rotate 90')
})

test('render caps the pixel area and validates page and scale', (t) => {
  const doc = pdfium.open(textPdf())
  t.is(
    codeOf(() => doc.render(0, { scale: 100 })),
    'LIMIT'
  )
  t.is(
    codeOf(() => doc.render(0, { scale: NaN })),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => doc.render(0, { scale: '2' })),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => doc.render('x')),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => doc.render(2 ** 32 + 1)),
    'PAGE_RANGE'
  )
  doc.close()
  const big = pdfium.create()
  big.addPage({ width: 14400, height: 14400 })
  t.is(
    codeOf(() => big.render(0, { scale: 1 })),
    'LIMIT'
  )
  big.close()
})

test('fillFields compares against normalized values', (t) => {
  const doc = pdfium.open(choicePdf())
  t.is(doc.fillFields({ pairs: 'Label One' })[0].value, 'Label One')
  t.alike(doc.fillFields({ multi: ['A', 'A'] })[0].value, ['A'])
  t.alike(doc.fillFields({ multi: [] })[0].value, [])
  t.is(doc.fillFields({ edit: 'free text' })[0].value, 'free text')
  t.is(doc.fillFields({ edit: '' })[0].value, null)
  t.is(doc.fillFields({ multiline: 'a\nb' })[0].value, 'a\r\nb')
  t.is(
    codeOf(() => doc.fillFields({ single: 'emoji 😀' })),
    'UNSUPPORTED_TEXT'
  )
  t.is(
    codeOf(() => doc.fillFields(undefined)),
    'INVALID_ARGUMENT'
  )
  doc.close()
})

test('fillFields rolls back every field when one is rejected', (t) => {
  const doc = pdfium.open(choicePdf())
  t.is(
    codeOf(() => doc.fillFields({ edit: 'changed', single: 'a\nb' })),
    'FIELD_REJECTED'
  )
  const values = Object.fromEntries(doc.fields().map((field) => [field.name, field.value]))
  t.is(values.edit, null)
  t.is(values.single, 'keep')
  doc.close()
})

test('fillFields leaves an empty radio group and dropdown empty when another field is rejected', async (t) => {
  const doc = pdfium.open(radioPdf())
  t.is(
    codeOf(() => doc.fillFields({ r: 'A', fixed: 'Y', other: 'new', single: 'a\nb' })),
    'FIELD_REJECTED'
  )
  let values = Object.fromEntries(doc.fields().map((field) => [field.name, field.value]))
  t.alike(values, { r: null, fixed: null, single: 'keep', other: 'old' })
  t.is(await asyncCodeOf(() => doc.fillFieldsAsync({ r: 'B', single: 'a\tb' })), 'FIELD_REJECTED')
  values = Object.fromEntries(doc.fields().map((field) => [field.name, field.value]))
  t.is(values.r, null)
  const filled = doc.fillFields({ r: 'B', fixed: 'X', other: 'new' })
  t.alike(
    filled.map((field) => field.value),
    ['B', 'X', 'new']
  )
  doc.close()
})

test('extractImages reports LIMIT for an image over 40 megapixels', (t) => {
  const doc = pdfium.open(bigImagePdf(7000, 7000))
  t.is(
    codeOf(() => doc.extractImages(0)),
    'LIMIT'
  )
  doc.close()
})

test('watermark validates size, angle and font', (t) => {
  const pdf = textPdf()
  for (const opts of [
    { size: '40' },
    { size: NaN },
    { size: Infinity },
    { size: -5 },
    { angle: NaN },
    { angle: '30' },
    { font: 'Helvetica' },
    { font: 3 }
  ]) {
    t.is(
      codeOf(() => pdfium.watermark(pdf, 'WM', opts)),
      'INVALID_ARGUMENT',
      JSON.stringify(opts)
    )
  }
})

test('pages lists must be non-empty and dense', (t) => {
  const pdf = textPdf()
  t.is(
    codeOf(() => pdfium.rotate(pdf, 90, { pages: [] })),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.extractPages(pdf, [])),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.rotate(pdf, 90, { pages: [, 0] })),
    'INVALID_ARGUMENT'
  )
})

test('null options and bad option objects get a code', async (t) => {
  const pdf = textPdf()
  const doc = pdfium.open(pdf, null)
  t.is(doc.extractText(0, null), 'Hello PDF')
  t.ok(doc.save(null).length > 0)
  doc.close()
  t.ok(pdfium.compose('x', null).length > 0)
  t.ok((await pdfium.composeAsync('x', null)).length > 0)
  t.is(
    codeOf(() => pdfium.rotate(pdf, 90, 'pages')),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.rotate(pdf, Symbol('d'))),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.create().importPages({})),
    'INVALID_ARGUMENT'
  )
  t.is(await asyncCodeOf(() => pdfium.encryptAsync(pdf, 'pw', 'x')), 'INVALID_ARGUMENT')
  const later = pdfium.open(pdf)
  t.is(await asyncCodeOf(() => later.renderAsync(0, 'x')), 'INVALID_ARGUMENT')
  later.close()
})

test('inherited properties are not read as options', (t) => {
  const pdf = textPdf()
  Object.prototype.pages = [5]
  try {
    t.is(rotation(pdfium.rotate(pdf, 90)), '/Rotate 90')
  } finally {
    delete Object.prototype.pages
  }
})

test('text drops NUL and rejects characters the font cannot draw', (t) => {
  const pdf = pdfium.compose('alpha\0beta')
  t.ok(pdfium.textPages(pdf).next().value.text.includes('alphabeta'))
  t.is(
    codeOf(() => pdfium.compose('中文')),
    'UNSUPPORTED_TEXT'
  )
  const doc = pdfium.create()
  doc.addPage()
  const font = doc.loadFont('Helvetica')
  t.is(
    codeOf(() => doc.draw(0, [{ type: 'text', text: '中', font, size: 12, x: 10, y: 10 }])),
    'UNSUPPORTED_TEXT'
  )
  doc.close()
})

test('compose validates its options and blocks', (t) => {
  t.is(
    codeOf(() => pdfium.compose([{ type: 'table', header: 'x', rows: [] }])),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.compose([{ type: 'paragraph', text: 'x' }], { margin: NaN })),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.compose('x', { font: 'constructor' })),
    'INVALID_ARGUMENT'
  )
  t.is(
    codeOf(() => pdfium.compose([{ type: 'image', data: Buffer.from('not an image') }])),
    'IMAGE'
  )
  t.is(
    codeOf(() => pdfium.compose('![x](data:image/png;base64,@@@)')),
    null,
    'a bad data URI falls back to the alt text'
  )
})
