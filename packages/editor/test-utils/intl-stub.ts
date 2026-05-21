// Minimal stub for @notesnook/intl used in tests.
// The real package requires a build step (locale generation) that is not
// available in this environment, so we return a Proxy that yields a
// no-op function for any key access.
const noop = () => "";
const handler: ProxyHandler<object> = {
  get: () => new Proxy(noop, handler)
};
export const strings = new Proxy({}, handler);
export const setI18nGlobal = () => {};
