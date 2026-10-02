const binding = require('../binding')
const { invalid } = require('./errors')

const DRAW_KINDS = {
  text: binding.DRAW_TEXT,
  rect: binding.DRAW_RECT,
  line: binding.DRAW_LINE,
  image: binding.DRAW_IMAGE
}

let compose = null

function color(value, opacity = 1, where = 'color') {
  if (value === undefined || value === null) return 0
  return packColor(value, opacity, where)
}

function packColor(color, opacity, where = 'color') {
  if (!Array.isArray(color) || color.length !== 3) {
    throw invalid(`${where} must be [r, g, b] with each channel 0-255`)
  }
  if (typeof opacity !== 'number' || opacity < 0 || opacity > 1) {
    throw invalid(`opacity must be between 0 and 1, got ${opacity}`)
  }
  const channels = [...color, Math.round(opacity * 255)].map((channel) => {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw invalid(`${where} must be [r, g, b] with each channel 0-255`)
    }
    return channel
  })
  return ((channels[0] << 24) | (channels[1] << 16) | (channels[2] << 8) | channels[3]) >>> 0
}

function drawItem(item) {
  const kind = item && DRAW_KINDS[item.type]
  if (kind === undefined) {
    throw invalid(`draw items must have a type of ${Object.keys(DRAW_KINDS).join(', ')}`)
  }
  const number = (name, value, fallback) => {
    if (value === undefined && fallback !== undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalid(`${item.type} ${name} must be a number`)
    }
    return value
  }

  if (item.type === 'text') {
    if (typeof item.text !== 'string') throw invalid('text items need a string text')
    return {
      kind,
      text: item.text,
      font: number('font', item.font),
      size: number('size', item.size, 12),
      x: number('x', item.x),
      y: number('y', item.y),
      fill: color(item.color ?? [0, 0, 0], item.opacity, 'text color')
    }
  }

  if (item.type === 'rect') {
    return {
      kind,
      x: number('x', item.x),
      y: number('y', item.y),
      width: number('width', item.width),
      height: number('height', item.height),
      fill: color(item.fill, item.opacity, 'rect fill'),
      stroke: color(item.stroke, 1, 'rect stroke'),
      lineWidth: number('lineWidth', item.lineWidth, 1)
    }
  }

  if (item.type === 'line') {
    return {
      kind,
      x: number('x1', item.x1),
      y: number('y1', item.y1),
      x2: number('x2', item.x2),
      y2: number('y2', item.y2),
      stroke: color(item.color ?? [0, 0, 0], 1, 'line color'),
      lineWidth: number('lineWidth', item.lineWidth, 1)
    }
  }

  compose ??= require('./compose')
  const image = item.image && item.image.pixelWidth ? item.image : compose.decodeImage(item.image)
  return {
    kind,
    ...image,
    x: number('x', item.x),
    y: number('y', item.y),
    width: number('width', item.width),
    height: number('height', item.height)
  }
}

module.exports = { drawItem, packColor }
