const fs = require('bare-fs')
const path = require('bare-path')

const [checkout] = Bare.argv.slice(2)

if (!checkout) {
  console.error('usage: bare scripts/pdfium-sources.js <pdfium checkout>')
  Bare.exit(1)
}

const targets = [
  'core/fdrm',
  'core/fpdfapi/cmaps',
  'core/fpdfapi/edit',
  'core/fpdfapi/font',
  'core/fpdfapi/page',
  'core/fpdfapi/parser',
  'core/fpdfapi/render',
  'core/fpdfdoc',
  'core/fpdftext',
  'core/fxcodec',
  'core/fxcrt',
  'core/fxge',
  'fpdfsdk',
  'fpdfsdk/formfiller',
  'fpdfsdk/pwl',
  'fxjs',
  'third_party'
]

const excluded = [
  ['tests', /_(unittest|embeddertest)\.cpp$/],
  ['V8', /^fxjs\//],
  ['XFA', /^third_party\/(bigint|libtiff)\//],
  ['XFA', /^core\/fxcodec\/(bmp|gif|png|tiff)\//],
  [
    'XFA',
    /^core\/fxcodec\/(cfx_codec_memory|progressive_decoder|progressive_decoder_context)\.cpp$/
  ],
  ['XFA', /^core\/fxcodec\/jpeg\/libjpeg_jpeg_context\.cpp$/],
  ['XFA', /^core\/fxcrt\/cfx_memorystream\.cpp$/],
  ['XFA', /^core\/fpdfapi\/parser\/cpdf_seekablemultistream\.cpp$/],
  ['XFA', /^core\/fxge\/cfx_cttnametable\.cpp$/],
  ['Skia', /(^|\/)skia\/|_sk_/],
  ['Rust', /\/rust_|\/skrifa\//],
  ['PartitionAlloc', /^core\/fxcrt\/fx_memory_pa\.cpp$/],
  ['brotli', /\/brotli\//]
]

const upstream = new Set()

for (const target of targets) {
  const gn = fs.readFileSync(path.join(checkout, target, 'BUILD.gn'), 'utf8')

  let depth = 0
  let test = false

  for (const line of gn.split('\n')) {
    if (depth === 0 && /^[a-z_]+\(/.test(line)) test = /test|fuzzer/.test(line)

    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length

    if (test) continue

    for (const [, file] of line.matchAll(/"([^"/][^"]*\.(?:c|cc|cpp))"/g)) {
      upstream.add(path.posix.join(target, file))
    }
  }
}

const cmake = fs.readFileSync(
  path.join(__dirname, '..', 'cmake', 'pdfium', 'sources.cmake'),
  'utf8'
)
const ours = new Set(cmake.match(/^ {2}\S+$/gm).map((line) => line.trim()))

const missing = [...ours].filter((file) => !fs.existsSync(path.join(checkout, file)))
const removed = [...ours].filter((file) => !upstream.has(file))
const unclaimed = [...upstream].filter(
  (file) => !ours.has(file) && !excluded.some(([, pattern]) => pattern.test(file))
)

for (const file of missing) console.log(`missing from checkout: ${file}`)
for (const file of removed) console.log(`no longer in PDFium's GN targets: ${file}`)
for (const file of unclaimed)
  console.log(`new in PDFium's GN targets, add to sources.cmake or exclude: ${file}`)

if (missing.length || removed.length || unclaimed.length) Bare.exit(1)

console.log(
  `sources.cmake matches PDFium's GN targets (${ours.size} compiled, ${upstream.size - ours.size} excluded)`
)
