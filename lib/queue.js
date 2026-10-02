const { failure } = require('./errors')

let pending = Promise.resolve()

function serialize(job) {
  const result = pending.then(job)
  pending = result.catch(() => {})
  return result
}

function closedError() {
  return Promise.reject(failure('CLOSED', 'document is closed'))
}

function queue(args, call) {
  return serialize(() => call(...args()))
}

module.exports = { serialize, queue, closedError }
