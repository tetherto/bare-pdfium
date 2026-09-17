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
const doc = pdfium.open(bytes, { password: '' }) // password optional

doc.pageCount()          // => number
doc.pageSize(0)          // => { width, height } in PDF points (1/72"), no render
doc.pageFlags(0)         // => { hasImage, hasText }
doc.render(0, { scale: 2 })   // => { width, height, data }  RGBA, white background
doc.extractImages(0)     // => [{ width, height, data }, ...]  the page's images
doc.extractText(0)       // => string  the page's text layer ('' if none)
doc.textPages()          // => iterator of { page, text }, one page at a time

doc.close()              // always close it (idempotent)
```

- `pageFlags(page)` — `hasImage` is true when the page has an image covering more
  than ~5% of it (decoration is ignored); `hasText` is false for a scanned page.
- `render(page, { scale })` — `scale` maps points to pixels: `1` is 72 DPI, `2`
  is 150 DPI. `data` is a row-major RGBA buffer, `width*height*4` bytes.
- `extractImages(page)` — the page's embedded raster images themselves (rendered
  with their transforms), each RGBA. Images under 8px are skipped.
- `extractText(page)` — the page's text layer as a string, empty for a page with
  no text layer (a scan). Independent of `render`, so a consumer can take both the
  pixels and the text from the same page.
- `textPages()` — a generator over `{ page, text }` for every page, yielded one at
  a time. It parses the document once (`open` already holds it) and never
  accumulates: the consumer processes each page and drops it, so a large PDF costs
  one page of text at a time, not the whole document. A one-shot
  `pdfium.textPages(bytes)` opens and closes the doc around the stream.

### One-shot helpers

```js
pdfium.pageCount(bytes)              // open, count, close
pdfium.render(bytes, 0, { scale: 2 }) // open, render one page, close
```

`open`/`render` throw on an unreadable or wrong-password PDF; `render` also
throws on an out-of-range page or dimensions past a 20000px-per-side guard.

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
merges them. Run it from the Actions tab (`workflow_dispatch`). `android-ia32`
is omitted because pdfium-binaries publishes no `android-x86` build.

## Licensing

This wrapper is Apache-2.0. The bundled PDFium (shipped in `prebuilds/`) is
BSD-3-Clause (© The PDFium Authors); the binaries come from bblanchon/pdfium-
binaries (MIT) and embed further permissive components. See `NOTICE` — a shipping
application must carry these attributions.

## Why not pdf.js?

pdf.js's canvas-free serverless build does text extraction only — it has no
canvas factory and cannot rasterize a page. Wiring a Bare Canvas2D into pdf.js is
far more surface area than binding PDFium's page renderer directly.
