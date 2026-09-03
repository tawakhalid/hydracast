// Stands in for the electron module so the Kick connector can be exercised
// outside the main process. Only `net.fetch` is touched, and not on this path.
module.exports = { net: {} }
