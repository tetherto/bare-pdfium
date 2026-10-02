function coded(Type, code, message) {
  const err = new Type(message)
  err.code = code
  return err
}

exports.invalid = function invalid(message) {
  return coded(TypeError, 'INVALID_ARGUMENT', message)
}

exports.outOfRange = function outOfRange(message, code = 'INVALID_ARGUMENT') {
  return coded(RangeError, code, message)
}

exports.failure = function failure(code, message) {
  return coded(Error, code, message)
}

exports.unsupportedText = function unsupportedText(message) {
  return coded(TypeError, 'UNSUPPORTED_TEXT', message)
}
