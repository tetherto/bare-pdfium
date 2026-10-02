const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const png = require('bare-png')
const pdfium = require('..')

const JPEG = fs.readFileSync(path.join(__dirname, 'fixtures', 'compose', 'photo.jpg'))

const TRUETYPE = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  'C:\\Windows\\Fonts\\arial.ttf'
].find((file) => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
})

function texts(pdf) {
  return [...pdfium.textPages(pdf)].map(({ text }) => text)
}

function gradientPng(width, height) {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 200
    data[i * 4 + 1] = (i * 7) % 256
    data[i * 4 + 2] = 40
    data[i * 4 + 3] = 255
  }
  return png.encode({ width, height, data })
}

function inkBox(pdf, page) {
  const { width, height, data } = pdfium.render(pdf, page, { scale: 1 })
  let top = height
  let bottom = -1
  let left = width
  let right = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
        left = Math.min(left, x)
        right = Math.max(right, x)
      }
    }
  }
  return { top, bottom, left, right, width, height }
}

test('addPage and draw place text, shapes and lines on a new page', (t) => {
  const doc = pdfium.create()
  t.is(doc.addPage({ width: 300, height: 200 }), 0)
  const font = doc.loadFont('Helvetica')
  doc.draw(0, [
    { type: 'rect', x: 10, y: 10, width: 100, height: 50, fill: [200, 0, 0] },
    { type: 'line', x1: 0, y1: 100, x2: 300, y2: 100, color: [0, 0, 255], lineWidth: 2 },
    { type: 'text', text: 'Hello blank page', font, size: 14, x: 20, y: 150 }
  ])
  const pdf = doc.save()
  doc.close()

  t.alike(pdfium.open(pdf).pageSize(0), { width: 300, height: 200 })
  t.ok(texts(pdf)[0].includes('Hello blank page'))
  const { data, width } = pdfium.render(pdf, 0, { scale: 1 })
  const at = (x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)]
  t.alike(at(50, 170), [200, 0, 0], 'the rectangle is filled')
  t.ok(at(150, 100)[2] > 200 && at(150, 100)[0] < 80, 'the line is drawn')
})

test('addPage inserts at a position and keeps existing pages', (t) => {
  const doc = pdfium.create()
  doc.addPage()
  doc.addPage({ width: 200, height: 100, at: 0 })
  t.is(doc.pageCount(), 2)
  t.alike(doc.pageSize(0), { width: 200, height: 100 })
  t.exception.all(() => doc.addPage({ at: 5 }), /at must be/)
  t.exception.all(() => doc.addPage({ width: 0 }), /width must be/)
  doc.close()
})

test('measureText scales with the font size', (t) => {
  const doc = pdfium.create()
  const font = doc.loadFont('Helvetica')
  const small = doc.measureText('Measure me', font, 10)
  t.ok(small > 30 && small < 70, `Helvetica 10pt width is plausible (${small})`)
  t.ok(Math.abs(doc.measureText('Measure me', font, 20) - 2 * small) < 0.001)
  t.ok(
    doc.measureText('WWW', font, 10) > doc.measureText('iii', font, 10),
    'widths come from the font'
  )
  const { ascent, descent } = doc.fontMetrics(font, 10)
  t.ok(ascent > 5 && descent < 0)
  t.exception.all(() => doc.measureText('x', 99, 10), /unknown font/)
  t.exception.all(() => doc.loadFont('Comic Sans'), /built-in font/)
  doc.close()
})

test('draw places PNG and JPEG images', (t) => {
  const doc = pdfium.create()
  doc.addPage({ width: 300, height: 300 })
  doc.draw(0, [
    { type: 'image', image: gradientPng(20, 10), x: 10, y: 10, width: 100, height: 50 },
    { type: 'image', image: JPEG, x: 150, y: 150, width: 120, height: 90 }
  ])
  const pdf = doc.save()
  doc.close()
  t.is(pdfium.open(pdf).extractImages(0).length, 2)
})

