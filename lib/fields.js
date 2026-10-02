const { invalid, failure } = require('./errors')

function groupFields(widgets) {
  const fields = new Map()
  for (const widget of widgets) {
    let field = fields.get(widget.name)
    if (!field) {
      field = { widgets: [], ...widget }
      fields.set(widget.name, field)
    }
    field.widgets.push(widget)
  }

  return [...fields.values()].map((field) => {
    const { type } = field
    const result = {
      name: field.name,
      type,
      value: null,
      page: field.page,
      readOnly: field.readOnly,
      required: field.required
    }

    if (type === 'text') {
      result.value = field.value
    } else if (type === 'checkbox') {
      result.value = field.widgets.some((widget) => widget.checked)
      const exports = [...new Set(field.widgets.map((widget) => widget.exportValue))]
      if (exports.length > 1) result.options = exports
    } else if (type === 'radio') {
      const checked = field.widgets.find((widget) => widget.checked)
      result.value = checked ? checked.exportValue : null
      result.options = [...new Set(field.widgets.map((widget) => widget.exportValue))]
    } else if (type === 'combobox') {
      result.value = field.value || null
      result.options = field.options
      result.editable = field.editable
    } else if (type === 'listbox') {
      const selected = field.options.filter((_, i) => field.selected[i])
      result.multiSelect = field.multiSelect
      result.value = result.multiSelect ? selected : (selected[0] ?? null)
      result.options = field.options
    }

    return result
  })
}

function prepareFill(list, values) {
  const fields = new Map(list.map((field) => [field.name, field]))
  const names = Object.keys(values)
  if (names.length === 0) throw invalid('pass at least one field to fill')

  const filled = names.map((name) => {
    const field = fields.get(name)
    if (!field) {
      const known = [...fields.keys()]
      throw known.length
        ? failure(
            'FIELD_NOT_FOUND',
            `no field named '${name}'; the form has ${JSON.stringify(known)}`
          )
        : failure('NO_FORM', 'the document has no form fields')
    }
    return fillValue(field, values[name])
  })

  return { names, filled }
}

function checkFill(list, names, filled, values) {
  const after = new Map(list.map((field) => [field.name, field]))
  for (const [i, name] of names.entries()) {
    if (!sameValue(after.get(name), filled[i])) {
      throw failure(
        'FIELD_REJECTED',
        `field '${name}' did not take the value ${JSON.stringify(values[name])}`
      )
    }
  }
  return names.map((name) => after.get(name))
}

function sameValue(field, value) {
  if (field.type === 'listbox' && field.multiSelect) {
    return field.value.length === value.length && value.every((item) => field.value.includes(item))
  }
  if (Array.isArray(value)) return field.value === value[0]
  if (field.type === 'checkbox' && typeof value === 'string') {
    return field.value === (value !== 'Off')
  }
  return field.value === value
}

function fillValue(field, value) {
  const { name, type } = field

  if (field.readOnly) throw failure('FIELD_READ_ONLY', `field '${name}' is read-only`)

  if (type === 'text') {
    if (typeof value === 'number') value = String(value)
    if (typeof value !== 'string') throw invalid(`field '${name}' is text; pass a string`)
    return value
  }

  if (type === 'checkbox') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string' && (value === 'Off' || (field.options || []).includes(value))) {
      return value
    }
    throw invalid(`field '${name}' is a checkbox; pass true or false`)
  }

  if (type === 'radio') {
    if (!field.options.includes(value)) {
      throw invalid(
        `field '${name}' is a radio group; pass one of ${JSON.stringify(field.options)}`
      )
    }
    return value
  }

  if (type === 'combobox') {
    if (typeof value !== 'string') throw invalid(`field '${name}' is a dropdown; pass a string`)
    if (field.options.includes(value)) return [value]
    if (field.editable) return value
    throw invalid(`field '${name}' accepts one of ${JSON.stringify(field.options)}`)
  }

  if (type === 'listbox') {
    const items = Array.isArray(value) ? value : [value]
    if (!field.multiSelect && items.length > 1) {
      throw invalid(`field '${name}' takes a single selection`)
    }
    for (const item of items) {
      if (!field.options.includes(item)) {
        throw invalid(`field '${name}' accepts ${JSON.stringify(field.options)}`)
      }
    }
    return items
  }

  throw failure('FIELD_TYPE', `field '${name}' is a ${type} and cannot be filled`)
}

// An open PDF. Loading parses the whole file once; every page operation reuses
// that, so batch work (classify then render a few pages) goes through here
// rather than the one-shot helpers below. Always close() it.

module.exports = { groupFields, prepareFill, checkFill }
