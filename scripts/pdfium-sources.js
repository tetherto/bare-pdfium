const fs = require('bare-fs')
const path = require('bare-path')

const [checkout, icu] = Bare.argv.slice(2)

if (!checkout || !icu) {
  console.error('usage: bare scripts/pdfium-sources.js <pdfium checkout> <chromium icu checkout>')
  if (checkout) {
    const deps = fs.readFileSync(path.join(checkout, 'DEPS'), 'utf8')
    const [, revision] = deps.match(/'icu_revision': '([0-9a-f]+)'/)
    console.error(
      `PDFium builds against https://chromium.googlesource.com/chromium/deps/icu at ${revision}`
    )
  }
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

let failed = missing.length > 0 || removed.length > 0 || unclaimed.length > 0

if (!failed) {
  console.log(
    `sources.cmake matches PDFium's GN targets (${ours.size} compiled, ${upstream.size - ours.size} excluded)`
  )
}

// Defines are compared regardless of the GN conditions around them, so review those by hand.
const libraries = [
  {
    name: 'harfbuzz',
    gn: path.join(checkout, 'third_party', 'harfbuzz', 'BUILD.gn'),
    ignored: [['component builds', /^HB_EXTERN=/]]
  },
  {
    name: 'icu',
    target: 'icuuc',
    gn: path.join(icu, 'BUILD.gn'),
    ignored: [
      ['V8 and Blink', /^USE_CHROMIUM_ICU=/],
      ["Chromium's UMA tracer", /^U_ENABLE(_RESOURCE)?_TRACING=/],
      ["Chromium's data loader", /^ICU_UTIL_DATA_IMPL=/],
      ["Chromium's data file, stubbed here", /^(U_HIDE_DATA_SYMBOL|U_ICUDATAENTRY_IN_COMMON)$/],
      ['icui18n', /^U_I18N_IMPLEMENTATION$/],
      ['MSVC without clang', /^_SILENCE_CXX17_C_HEADER_DEPRECATION_WARNING$/],
      ['wasm', /^__i386__$/]
    ]
  }
]

for (const { name, target = name, gn, ignored } of libraries) {
  const upstream = gnDefines(gn)
  const ours = cmakeDefines(path.join(__dirname, '..', 'cmake', 'pdfium', `${name}.cmake`), target)

  const added = [...upstream].filter(
    (define) => !ours.has(define) && !ignored.some(([, pattern]) => pattern.test(define))
  )
  const dropped = [...ours].filter((define) => !upstream.has(define))

  for (const define of added)
    console.log(`new in ${name}'s GN target, add to ${name}.cmake or ignore: ${define}`)
  for (const define of dropped) console.log(`not in ${name}'s GN target: ${define}`)

  if (added.length || dropped.length) failed = true
  else console.log(`${name}.cmake matches the defines of ${name}'s GN target`)
}

if (failed) Bare.exit(1)

function gnDefines(file) {
  const gn = fs.readFileSync(file, 'utf8').replace(/#.*$/gm, '')
  const defines = new Set()

  for (const [, list] of gn.matchAll(/\bdefines\s*\+?=\s*\[([^\]]*)\]/g)) {
    for (const [, define] of list.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      defines.add(define.replace(/\\"/g, '"'))
    }
  }

  return defines
}

function cmakeDefines(file, target) {
  const cmake = fs.readFileSync(file, 'utf8')
  const defines = new Set()

  for (const [, body] of cmake.matchAll(
    new RegExp(`target_compile_definitions\\(\\s*${target}\\s([^)]*)\\)`, 'g')
  )) {
    for (const token of body.match(/"(?:[^"\\]|\\.)*"|\S+/g)) {
      if (/^(PRIVATE|PUBLIC|INTERFACE)$/.test(token)) continue
      defines.add(token.replace(/^"|"$/g, '').replace(/\\"/g, '"'))
    }
  }

  return defines
}
