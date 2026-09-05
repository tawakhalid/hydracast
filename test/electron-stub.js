// Stands in for the electron module so the connectors and the auth flow can be
// exercised outside the main process. Only the few members the pure paths touch
// are present; anything more would be a test reaching further than it should.
module.exports = {
  net: {},
  shell: { openExternal: async () => {} }
}
