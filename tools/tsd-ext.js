// Other-market asks module: not published (it reads a third-party listing feed and is switched off in production, EXT_ENABLED=0).
// This stub keeps tsd-api.js loadable; init() returns a source that never has asks.
module.exports = { init: () => ({ start() {}, stop() {}, state: () => 'off', items: () => [], one: () => null }) };