test('draw rejects bad items', (t) => {
  const doc = pdfium.create()
  doc.addPage()
  t.exception.all(() => doc.draw(0, [{ type: 'circle' }]), /type of text, rect, line, image/)
  t.exception.all(
    () => doc.draw(0, [{ type: 'rect', x: 0, y: 0, width: 1 }]),
    /height must be a number/
  )
  t.exception.all(
    () => doc.draw(0, [{ type: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: [300, 0, 0] }]),
    /line color/
  )
  t.exception.all(
    () =>
      doc.draw(0, [{ type: 'image', image: Buffer.from('nope'), x: 0, y: 0, width: 1, height: 1 }]),
    /PNG or JPEG/
  )
  t.exception.all(() => doc.draw(3, []), /out of range/)
  doc.close()
})

test('drawAsync matches draw', async (t) => {
  const doc = pdfium.create()
  doc.addPage({ width: 200, height: 200 })
  const font = doc.loadFont('Times-Roman')
  await doc.drawAsync(0, [
    { type: 'text', text: 'Drawn off the main thread', font, size: 12, x: 10, y: 100 }
  ])
  const pdf = await doc.saveAsync()
  doc.close()
  t.ok(texts(pdf)[0].includes('Drawn off the main thread'))
})

test('compose lays out Markdown into a PDF', (t) => {
  const pdf = pdfium.compose(
    [
      '# Quarterly Report',
      '',
      'Revenue grew **18%**, driven by *pear* sales and `cold-chain` sites.',
      '',
      '## Highlights',
      '',
      '- Three new sites',
      '- Irrigation upgrade',
      '  - North field',
      '  - South field',
      '',
      '1. First',
      '2. Second',
      '',
      '> Growth came from the regions we invested in.',
      '',
      '| Region | Revenue |',
      '| --- | --- |',
      '| North | $1.2M |',
      '',
      '```',
      'const total = north + south',
      '```',
      '',
      '---',
      '',
      'The end.'
    ].join('\n')
  )
  const [text] = texts(pdf)
  const order = [
    'Quarterly Report',
    'Revenue grew 18%, driven by pear sales and cold-chain sites.',
    'Highlights',
    'Three new sites',
    'North field',
    'South field',
    '1. First',
    '2. Second',
    'Growth came from the regions we invested in.',
    'Region',
    '$1.2M',
    'const total = north + south',
    'The end.'
  ]
  let at = -1
  for (const piece of order) {
    const next = text.indexOf(piece, at + 1)
    t.ok(next > at, `'${piece}' appears in order`)
    at = next
  }
  t.absent(text.includes('**') || text.includes('`'), 'inline markers are not printed')
})

test('compose flows long content across pages inside the margins', (t) => {
  const words = Array.from({ length: 3000 }, (_, i) => `word${i}`)
  const pdf = pdfium.compose([{ type: 'paragraph', text: words.join(' ') }], { margin: 50 })
  const pages = texts(pdf)
  t.ok(pages.length > 3, `spans ${pages.length} pages`)
  const all = pages.join(' ').split(/\s+/).filter(Boolean)
  t.alike(all, words, 'every word appears once, in order')

  for (let page = 0; page < pages.length; page++) {
    const box = inkBox(pdf, page)
    t.ok(
      box.left >= 49 && box.right <= box.width - 49,
      `page ${page + 1} stays inside the side margins`
    )
    t.ok(
      box.top >= 49 && box.bottom <= box.height - 49,
      `page ${page + 1} stays inside the top and bottom margins`
    )
  }
})

test('compose repeats a table header on every page the table spans', (t) => {
  const rows = Array.from({ length: 120 }, (_, i) => [`row ${i + 1}`, String(i * 2)])
  const pdf = pdfium.compose([{ type: 'table', header: ['Label', 'Double'], rows }])
  const pages = texts(pdf)
  t.ok(pages.length >= 3)
  for (const page of pages) {
    t.ok(page.includes('Label') && page.includes('Double'), 'header on the page')
  }
  t.ok(pages.join('\n').includes('row 120'), 'the last row is there')
})

