# `open(bytes)` vs `openFile(path)` — memory & time

Reading the **same** large PDF two ways, extracting the text of every page.

## Setup

| | |
|---|---|
| PDF | 256 MB, 20,000 pages, ~224 M chars of text (`bench/gen-pdf.mjs`) |
| Work | `open` the document, iterate `textPages()` over all 20,000 pages, `close` |
| Binary | `bare-pdfium@1.4.0-next.0` — both code paths in one build (apples-to-apples) |
| Host | darwin-arm64, Bare runtime |
| Peak RSS | `/usr/bin/time -l` (max resident set size of the process) |
| Runs | 2 per mode |

`bytes` = `pdfium.open(fs.readFileSync(path))` (the only option before 1.4).
`file` = `pdfium.openFile(path)` (reads pages from disk on demand).

## Results

| Mode | Peak RSS | Open time | Extract time | Total |
|------|---------:|----------:|-------------:|------:|
| `open(bytes)` | **1481 MB** / 1480 MB | 71 / 87 ms | 35.6 / 36.8 s | 35.7 / 36.9 s |
| `openFile(path)` | **970 MB** / 970 MB | 8 / 7 ms | 37.1 / 37.1 s | 37.1 / 37.1 s |

### Deltas (averages)

| Metric | `open(bytes)` | `openFile(path)` | Difference |
|--------|-------------:|-----------------:|-----------|
| **Peak RSS** | 1480 MB | 970 MB | **−510 MB (−34%)** |
| **Open time** | 79 ms | 7.5 ms | **~10× faster** |
| **Extract time** | 36.2 s | 37.1 s | +0.9 s (~2%, on-demand reads) |
| **Total time** | 36.3 s | 37.1 s | +0.8 s (~2%) |

## How it scales

Same benchmark on smaller PDFs (2 runs each, peak RSS):

| Pages | File | `open(bytes)` RSS | `openFile` RSS | Saved | ≈ ×file |
|------:|-----:|------------------:|---------------:|------:|--------:|
| 100 | 1.3 MB | 65.2 MB | 63.8 MB | 1.4 MB | 1.1× |
| 200 | 2.6 MB | 73.5 MB | 68.2 MB | 5.3 MB | 2.0× |
| 300 | 3.9 MB | 82.3 MB | 72.8 MB | 9.5 MB | 2.4× |
| 20,000 | 256 MB | 1480 MB | 970 MB | 510 MB | 2.0× |

Both modes sit on a ~60 MB Bare-runtime floor, so small files barely differ — but the
saved memory tracks **~2× the file size** and grows with every page. Total time was
within noise at every size (extraction dominates); open time only separates at the
large end (79 ms vs 7.5 ms).

## What it means

- **Memory is the real win.** `open(bytes)` holds the file twice while parsing —
  a 256 MB JS `Buffer` **plus** PDFium's own 256 MB in-memory copy. That ~512 MB
  of duplicated source is exactly the gap we see (−510 MB). `openFile` keeps
  neither: PDFium pulls the bytes it needs from disk through the read callback.
- **The saving scales with file size**, because it *is* ~2× the file size. A 1 GB
  PDF would save ~2 GB of peak RSS. On a memory-constrained device this is often
  the difference between finishing and an OOM kill — not a 34% tuning gain.
- **Opening is ~10× faster** with `openFile`: no upfront 256 MB read-and-copy
  before the first page is available. Handy for "just read page 1" work.
- **Extraction time is a wash.** Pulling the actual text out of 20,000 pages is
  the same PDFium work either way and dominates the total (~36–37 s); `openFile`
  is marginally slower from the on-demand disk reads, within noise.

## Caveat

In-product, attachments are capped at 32 MB, where the duplicated copy is ~32 MB —
negligible. `openFile` earns its keep only if that cap is raised to allow genuinely
large PDFs; until then the win is latency-on-open and headroom, not a fix for a
problem the product currently hits.

## Reproduce

```sh
node bench/gen-pdf.mjs big.pdf 20000 150         # ~256 MB, 20k pages
/usr/bin/time -l bare bench/run.js bytes big.pdf # peak RSS + timings
/usr/bin/time -l bare bench/run.js file  big.pdf
```
