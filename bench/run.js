const fs = require('bare-fs')
const pdfium = require('bare-pdfium')

const args = Bare.argv
const path = args[args.length - 1]
const mode = args[args.length - 2]

const t0 = Date.now()
let doc
if (mode === 'bytes') {
  const bytes = fs.readFileSync(path)
  doc = pdfium.open(bytes)
} else {
  doc = pdfium.openFile(path)
}
const tOpen = Date.now()

let pages = 0
let chars = 0
for (const { text } of doc.textPages()) {
  pages++
  chars += text.length
}
const tExtract = Date.now()
doc.close()

console.log(
  JSON.stringify({
    mode,
    pages,
    chars,
    openMs: tOpen - t0,
    extractMs: tExtract - tOpen,
    totalMs: tExtract - t0
  })
)
