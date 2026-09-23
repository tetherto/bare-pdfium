# bare-pdfium

PDF rasterization and inspection for [Bare](https://github.com/holepunchto/bare),
backed by [PDFium](https://pdfium.googlesource.com/pdfium/). Renders pages to RGBA
pixel buffers with no canvas, no DOM, and no browser — so it runs anywhere Bare
runs (desktop and mobile).

The motivating use is feeding a PDF to a vision model: classify pages, rasterize
the ones that carry a figure, encode them (e.g. via `bare-media`), and hand them
to the model as images.

## API

```js
const pdfium = require('bare-pdfium')

const bytes = await fs.promises.readFile('doc.pdf') // Buffer / Uint8Array
```

### Handle (parse once)

```js
// from bytes, or pdfium.openFile('doc.pdf') to read from disk on demand
const doc = pdfium.open(bytes, { password: '' })

// => number
doc.pageCount()

// => { width, height } in PDF points (1/72"), no render
doc.pageSize(0)

// => { hasImage, hasText }
doc.pageFlags(0)

// => { width, height, data }, RGBA on a white background
doc.render(0, { scale: 2 })

// => [{ width, height, data }, ...], the page's embedded images
doc.extractImages(0)

// => string, the page's text layer ('' if none)
doc.extractText(0, { hyphens: 'join', clip: false })

// => iterator of { page, text }, one page at a time
doc.textPages()

// always close it (idempotent)
doc.close()
```

- `open(bytes)` vs `openFile(path)` — `open` copies the whole file into memory and
  holds it for the document's life; `openFile` hands PDFium a read callback so it
  pulls pages from disk on demand, which keeps a large PDF from sitting in memory
  twice. The returned handle is identical either way.
- `pageFlags(page)` — `hasImage` is true when the page has an image covering more
  than ~5% of it (decoration is ignored); `hasText` is false for a scanned page.
- `render(page, { scale })` — `scale` maps points to pixels: `1` is 72 DPI, `2`
  is 150 DPI. `data` is a row-major RGBA buffer, `width*height*4` bytes.
- `extractImages(page)` — the page's embedded raster images themselves (rendered
  with their transforms), each RGBA. Images under 8px are skipped.
- `extractText(page, opts)` — the page's text layer as a string, empty for a page
  with no text layer (a scan). Independent of `render`, so a consumer can take both
  the pixels and the text from the same page. Lines are separated by `\r\n`. See
  [Text options](#text-options).
- `textPages(opts)` — a generator over `{ page, text }` for every page, yielded one
  at a time. It parses the document once (`open` already holds it) and never
  accumulates: the consumer processes each page and drops it, so a large PDF costs
  one page of text at a time, not the whole document. It takes the same options as
  `extractText`. A one-shot `pdfium.textPages(bytes)` opens and closes the doc
  around the stream.

### Text options

`extractText`, `extractTextAsync`, `textPages` and `textPagesAsync` take:

| option    | default  | effect                                                     |
| --------- | -------- | ---------------------------------------------------------- |
| `hyphens` | `'join'` | how to treat a word hyphenated across a line break         |
| `clip`    | `false`  | `true` drops text drawn outside the visible page (cropbox) |

- `hyphens` — where a word is hyphenated across a line break, PDFium drops the
  line break and replaces the hyphen with U+FFFE: `infer-` / `ence` comes back as
  `infer\uFFFEence`.
  - `'join'` removes the marker: `inference`.
  - `'keep'` turns it back into a hyphen: `infer-ence`, which is right for words
    like `well-known`.
  - `'raw'` returns PDFium's text unchanged.

  Any other value throws a `TypeError`.

- `clip` — PDFium returns text drawn outside the page boundary as well (pdf.js
  drops it). `clip: true` extracts only the text inside the page's crop box, using
  `FPDFText_GetBoundedText`.

```js
doc.extractText(0, { hyphens: 'keep', clip: true })
```

### Async

Every call above is synchronous and blocks the event loop while PDFium works. For
large documents, use the async variants, which run on a libuv worker thread:

```js
const image = await doc.renderAsync(0, { scale: 2 })
const text = await doc.extractTextAsync(0, { clip: true })

for await (const { page, text } of doc.textPagesAsync()) {
  console.log(page, text)
}
```

- `renderAsync(page, opts)`, `extractTextAsync(page, opts)` and
  `textPagesAsync(opts)` return the same results as `render`, `extractText` and
  `textPages`.
- PDFium is not thread-safe, so every PDFium call — sync or async, across all
  open documents — goes through one lock, and async jobs run one at a time. A sync
  call made while an async job is running waits for that job to finish.
- Closing a document with jobs still queued rejects them with
  `document is closed`, as does calling an async method after `close()`.

### Errors

`open` and `openFile` throw when PDFium cannot load the file, with `err.code` set
to PDFium's reason (`FPDF_GetLastError`):

| `err.code` | meaning                                         |
| ---------- | ----------------------------------------------- |
| `PASSWORD` | encrypted, and the password is missing or wrong |
| `FORMAT`   | not a PDF, or corrupted                         |
| `FILE`     | the file could not be opened or read            |
| `SECURITY` | encrypted with an unsupported security handler  |
| `PAGE`     | a page could not be loaded                      |
| `UNKNOWN`  | anything else                                   |

```js
try {
  doc = pdfium.openFile(path)
} catch (err) {
  if (err.code === 'PASSWORD') askForPassword()
  else if (err.code === 'FORMAT') skipCorruptFile()
  else throw err
}
```

Page calls throw (or, when async, reject) on an out-of-range page; `render` also
throws on dimensions past a 20000px-per-side guard.

### One-shot helpers

These open and close a document for you:

```js
// open, count, close
pdfium.pageCount(bytes)

// open, render one page, close
pdfium.render(bytes, 0, { scale: 2 })

// open, stream every page's text, close when the iterator is done
pdfium.textPages(bytes, { hyphens: 'join' })
```

### Types

`index.d.ts` ships with the package. Buffers are typed as `Uint8Array`, so
consumers do not need `@types/node`.

## Build

Requires the Bare toolchain (`npm i -g bare-make`) and CMake ≥ 3.31.

```sh
npm install
bare-make generate   # downloads a prebuilt PDFium for the host target
bare-make build
bare-make install    # writes prebuilds/<target>/
npm test
```

`bare-make generate` fetches PDFium from
[bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) for the
target (override the release with `-DPDFIUM_RELEASE=chromium/<n>`), so the first
configure needs network access. The released binaries are shared libraries;
`add_bare_module(... INSTALL TARGET pdfium)` ships the shared library beside the
built `.bare`, where the module's rpath resolves it.

## Prebuilds

`.github/workflows/prebuild.yml` builds prebuilds for every target
(linux x64/arm64, android arm64/arm/x64, darwin x64/arm64, ios arm64 +
simulators, win32 x64/arm64) via the holepunch `compile-prebuilds` actions, then
merges them. Run it from the Actions tab (`workflow_dispatch`).
`.github/workflows/publish.yml` builds the same set and publishes it to npm.
`android-ia32` is omitted because pdfium-binaries publishes no `android-x86`
build.

## Licensing

This wrapper is Apache-2.0. The bundled PDFium (shipped in `prebuilds/`) is
BSD-3-Clause (© The PDFium Authors); the binaries come from bblanchon/pdfium-
binaries (MIT) and embed further permissive components. See `NOTICE` — a shipping
application must carry these attributions.

## Why not pdf.js?

pdf.js's canvas-free serverless build does text extraction only — it has no
canvas factory and cannot rasterize a page. Wiring a Bare Canvas2D into pdf.js is
far more surface area than binding PDFium's page renderer directly.