test('compose wraps long table cells', (t) => {
  const long = 'This note is far too long to fit on one line of a narrow column, so it wraps.'
  const pdf = pdfium.compose([{ type: 'table', header: ['A', 'B', 'C'], rows: [['x', long, 'y']] }])
  const box = inkBox(pdf, 0)
  t.ok(box.right <= box.width - 56, 'the table stays inside the right margin')
  t.ok(texts(pdf)[0].replace(/\s+/g, ' ').includes(long))
})

test('compose places images from blocks and data URIs', (t) => {
  const image = gradientPng(40, 20)
  const pdf = pdfium.compose([
    { type: 'image', data: image, caption: 'A gradient' },
    { type: 'image', data: JPEG, width: 100 }
  ])
  t.is(pdfium.open(pdf).extractImages(0).length, 2)
  t.ok(texts(pdf)[0].includes('A gradient'))

  const fromMarkdown = pdfium.compose(`![chart](data:image/png;base64,${image.toString('base64')})`)
  t.is(pdfium.open(fromMarkdown).extractImages(0).length, 1)
  const linked = pdfium.compose('![a chart](https://example.com/chart.png)')
  t.ok(texts(linked)[0].includes('[a chart]'), 'a remote image becomes its alt text')
})

test('compose supports page size, landscape, page breaks and page numbers', (t) => {
  const pdf = pdfium.compose('First page\n\n\\pagebreak\n\nSecond page', {
    pageSize: 'Letter',
    landscape: true,
    pageNumbers: true
  })
  const doc = pdfium.open(pdf)
  t.is(doc.pageCount(), 2)
  t.alike(doc.pageSize(0), { width: 792, height: 612 })
  doc.close()
  const pages = texts(pdf)
  t.ok(pages[0].includes('First page') && pages[0].includes('1 / 2'))
  t.ok(pages[1].includes('Second page') && pages[1].includes('2 / 2'))
})

test('compose accepts runs and nested list items as blocks', (t) => {
  const pdf = pdfium.compose([
    { type: 'paragraph', text: [{ text: 'Bold ', bold: true }, { text: 'and plain' }] },
    { type: 'list', ordered: true, items: ['one', { text: 'two', items: ['two a', 'two b'] }] }
  ])
  const [text] = texts(pdf)
  t.ok(text.includes('Bold and plain'))
  t.ok(text.includes('2. two') && text.includes('two b'))
})

test('compose draws text in the built-in fonts only when they can', (t) => {
  t.ok(texts(pdfium.compose('Café “quoted” — €5'))[0].includes('Café “quoted” — €5'))
  t.exception.all(() => pdfium.compose('Tokyo 東京'), /U\+6771.*TrueType font/)
  t.exception.all(() => pdfium.compose('Москва'), /U\+041C/)
})

test('compose drops emoji and swaps symbols the built-in fonts lack', (t) => {
  const [text] = texts(
    pdfium.compose('Ferns 🌿🌱 daily → soil ≥ 2 cm. ✅ done ❌ not 👍🏽 🇧🇷 👨‍👩‍👧 Łódź ﬁne © ™')
  )
  t.is(text.replace(/\s+/g, ' ').trim(), 'Ferns daily -> soil >= 2 cm. v done x not Lódz fine © ™')
})

test('compose drops emoji with a TrueType font too', { skip: !TRUETYPE }, (t) => {
  const [text] = texts(pdfium.compose('Ferns 🌿 grow', { font: fs.readFileSync(TRUETYPE) }))
  t.is(text.replace(/\s+/g, ' ').trim(), 'Ferns grow')
})

test('compose draws any script with a TrueType font', { skip: !TRUETYPE }, (t) => {
  const font = fs.readFileSync(TRUETYPE)
  const text = 'Москва · Ελληνικά'
  const pdf = pdfium.compose([{ type: 'paragraph', text }], { font })
  t.ok(texts(pdf)[0].includes(text))
})

