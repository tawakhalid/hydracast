import { net } from 'electron'

/**
 * Issues a request through Chromium's network stack rather than Node's.
 *
 * Kick fronts its API with Cloudflare, which rejects Node's HTTP client outright
 * (`403 Request blocked by security policy`) because its TLS and header
 * signature is not a browser's. Electron already embeds a real browser, so
 * asking it to make the request is both simpler and more honest than dressing
 * Node up as one. Falls back to global fetch outside the Electron main process,
 * which is what the tests run under.
 */
export function browserFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return typeof net?.fetch === 'function' ? net.fetch(url, init) : fetch(url, init)
}

/** Headers that make a request look like the browser it is actually going out as. */
export const BROWSER_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9'
}
