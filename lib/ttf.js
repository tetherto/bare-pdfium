function view(data) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

function tableOffset(dv, base, tag) {
  const count = dv.getUint16(base + 4)
  for (let i = 0; i < count; i++) {
    const record = base + 12 + i * 16
    let name = ''
    for (let k = 0; k < 4; k++) name += String.fromCharCode(dv.getUint8(record + k))
    if (name === tag) return dv.getUint32(record + 8)
  }
  return -1
}

function format4(dv, offset) {
  const segments = dv.getUint16(offset + 6) / 2
  const ends = offset + 14
  const starts = ends + segments * 2 + 2
  const deltas = starts + segments * 2
  const ranges = deltas + segments * 2
  const list = []
  for (let i = 0; i < segments; i++) {
    list.push({
      start: dv.getUint16(starts + i * 2),
      end: dv.getUint16(ends + i * 2),
      delta: dv.getInt16(deltas + i * 2),
      range: dv.getUint16(ranges + i * 2),
      rangeAt: ranges + i * 2
    })
  }
  return (code) => {
    if (code > 0xffff) return false
    for (const segment of list) {
      if (code > segment.end) continue
      if (code < segment.start) return false
      if (segment.range === 0) return ((code + segment.delta) & 0xffff) !== 0
      const at = segment.rangeAt + segment.range + (code - segment.start) * 2
      if (at + 2 > dv.byteLength) return false
      const glyph = dv.getUint16(at)
      return glyph !== 0 && ((glyph + segment.delta) & 0xffff) !== 0
    }
    return false
  }
}

function format12(dv, offset) {
  const groups = dv.getUint32(offset + 12)
  const list = []
  for (let i = 0; i < groups; i++) {
    const at = offset + 16 + i * 12
    list.push([dv.getUint32(at), dv.getUint32(at + 4), dv.getUint32(at + 8)])
  }
  return (code) => {
    let low = 0
    let high = list.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const [start, end, glyph] = list[mid]
      if (code < start) high = mid - 1
      else if (code > end) low = mid + 1
      else return glyph + (code - start) !== 0
    }
    return false
  }
}

const PREFERENCE = [
  [3, 10, 12],
  [0, 4, 12],
  [0, 6, 12],
  [3, 1, 4],
  [0, 3, 4],
  [0, 1, 4],
  [0, 0, 4]
]

module.exports = function coverage(data) {
  try {
    const dv = view(data)
    let base = 0
    if (dv.getUint32(0) === 0x74746366) base = dv.getUint32(12)
    const cmap = tableOffset(dv, base, 'cmap')
    if (cmap < 0) return null
    const count = dv.getUint16(cmap + 2)
    const tables = []
    for (let i = 0; i < count; i++) {
      const record = cmap + 4 + i * 8
      const offset = cmap + dv.getUint32(record + 4)
      tables.push({
        platform: dv.getUint16(record),
        encoding: dv.getUint16(record + 2),
        format: dv.getUint16(offset),
        offset
      })
    }
    for (const [platform, encoding, format] of PREFERENCE) {
      const table = tables.find(
        (t) => t.platform === platform && t.encoding === encoding && t.format === format
      )
      if (!table) continue
      return format === 12 ? format12(dv, table.offset) : format4(dv, table.offset)
    }
    return null
  } catch {
    return null
  }
}
