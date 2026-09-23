# Examples

Run any of these with Bare:

```sh
bare examples/quickstart.js
bare examples/stream-text.js
```

Each builds a small in-memory sample PDF (`sample-pdf.js`), so they run with no
files and no setup.

- **`quickstart.js`** — every method on a handle: `pageCount`, `pageSize`,
  `pageFlags`, `render`, `extractImages`, `extractText`.
- **`stream-text.js`** — `textPages()` streaming: it walks the document one page
  at a time and stops once a character budget is reached, the pattern that keeps
  text extraction from a large PDF bounded in memory and prompt size.

## Using your own PDF

Point `openFile` at a path — PDFium reads pages from disk on demand, so a large
file never sits fully in memory:

```js
const pdfium = require('bare-pdfium')

const doc = pdfium.openFile('document.pdf')
try {
  for (const { page, text } of doc.textPages()) {
    console.log(`page ${page}:`, text)
  }
} finally {
  doc.close()
}
```

If you already have the bytes, pass them to `open` (or the one-shot
`pdfium.textPages(bytes)`) instead. Pass `{ password: '...' }` to any of the
openers to unlock an encrypted PDF.

To keep the event loop free on a large file, stream the text with
`textPagesAsync()` instead, and use `err.code` to tell an encrypted PDF from a
corrupt one:

```js
const pdfium = require('bare-pdfium')

let doc
try {
  doc = pdfium.openFile('document.pdf')
} catch (err) {
  if (err.code === 'PASSWORD') console.error('encrypted: pass { password }')
  else if (err.code === 'FORMAT') console.error('not a PDF, or corrupted')
  throw err
}

try {
  for await (const { page, text } of doc.textPagesAsync({ clip: true })) {
    console.log(`page ${page}:`, text)
  }
} finally {
  doc.close()
}
```
