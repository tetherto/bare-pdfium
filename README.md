# bare-pdfium

PDF rasterization, inspection and editing for [Bare](https://github.com/holepunchto/bare),
backed by [PDFium](https://pdfium.googlesource.com/pdfium/). Renders pages to RGBA
pixel buffers with no canvas, no DOM, and no browser — so it runs anywhere Bare
runs (desktop and mobile).

The motivating use is feeding a PDF to a vision model: classify pages, rasterize
the ones that carry a figure, encode them (e.g. via `bare-media`), and hand them
to the model as images. It also merges, splits, rotates, watermarks, encrypts, decrypts
and fills in the form fields of an existing PDF, and saves the result, and it
creates new PDFs from Markdown or content blocks.

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

Every other error carries an `err.code` too, so callers can branch without
matching messages. Async calls reject with the same codes.

| `err.code`         | meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT` | an option or argument has the wrong type or value (a `TypeError` or `RangeError`) |
| `PAGE_RANGE`       | a page index past the end of the document                                         |
| `PAGE`             | a page, or its text layer, could not be loaded                                    |
| `CLOSED`           | the document was closed, including before a queued async call ran                 |
| `LIMIT`            | `render` past the 20000px-per-side guard                                          |
| `MEMORY`           | a bitmap could not be allocated                                                   |
| `UNSUPPORTED_TEXT` | text the built-in fonts cannot draw; pass a TrueType font                         |
| `FONT`             | a font failed to load, or a draw item names one the document has not loaded       |
| `IMAGE`            | image data is not a PNG or JPEG PDFium can embed                                  |
| `IMPORT`           | pages could not be copied between documents                                       |
| `FORM`             | the document's form could not be loaded                                           |
| `NO_FORM`          | the document has no form fields                                                   |
| `FIELD_NOT_FOUND`  | `fillFields` names a field the form does not have                                 |
| `FIELD_READ_ONLY`  | the field is read-only                                                            |
| `FIELD_TYPE`       | the field is a button or signature, which cannot be filled                        |
| `FIELD_REJECTED`   | the field did not take the value when read back                                   |
| `SAVE`             | PDFium could not write the document                                               |
| `ENCRYPT`          | the saved PDF could not be encrypted                                              |
| `EDIT`             | PDFium refused an edit (a page, text object or shape could not be created)        |

### Lifetime

`close()` frees a document straight away. A document that is never closed is
freed when it is garbage collected, without blocking: if PDFium is busy with
another call, the release runs on a worker thread instead. When the process
exits, documents still open are closed after any async calls on them finish;
those calls neither resolve nor reject, as nothing is left to observe them.

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

### Editing

Edits change the open document in memory; `save()` returns the new PDF as a
`Buffer`. The input is never modified.

```js
// an empty document to import pages into
const out = pdfium.create()

// copy pages from another open document, in the order given; `at` defaults to the end
out.importPages(doc, { pages: [2, 0], at: 0 })

// turn pages clockwise by a multiple of 90, added to their current rotation
doc.rotate(90, { pages: [0] })

// stamp text across the middle of each page
doc.watermark('DRAFT', { angle: 45, opacity: 0.3, position: 'over' })

// => [{ name, type, value, page, readOnly, required, options? }, ...]
doc.fields()

// set form fields by name, then read them back
doc.fillFields({ name: 'Ada Lovelace', agree: true, color: 'blue', size: 'M' })

// => Buffer; removeSecurity drops the encryption of a document opened with its password
doc.save({ removeSecurity: false })

// => Buffer, locked with AES-256
doc.save({
  encrypt: { password: 'open sesame', ownerPassword: 'admin', permissions: { copy: false } }
})
```

- `pages` — zero-based page indexes. Omitted, an edit applies to every page.
  An index out of range throws a `RangeError` before anything changes.
- `watermark(text, opts)`:

  | option     | default           | effect                                                         |
  | ---------- | ----------------- | -------------------------------------------------------------- |
  | `pages`    | every page        | which pages to stamp                                           |
  | `size`     | fit to the page   | font size in points; by default the text fills 80% of the page |
  | `angle`    | `45`              | degrees counterclockwise, as the page is displayed             |
  | `color`    | `[128, 128, 128]` | `[r, g, b]`, each 0-255                                        |
  | `opacity`  | `0.3`             | 0 to 1                                                         |
  | `position` | `'over'`          | `'over'` the content, or `'under'` it                          |
  | `font`     | Helvetica Bold    | TrueType font bytes, needed for text outside Latin-1           |

  `'under'` is hidden by any page that paints an opaque background, such as a
  scan, so the default is `'over'` with some transparency. The page's content
  stream is regenerated to add the stamp.

- `fields()` — one entry per form field, merged across its widgets. `value` is
  a string for text fields and dropdowns, a boolean for checkboxes, the chosen
  option for a radio group (`null` when none is), and an array for a
  multi-select list. Radio groups, dropdowns and lists carry their `options`.
  A document with no form returns `[]`.
- `fillFields(values)` — a text field takes a string (or a number), a checkbox
  `true` or `false`, a radio group or dropdown one of its `options` (an editable
  dropdown also takes free text), and a list box one option or an array of them.
  An unknown name, a read-only field or a value outside the options throws
  before anything changes, with a message naming what the field accepts. The
  fields are filled through PDFium's form engine, so their appearance is
  regenerated as a viewer would draw it, and each value is read back afterwards;
  a field that did not take its value throws. Returns the filled fields.
- `save()` keeps the document's encryption. To decrypt, open with the password
  and save with `removeSecurity: true`.
- `save({ encrypt })` locks the saved PDF with AES-256 (PDF 2.0 security handler,
  revision 6), replacing any encryption it had. PDFium cannot write encryption,
  so the saved bytes are encrypted afterwards in JavaScript with
  [`bare-crypto`](https://github.com/holepunchto/bare-crypto), which is loaded
  only when this option is used:

  | option          | default     | effect                                                                                                                         |
  | --------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
  | `password`      | required    | the password that opens the file; `''` opens it without one                                                                    |
  | `ownerPassword` | random      | also opens the file, and lifts the permission limits                                                                           |
  | `permissions`   | all allowed | set any of these to `false` to restrict it: `print`, `modify`, `copy`, `annotate`, `fillForms`, `assemble`, `printHighQuality` |

  Without an `ownerPassword` a random one is used, so the limits cannot be
  lifted; an empty `password` therefore needs one. Readers honour permissions
  voluntarily, so they restrict what a viewer offers rather than protect the
  content. Passwords longer than 127 bytes of UTF-8 are truncated, as the
  standard requires. In `saveAsync` the save runs on the worker and the
  encryption on the calling thread.

The one-shot forms open the input, apply one edit and return the saved PDF:

```js
pdfium.merge([a, b, c])
pdfium.extractPages(bytes, [0, 1, 2])
pdfium.rotate(bytes, 90, { pages: [0] })
pdfium.decrypt(bytes, 'password')
pdfium.encrypt(bytes, 'password', { ownerPassword: 'admin', permissions: { print: false } })
pdfium.watermark(bytes, 'CONFIDENTIAL', { opacity: 0.2 })
pdfium.fields(bytes)
pdfium.fillFields(bytes, { name: 'Ada Lovelace' })
```

Every one-shot but `merge`, `decrypt` and `encrypt` takes `password` in its options for an
encrypted input.

Each edit also has an async form that runs on a libuv worker thread, the same way
`renderAsync` does: `importPagesAsync`, `rotateAsync`, `watermarkAsync`,
`fieldsAsync`, `fillFieldsAsync` and `saveAsync` on a document, and `mergeAsync`,
`extractPagesAsync`, `rotateAsync`, `decryptAsync`, `watermarkAsync`,
`fieldsAsync`, `fillFieldsAsync` and `encryptAsync` as one-shots. They resolve to what the sync
form returns.

```js
const doc = pdfium.open(bytes)
doc.importPagesAsync(other, { pages: [0] })
doc.rotateAsync(90, { pages: [0] })
doc.watermarkAsync('DRAFT')
const out = await doc.saveAsync()
```

Async calls run one at a time in the order they were made, so a chain like the
one above needs no `await` between steps. Each call checks its arguments when
its turn comes, against the document as the calls before it left it. A bad
argument rejects the promise and never throws. A call still queued when its
document, or the source of an import, is closed rejects with
`document is closed`. The one-shots open their input on the calling thread and
do the edit and the save on the worker.

### Creating

`compose(content, opts)` lays out a new PDF and returns it as a `Buffer`.
`content` is Markdown or an array of blocks:

```js
const pdf = pdfium.compose(markdown, { pageSize: 'A4', pageNumbers: true })

const same = pdfium.compose([
  { type: 'heading', level: 1, text: 'Quarterly Report' },
  { type: 'paragraph', text: 'Revenue grew **18%** year over year.' },
  { type: 'list', items: ['Three new sites', { text: 'Irrigation', items: ['North', 'South'] }] },
  { type: 'table', header: ['Region', 'Revenue'], rows: [['North', '$1.2M']] },
  { type: 'image', data: pngBytes, width: 300, caption: 'Revenue by month' },
  { type: 'code', text: 'const total = north + south' },
  { type: 'quote', text: 'Growth came from the regions we invested in.' },
  { type: 'rule' },
  { type: 'pageBreak' }
])
```

- Text wraps to the page, flows onto new pages, and never leaves one line of a
  paragraph alone at the top or bottom of a page. Tables size their columns to
  their content, wrap their cells and repeat the header row on every page they
  cross. Images keep their aspect ratio and shrink to fit.
- Block `text`, list items and table cells take a string, where `**bold**`,
  `*italic*` and `` `code` `` are applied, or an array of runs
  `{ text, bold, italic, code }`. A paragraph can take `align: 'center'`, and an
  ordered list `start`.
- Markdown covers headings, paragraphs (a line ending in two spaces or `\`
  breaks), bullet and numbered lists with nesting, block quotes, fenced code,
  GitHub tables, rules, `\pagebreak` and images. An image draws only from a
  `data:` URI, as the input is a string with no files beside it; any other
  source prints its alt text.
- Images are PNG or JPEG bytes. JPEGs are embedded as they are, and PNGs are
  decoded with [`bare-png`](https://github.com/holepunchto/bare-png), loaded only
  when one is used.

| option        | default       | effect                                                                                            |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `pageSize`    | `'A4'`        | `'A4'`, `'A5'`, `'Letter'`, `'Legal'`, or `[width, height]` in points                             |
| `landscape`   | `false`       | turn the page size sideways                                                                       |
| `margin`      | `56.69`       | points on every side (20 mm)                                                                      |
| `font`        | `'Helvetica'` | `'Helvetica'`, `'Times'`, `'Courier'`, TrueType bytes, or `{ regular, bold, italic, boldItalic }` |
| `monoFont`    | `'Courier'`   | the same, for code                                                                                |
| `fontSize`    | `11`          | body size in points; headings scale from it                                                       |
| `lineHeight`  | `1.4`         | line spacing as a multiple of the font size                                                       |
| `pageNumbers` | `false`       | print `n / m` at the foot of each page                                                            |
| `encrypt`     | none          | `{ password, ownerPassword, permissions }`, as for `save`                                         |

The built-in fonts draw Western European text: Latin-1 and the rest of Windows
code page 1252, such as curly quotes, dashes and `€`. For the rest, emoji and
the invisible characters around them (variation selectors, joiners, skin tones,
flags) are left out with any font, since PDFium cannot draw color glyphs. With
the built-in fonts, common symbols become their nearest plain form (`→` is
`->`, `≥` is `>=`, `✓` is `v`, other bullets are `•`), accented letters outside
Latin-1 lose their accent (`ő` is `o`, `ł` is `l`), and other symbols are left
out. Letters and digits they cannot draw, such as Chinese or Cyrillic, throw and
name the characters, since dropping them would lose the text; pass TrueType
fonts for them. The watermark follows the same rules. Each style falls back to
`regular` when its own font is not given. PDFium embeds the whole font file,
since it cannot subset one, so a large font such as a pan-Unicode one makes a
large PDF; prefer a font that covers only the scripts you need. Glyphs are
placed one after another without shaping, so scripts that need shaping, such
as Arabic, or Devanagari conjuncts, do not come out right.

`composeAsync` saves on the worker thread; the layout itself runs on the calling
thread.

The pieces `compose` is built from are there to draw on any page:

```js
const doc = pdfium.create()
doc.addPage({ width: 595.28, height: 841.89 }) // => the new page's index; `at` inserts
const font = doc.loadFont('Helvetica-Bold') // a built-in font name, or TrueType bytes

doc.measureText('Total', font, 12) // => width in points
doc.fontMetrics(font, 12) // => { ascent, descent }

doc.draw(0, [
  { type: 'text', text: 'Total', font, size: 12, x: 72, y: 720, color: [0, 0, 0] },
  { type: 'rect', x: 72, y: 700, width: 200, height: 1, fill: [0, 0, 0] },
  { type: 'line', x1: 72, y1: 690, x2: 272, y2: 690, color: [150, 150, 150], lineWidth: 0.5 },
  { type: 'image', image: jpegBytes, x: 72, y: 500, width: 200, height: 150 }
])
```

Coordinates are PDF points from the bottom-left corner of the page, and `y` for
text is its baseline. A rectangle takes `fill`, `stroke` and `lineWidth`, and
text and fills take `opacity`. The built-in fonts are Helvetica, Times and
Courier in regular, bold, italic (oblique) and bold italic. `drawAsync` runs
the drawing on the worker thread.

### Types

`index.d.ts` ships with the package. Buffers are typed as `Uint8Array`, so
consumers do not need `@types/node`.

## Build

PDFium is built by its own GN build and linked into the addon through
[`cmake-gn`](https://github.com/holepunchto/cmake-gn), the way
[`libjs`](https://github.com/holepunchto/libjs) links V8. Every prebuild is a
single `.bare`. Building needs
[`depot_tools`](https://commondatastorage.googleapis.com/chrome-infra-docs/flat/depot_tools/docs/html/depot_tools_tutorial.html#_setting_up)
and the Bare toolchain (`npm i -g bare-make`).

`DEPS` pins PDFium, which pins everything it builds with. Fetch it with gclient
into a directory of its own, with this repository checked out as
`pdfium/bare-pdfium` inside it:

```sh
mkdir -p pdfium/pdfium && cd pdfium
ln -s <path to bare-pdfium> pdfium/bare-pdfium
gclient config --name pdfium/bare-pdfium --unmanaged --custom-var checkout_configuration=minimal https://github.com/tetherto/bare-pdfium.git
gclient sync --no-history --shallow
ln -s pdfium/buildtools buildtools
```

For android, ios or win targets, first add `target_os = ["<os>"]` to `.gclient`,
and for android also `"checkout_android": True` to its `custom_vars`. On Windows,
use a junction (`mklink /j`) instead of `ln -s` and set
`DEPOT_TOOLS_WIN_TOOLCHAIN=0`.

Then apply the patches in [`patches/`](patches), which fix PDFium's standalone
build for targets it does not build itself, and build PDFium for a target from
[`gn/target/`](gn/target). Revert the patches with `git apply --reverse` before the next
`gclient sync`, which needs a clean tree:

```sh
cd pdfium
git apply bare-pdfium/patches/*.patch
gn gen out/<target> --args='import("//bare-pdfium/gn/pdfium.gni") import("//bare-pdfium/gn/mode/release.gni") import("//bare-pdfium/gn/target/<target>.gni")'
autoninja -C out/<target> pdfium buildtools/third_party/libc++:libc++
```

For linux and android targets, also build `buildtools/third_party/libc++abi:libc++abi`,
which Chromium keeps out of `libc++` there and the addon links in alongside it.
On Windows, build only `pdfium`, as PDFium uses the MSVC STL there. Chromium's
`build/` needs the Windows SDK it pins (10.0.28000), which Visual Studio 2022
does not install by default. Finally,
point the addon at the build, using absolute paths. Linux builds also take the
sysroot PDFium was built against, which
`python3 build/linux/sysroot_scripts/install-sysroot.py --arch=<arch>` installs as
`build/linux/debian_bullseye_<amd64|arm64>-sysroot`:

```sh
cd <path to bare-pdfium>
npm install
bare-make generate -D GN_DIR=<root>/pdfium -D GN_OUT_DIR=<root>/pdfium/out/<target>
bare-make build
bare-make install    # writes prebuilds/<target>/
npm test
```

`.github/actions/pdfium` runs these steps in CI. `test/render.js` compares renders
against the expected PNGs from PDFium's own pixel tests, byte for byte.

### Updating PDFium

1. Pin the PDFium that Chrome's current Stable release ships as
   `pdfium_revision` in `DEPS`, keeping its comment in step. Chrome publishes it
   for each release:

   ```sh
   curl -s 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Linux&num=1'
   ```

   `hashes.pdfium` is the PDFium commit and `version` the Chrome release. Stable
   moves every four weeks and picks up security fixes between releases.

2. `gclient sync`, rebuild, and regenerate the reference renders:

   ```sh
   bare scripts/pdfium-fixtures.js <root>/pdfium
   ```

   Review any page the fixture script reports as dropped before accepting it.

## Prebuilds

`.github/workflows/prebuild.yml` builds prebuilds for every target
(linux x64/arm64, android arm64/arm/x64/ia32, darwin x64/arm64, ios arm64 +
simulators, win32 x64/arm64) via the holepunch `compile-prebuilds` actions, then
merges them. Run it from the Actions tab (`workflow_dispatch`).
`.github/workflows/publish.yml` runs when a `v*` tag is pushed: it builds the same
set and publishes it to npm through trusted publishing (no npm token), then
creates a GitHub release. Tag the commit whose `package.json` has that version. A
tag newer than npm's current `latest` publishes as `latest`; an older one
publishes as `release-<major>.<minor>`.

## Licensing

This wrapper is Apache-2.0. The bundled PDFium (shipped in `prebuilds/`) is
BSD-3-Clause and Apache-2.0 (© The PDFium Authors) and statically links further
permissive components, along with LLVM's libc++ outside Windows and its libc++abi and libunwind on
Linux and Android. See `NOTICE.md`
— a shipping application must carry these attributions.

## Why not pdf.js?

pdf.js's canvas-free serverless build does text extraction only — it has no
canvas factory and cannot rasterize a page. Wiring a Bare Canvas2D into pdf.js is
far more surface area than binding PDFium's page renderer directly.
