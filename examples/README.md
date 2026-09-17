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

The addon takes the file bytes as a `Buffer`/`Uint8Array`. Read them however your
runtime does — under Bare that is `bare-fs`:

```js
const fs = require('bare-fs')
const pdfium = require('bare-pdfium')

const bytes = fs.readFileSync('document.pdf')
for (const { page, text } of pdfium.textPages(bytes)) {
  console.log(`page ${page}:`, text)
}
```

Pass `{ password: '...' }` to `open`/`textPages`/the one-shots to unlock an
encrypted PDF.
