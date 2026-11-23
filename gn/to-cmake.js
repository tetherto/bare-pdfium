// node gn/to-cmake.js <gn out dir> <output file>
//
// GN has no WASI toolchain, so for WASI it only describes the build
// (`gn gen --ide=json`) and CMake compiles it from that description: a static
// library for each GN target `//:pdfium` depends on, with GN's sources, defines
// and include paths, and of its compiler flags only those that mean the same on
// WebAssembly. The `pdfium` target links them all, as cmake-gn's does.

const fs = require('fs')
const path = require('path')

const [out, output] = process.argv.slice(2)

const { build_settings: settings, targets } = JSON.parse(
  fs.readFileSync(path.join(out, 'project.json'), 'utf8')
)

// Abseil's failure signal handler and stack dumps need signals, which WASI
// lacks, and nothing PDFium calls reaches them.
const skip = new Set([
  '//third_party/abseil-cpp/absl/debugging:failure_signal_handler',
  '//third_party/abseil-cpp/absl/debugging:examine_stack'
])

const flag =
  /^(-std=|-fno-exceptions$|-fno-rtti$|-fno-strict-aliasing$|-fno-delete-null-pointer-checks$|-fno-strict-overflow$|-fno-math-errno$|-ffp-contract=|-ftrivial-auto-var-init=|-fdata-sections$|-ffunction-sections$|-fsanitize(-trap)?=(array-bounds|return)$|-fvisibility=hidden$|-fvisibility-inlines-hidden$)/

const define = /^(_FORTIFY_SOURCE|_GLIBCXX_ASSERTIONS)\b/

const order = []
const seen = new Set()

walk('//:pdfium')

const lines = []
const libraries = []

for (const label of order) {
  const target = targets[label]
  if (skip.has(label) || label.includes('(')) continue
  if (target.type !== 'source_set' && target.type !== 'static_library') continue

  const sources = (target.sources || []).filter((s) => /\.(c|cc|cpp)$/.test(s))
  if (sources.length === 0) continue

  const name = 'pdfium_' + label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  libraries.push(name)

  lines.push(`add_library(${name} STATIC`, ...sources.map(quote), ')')

  const defines = (target.defines || []).filter((d) => !define.test(d))
  if (defines.length) {
    lines.push(`target_compile_definitions(${name} PRIVATE`, ...defines.map(escape), ')')
  }

  const includes = target.include_dirs || []
  if (includes.length) {
    lines.push(`target_include_directories(${name} PRIVATE`, ...includes.map(quote), ')')
  }

  const options = [
    '-w',
    ...(target.cflags || []).filter((f) => flag.test(f)),
    ...(target.cflags_c || [])
      .filter((f) => flag.test(f))
      .map((f) => `$<$<COMPILE_LANGUAGE:C>:${f}>`),
    ...(target.cflags_cc || [])
      .filter((f) => flag.test(f))
      .map((f) => `$<$<COMPILE_LANGUAGE:CXX>:${f}>`)
  ]

  lines.push(`target_compile_options(${name} PRIVATE`, ...options.map(escape), ')', '')
}

lines.push('add_library(pdfium INTERFACE)', '')
lines.push('target_link_libraries(pdfium INTERFACE', ...libraries.map((l) => '  ' + l), ')')

fs.writeFileSync(output, lines.join('\n') + '\n')

function walk(label) {
  if (seen.has(label)) return
  seen.add(label)
  for (const dep of targets[label].deps || []) walk(dep)
  order.push(label)
}

function quote(file) {
  return escape(file.startsWith('//') ? path.join(settings.root_path, file.slice(2)) : file)
}

function escape(value) {
  return '  ' + JSON.stringify(value)
}
