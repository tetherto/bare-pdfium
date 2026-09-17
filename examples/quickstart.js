const pdfium = require('bare-pdfium')
const samplePdf = require('./sample-pdf')

const bytes = samplePdf()

const doc = pdfium.open(bytes)
try {
  console.log('pageCount:', doc.pageCount())
  console.log('pageSize(0):', doc.pageSize(0))

  for (let page = 0; page < doc.pageCount(); page++) {
    console.log(`pageFlags(${page}):`, doc.pageFlags(page))
  }

  const raster = doc.render(0, { scale: 2 })
  console.log(
    'render(0, scale 2):',
    `${raster.width}x${raster.height}`,
    `${raster.data.length} RGBA bytes`
  )

  console.log('extractImages(0):', doc.extractImages(0).length, 'image(s)')
  console.log('extractText(0):', JSON.stringify(doc.extractText(0)))
} finally {
  doc.close()
}