test('compose can encrypt what it writes', async (t) => {
  const pdf = pdfium.compose('Secret plans', { encrypt: { password: 'pw' } })
  t.exception(() => pdfium.open(pdf))
  t.ok([...pdfium.textPages(pdf, { password: 'pw' })][0].text.includes('Secret plans'))
  const later = await pdfium.composeAsync('Async plans', { encrypt: { password: 'pw' } })
  t.ok([...pdfium.textPages(later, { password: 'pw' })][0].text.includes('Async plans'))
})

test('compose explains bad input', (t) => {
  t.exception.all(() => pdfium.compose(42), /Markdown string or an array of blocks/)
  t.exception.all(() => pdfium.compose([{ type: 'chart' }]), /block type must be one of/)
  t.exception.all(() => pdfium.compose('x', { pageSize: 'B7' }), /pageSize must be/)
  t.exception.all(() => pdfium.compose('x', { font: 'Comic Sans' }), /font must be/)
  t.exception.all(() => pdfium.compose('x', { margin: 400 }), /margin leaves no room/)
  t.exception.all(() => pdfium.compose([{ type: 'heading', level: 9, text: 'x' }]), /heading level/)
  t.exception.all(
    () => pdfium.compose([{ type: 'image', data: Buffer.from('nope') }]),
    /PNG or JPEG/
  )
})

function pageLines(pdf) {
  return texts(pdf).map((page) =>
    page
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  )
}

test('compose never leaves one line of a paragraph alone on a page', (t) => {
  const blocks = Array.from({ length: 60 }, (_, p) => ({
    type: 'paragraph',
    text: Array.from({ length: 9 + ((p * 7) % 40) }, (_, w) => `p${p}w${w}`).join(' ')
  }))
  const pages = pageLines(pdfium.compose(blocks))
  t.ok(pages.length > 3)
  const owner = (line) => /p(\d+)w/.exec(line)?.[1]
  for (let i = 0; i + 1 < pages.length; i++) {
    const tail = owner(pages[i].at(-1))
    const head = owner(pages[i + 1][0])
    if (tail !== head) continue
    const before = pages[i].filter((line) => owner(line) === tail).length
    const after = pages[i + 1].filter((line) => owner(line) === head).length
    t.ok(before >= 2 && after >= 2, `paragraph ${tail} splits ${before} / ${after}`)
  }
})

test('compose keeps a heading with the text after it', (t) => {
  const blocks = []
  for (let s = 0; s < 40; s++) {
    blocks.push({ type: 'heading', level: 2, text: `Section ${s}` })
    blocks.push({
      type: 'paragraph',
      text: Array.from({ length: 30 + (s % 4) * 12 }, (_, w) => `s${s}w${w}`).join(' ')
    })
  }
  const pages = pageLines(pdfium.compose(blocks))
  for (const lines of pages) {
    t.absent(/^Section \d+$/.test(lines.at(-1)), `a page ends with "${lines.at(-1)}"`)
  }
})

test('compose draws each list bullet beside its item, across page breaks', (t) => {
  const items = Array.from({ length: 80 }, (_, n) =>
    Array.from({ length: 10 + ((n * 5) % 25) }, (_, w) => `i${n}w${w}`).join(' ')
  )
  const pages = pageLines(pdfium.compose([{ type: 'list', items }]))
  const lines = pages.flat()
  for (let n = 0; n < items.length; n++) {
    const line = lines.find((l) => l.includes(`i${n}w0 `) || l.endsWith(`i${n}w0`))
    t.ok(line && line.startsWith('•'), `item ${n} starts with its bullet`)
  }
})

