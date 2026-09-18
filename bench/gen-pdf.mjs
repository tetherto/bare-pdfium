import fs from 'fs'

const outPath = process.argv[2]
const pages = parseInt(process.argv[3] ?? '20000', 10)
const linesPerPage = parseInt(process.argv[4] ?? '150', 10)

const fd = fs.openSync(outPath, 'w')
let pos = 0
const offsets = []

function write(str) {
  const buf = Buffer.from(str, 'latin1')
  fs.writeSync(fd, buf)
  pos += buf.length
}

function obj(n, body) {
  offsets[n] = pos
  write(`${n} 0 obj\n${body}\nendobj\n`)
}

function pageContent(i) {
  let s = 'BT /F1 10 Tf 40 800 Td\n'
  for (let l = 0; l < linesPerPage; l++) {
    s += `(Page ${i} line ${l} the quick brown fox jumps over the lazy dog 0123456789) Tj 0 -12 Td\n`
  }
  s += 'ET'
  return s
}

write('%PDF-1.4\n')

const pageNum = (i) => 4 + 2 * i
const contentNum = (i) => 5 + 2 * i
const lastObj = contentNum(pages - 1)

const kids = []
for (let i = 0; i < pages; i++) kids.push(`${pageNum(i)} 0 R`)

obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
obj(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`)
obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

for (let i = 0; i < pages; i++) {
  obj(
    pageNum(i),
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum(i)} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`
  )
  const content = pageContent(i)
  obj(contentNum(i), `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`)
}

const xrefStart = pos
const size = lastObj + 1
write(`xref\n0 ${size}\n0000000000 65535 f \n`)
for (let n = 1; n < size; n++) {
  write(`${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`)
}
write(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`)

fs.closeSync(fd)
console.log(`wrote ${outPath}: ${pages} pages, ${(pos / 1e6).toFixed(1)} MB`)
