const test = require('brittle')
const png = require('bare-png')
const pdfium = require('..')

function codeOf(fn) {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return null
}

function smallPng() {
  return png.encode({ width: 2, height: 2, data: Buffer.alloc(16, 255) })
}

test('Markdown edge cases parse in linear time', (t) => {
  const start = Date.now()
  for (const md of [
    '#' + ' '.repeat(64000) + 'x',
    '|a|\n|' + ' '.repeat(64000) + '-|',
    'para' + ' '.repeat(64000) + 'end',
    '['.repeat(64000),
    '*'.repeat(64000),
    '- '.repeat(32000) + 'x'
  ]) {
    pdfium.compose(md)
  }
  t.ok(Date.now() - start < 5000, `${Date.now() - start} ms`)
})

test('a closing fence with trailing text stays in the code block', (t) => {
  const text = [...pdfium.textPages(pdfium.compose('```\nalpha\n```js trailing\nbeta\n```'))][0]
    .text
  t.ok(text.includes('trailing'))
  t.ok(text.includes('beta'))
})

test('compose layout stays inside the page', (t) => {
  t.is(
    codeOf(() => pdfium.compose([{ type: 'image', data: smallPng(), width: -300 }])),
    'INVALID_ARGUMENT'
  )
  const cols = 60
  const md =
    '|' + Array.from({ length: cols }, (_, i) => 'h' + i).join('|') + '|\n|' + '-|'.repeat(cols)
  t.is(
    codeOf(() => pdfium.compose(md)),
    'INVALID_ARGUMENT'
  )
  const nested = (depth) => {
    let items = ['leaf']
    for (let i = 0; i < depth; i++) items = [{ text: 'level' + i, items }]
    return [{ type: 'list', items }]
  }
  t.is(pdfium.open(pdfium.compose(nested(40))).pageCount(), 1, '40 levels fit one page')
  t.is(
    codeOf(() => pdfium.compose(nested(5000))),
    'INVALID_ARGUMENT'
  )
  t.ok(pdfium.compose('- x\n' + '  '.repeat(5000) + '- deep').length > 0)
})

test('a heading never ends a page before a rule, image or heading', (t) => {
  const image = smallPng()
  const followers = {
    rule: [{ type: 'rule' }],
    image: [{ type: 'image', data: image, width: 300 }],
    heading: [
      { type: 'heading', level: 2, text: 'Second' },
      { type: 'paragraph', text: 'body '.repeat(200) }
    ]
  }
  for (const [name, next] of Object.entries(followers)) {
    const stranded = []
    for (let n = 20; n < 42; n++) {
      const filler = Array.from({ length: n }, (_, i) => ({
        type: 'paragraph',
        text: 'filler' + i
      }))
      const pdf = pdfium.compose([
        ...filler,
        { type: 'heading', level: 1, text: 'Lonely' },
        ...next,
        { type: 'paragraph', text: 'tail' }
      ])
      const pages = [...pdfium.textPages(pdf)].map(({ text }) => text.trim().split(/\r?\n/))
      const page = pages.findIndex((lines) => lines.includes('Lonely'))
      if (page < pages.length - 1 && pages[page].at(-1) === 'Lonely') stranded.push(n)
    }
    t.alike(stranded, [], `before a ${name}`)
  }
})

test('wide list labels stay inside the left margin', (t) => {
  const { width, height, data } = pdfium.render(pdfium.compose('100. alpha'), 0)
  let left = width
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < left; x++) {
      if (data[(y * width + x) * 4] < 200) left = x
    }
  }
  t.ok(left >= 56, `ink starts at ${left}px`)
})
