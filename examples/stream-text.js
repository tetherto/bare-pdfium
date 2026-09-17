const pdfium = require('bare-pdfium')
const samplePdf = require('./sample-pdf')

const MAX_CHARS = 20000

const bytes = samplePdf()

let budget = MAX_CHARS
const collected = []

for (const { page, text } of pdfium.textPages(bytes)) {
  if (budget <= 0) {
    console.log(`stopping at page ${page}: reached the ${MAX_CHARS}-char budget`)
    break
  }
  const slice = text.slice(0, budget)
  budget -= slice.length
  collected.push(slice)
  console.log(`page ${page}: +${slice.length} chars, ${budget} left`)
}

console.log('\n--- collected text ---\n' + collected.join('\n\n'))
