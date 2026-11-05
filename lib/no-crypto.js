// The WebAssembly build has no bare-crypto to encrypt with, as bare-crypto has no
// wasi-wasm32 build. Mapping it here keeps it, and the native addons it brings,
// out of the modules a WebAssembly import resolves.
const { failure } = require('./errors')

throw failure('ENCRYPT', 'encrypt needs bare-crypto, which has no WebAssembly build')
