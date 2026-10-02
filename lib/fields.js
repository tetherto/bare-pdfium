const { invalid, failure, unsupportedText } = require('./errors')
const { options, describe } = require('./args')

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
      const exports = [...new Set(field.widgets.map((widget) => widget.exportValue))]
      const checked = field.widgets.find((widget) => widget.checked)
      if (exports.length > 1) {
        result.value = checked ? checked.exportValue : null
        result.options = exports
      } else {
        result.value = checked !== undefined
      }
    } else if (type === 'radio') {
      const checked = field.widgets.find((widget) => widget.checked)
      result.value = checked ? checked.exportValue : null
      result.options = [...new Set(field.widgets.map((widget) => widget.exportValue))]
    } else if (type === 'combobox') {
      const selected = field.options.find((_, i) => field.selected[i])
      result.value = selected ?? (field.value || null)
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
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw invalid(`fillFields takes an object of field names and values, got ${describe(values)}`)
  }
  const own = options(values, 'values')
  const fields = new Map(list.map((field) => [field.name, field]))
  const names = Object.keys(own)
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
    return fillValue(field, own[name])
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

function lines(text) {
  return (text ?? '').replace(/\r\n?/g, '\n')
}

function sameValue(field, value) {
  if (field.type === 'text') return lines(field.value) === lines(value)
  if (field.type === 'listbox') {
    if (field.multiSelect) {
      return (
        field.value.length === value.length && value.every((item) => field.value.includes(item))
      )
    }
    return field.value === (value[0] ?? null)
  }
  if (field.type === 'combobox') {
    if (Array.isArray(value)) return field.value === value[0]
    return (field.value ?? '') === value
  }
  if (field.type === 'checkbox') {
    if (field.options) return field.value === (value === false || value === 'Off' ? null : value)
    if (typeof value === 'string') return field.value === (value !== 'Off')
    return field.value === value
  }
  return field.value === value
}

function fillValue(field, value) {
  const { name, type } = field

  if (field.readOnly) throw failure('FIELD_READ_ONLY', `field '${name}' is read-only`)

  if (type === 'text') {
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value)
    if (typeof value !== 'string') throw invalid(`field '${name}' is text; pass a string`)
    if (value.includes('\0')) throw invalid(`field '${name}' cannot hold a NUL character`)
    if (/[\u{10000}-\u{10ffff}]/u.test(value)) {
      throw unsupportedText(
        `field '${name}' cannot hold characters outside the Basic Multilingual Plane, such as emoji`
      )
    }
    return value
  }

  if (type === 'checkbox') {
    if (field.options) {
      if (value === false || value === 'Off') return 'Off'
      if (typeof value === 'string' && field.options.includes(value)) return value
      throw invalid(
        `field '${name}' is a checkbox with several values; pass one of ${JSON.stringify(field.options)} or false`
      )
    }
    if (typeof value === 'boolean') return value
    if (value === 'Off') return false
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
    const items = [...new Set(Array.isArray(value) ? value : [value])]
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

function restoreValue(field) {
  if (field.type === 'text') return field.value ?? ''
  if (field.type === 'checkbox') return field.options ? (field.value ?? 'Off') : field.value
  if (field.type === 'radio') return field.value
  if (field.type === 'combobox') {
    if (field.value === null) return field.editable ? '' : undefined
    return field.options.includes(field.value) ? [field.value] : field.value
  }
  if (field.type === 'listbox') {
    if (field.multiSelect) return field.value
    return field.value === null ? [] : [field.value]
  }
  return undefined
}

function restorable(field) {
  if (field.readOnly) return true
  if (field.type === 'radio') return field.value !== null
  if (field.type === 'combobox') return field.value !== null || field.editable
  return true
}

function needsTrial(before, names) {
  if (names.length < 2) return false
  const fields = new Map(before.map((field) => [field.name, field]))
  return names.some((name) => !restorable(fields.get(name)))
}

function restoreValues(before, names) {
  const fields = new Map(before.map((field) => [field.name, field]))
  const restore = { names: [], values: [] }
  for (const name of names) {
    const field = fields.get(name)
    if (!field || field.readOnly) continue
    const value = restoreValue(field)
    if (value === undefined || value === null) continue
    restore.names.push(name)
    restore.values.push(value)
  }
  return restore
}

module.exports = { groupFields, prepareFill, checkFill, needsTrial, restoreValues }
