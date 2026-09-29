const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const png = require('bare-png')
const pdfium = require('..')

const fixtures = path.join(__dirname, 'fixtures', 'pdfium')

for (const fixture of fs
  .readdirSync(fixtures)
  .filter((f) => f.endsWith('.png'))
  .sort()) {
  const [, name, page] = fixture.match(/^(.+)\.(\d+)\.png$/)

  test(`${name} page ${page} matches PDFium's expected render`, (t) => {
    const expected = png.decode(fs.readFileSync(path.join(fixtures, fixture)))

    const doc = pdfium.open(fs.readFileSync(path.join(fixtures, `${name}.pdf`)))
    const actual = doc.render(Number(page), { scale: 1 })
    doc.close()

    t.alike([actual.width, actual.height], [expected.width, expected.height])
    t.ok(Buffer.from(actual.data).equals(expected.data), 'pixels are identical')
  })
}
