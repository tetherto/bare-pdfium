const binding = require('../binding')
const { invalid, failure } = require('./errors')
const { describe } = require('./args')
const { prepareText } = require('./text')

const DRAW_KINDS = {
  text: binding.DRAW_TEXT,
  rect: binding.DRAW_RECT,
  line: binding.DRAW_LINE,
  image: binding.DRAW_IMAGE
}

function color(value, opacity = 1, where = 'color') {
  if (value === undefined || value === null) return 0
  return packColor(value, opacity, where)
}

function packColor(color, opacity, where = 'color') {
  if (!Array.isArray(color) || color.length !== 3) {
    throw invalid(`${where} must be [r, g, b] with each channel 0-255`)
  }
  if (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1)) {
    throw invalid(`opacity must be a number from 0 to 1, got ${describe(opacity)}`)
  }
  const channels = [...color, Math.round(opacity * 255)].map((channel) => {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw invalid(`${where} must be [r, g, b] with each channel 0-255`)
    }
    return channel
  })
  return ((channels[0] << 24) | (channels[1] << 16) | (channels[2] << 8) | channels[3]) >>> 0
}

function drawItem(item, fonts, images) {
  const kind =
    item !== null && typeof item === 'object' && Object.hasOwn(DRAW_KINDS, item.type)
      ? DRAW_KINDS[item.type]
      : undefined
  if (kind === undefined) {
    throw invalid(`draw items must be objects with a type of ${Object.keys(DRAW_KINDS).join(', ')}`)
  }
  const positive = (name, value, fallback) => {
    const result = number(name, value, fallback)
    if (result <= 0) throw invalid(`${item.type} ${name} must be greater than 0, got ${result}`)
    return result
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
    const font = item.font
    if (!Number.isInteger(font) || !fonts[font]) {
      throw failure(
        'FONT',
        `text items need the index of a font loaded in this document, got ${describe(font)}`
      )
    }
    return {
      kind,
      text: prepareText(item.text, fonts[font].standard, fonts[font].covers),
      font,
      size: positive('size', item.size, 12),
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

  return {
    kind,
    image: images(item.image),
    x: number('x', item.x),
    y: number('y', item.y),
    width: number('width', item.width),
    height: number('height', item.height)
  }
}

module.exports = { drawItem, packColor }