test('compose keeps Markdown list numbering and loose lists', (t) => {
  const [started] = texts(pdfium.compose('3. third\n4. fourth'))
  t.ok(started.includes('3. third') && started.includes('4. fourth'))
  const [loose] = texts(pdfium.compose('1. one\n\n2. two\n\n3. three'))
  t.ok(loose.includes('1. one') && loose.includes('2. two') && loose.includes('3. three'))
  const [nested] = texts(pdfium.compose('- a\n  5. five\n  6. six'))
  t.ok(nested.includes('5. five') && nested.includes('6. six'))
  const [split] = texts(pdfium.compose('- bullet\n\n1. number'))
  t.ok(
    split.includes('• bullet') && split.includes('1. number'),
    'a different marker starts a new list'
  )
})

test('compose keeps a # that ends a heading', (t) => {
  const [text] = texts(pdfium.compose('## Intro to C#\n\n# F#\n\n# Closed ##'))
  t.ok(text.includes('Intro to C#'))
  t.ok(text.includes('F#'))
  t.ok(text.includes('Closed') && !text.includes('Closed #'))
})

test('compose reads inline Markdown the way it is written', (t) => {
  const [text] = texts(
    pdfium.compose(
      [
        '2 ** 10 = 1024 and 3 * 4 = 12',
        '',
        'Use `<br>` and `arr[0](x)` in code.',
        '',
        'See [the docs](https://example.com/a_(b)) for more.'
      ].join('\n')
    )
  )
  t.ok(text.includes('2 ** 10 = 1024 and 3 * 4 = 12'))
  t.ok(text.includes('Use <br> and arr[0](x) in code.'))
  t.ok(text.includes('See the docs for more.'))
})

test('compose keeps decomposed accents with the built-in fonts', (t) => {
  t.ok(texts(pdfium.compose('café and naïve'))[0].includes('café and naïve'))
})

const SMALL = { pageSize: [400, 400], margin: 50, fontSize: 10, lineHeight: 1.4 }

function lines(prefix, count) {
  return [{ text: Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join('\n') }]
}

test('compose moves a 3-line paragraph whole when only 2 lines fit', (t) => {
  const pages = pageLines(
    pdfium.compose(
      [
        { type: 'paragraph', text: lines('f', 19) },
        { type: 'paragraph', text: lines('x', 3) }
      ],
      SMALL
    )
  )
  t.is(pages.length, 2)
  t.absent(
    pages[0].some((line) => /^x\d$/.test(line)),
    'no line of the 3-line paragraph is left behind'
  )
  t.alike(pages[1], ['x1', 'x2', 'x3'])
})

test('compose moves a heading when the gap under it leaves room for one line', (t) => {
  const pages = pageLines(
    pdfium.compose(
      [
        { type: 'paragraph', text: lines('f', 16) },
        { type: 'heading', level: 2, text: 'Stranded?' },
        { type: 'paragraph', text: lines('x', 3) }
      ],
      SMALL
    )
  )
  t.absent(pages[0].includes('Stranded?'), 'the heading is not left at the foot of the page')
  t.alike(pages[1], ['Stranded?', 'x1', 'x2', 'x3'])
})

test('compose and draw errors carry a code', (t) => {
  const code = (fn) => {
    try {
      fn()
    } catch (err) {
      return err.code
    }
    return null
  }
  t.is(
    code(() => pdfium.compose([{ type: 'chart' }])),
    'INVALID_ARGUMENT'
  )
  t.is(
    code(() => pdfium.compose('Tokyo 東京')),
    'UNSUPPORTED_TEXT'
  )
  t.is(
    code(() => pdfium.compose([{ type: 'image', data: Buffer.from('nope') }])),
    'IMAGE'
  )
  const doc = pdfium.create()
  doc.addPage()
  t.is(
    code(() => doc.measureText('x', 7, 10)),
    'FONT'
  )
  t.is(
    code(() => doc.draw(4, [])),
    'PAGE_RANGE'
  )
  t.is(
    code(() => doc.draw(0, [{ type: 'text', text: 'x', font: 9, x: 0, y: 0 }])),
    'FONT'
  )
  doc.close()
})
