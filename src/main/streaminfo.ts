import type { CategoryOption, Platform, StreamInfo, StreamInfoResult } from '@shared/types'
import { BROWSER_HEADERS, browserFetch } from './http'
import { TWITCH_CLIENT_ID } from './auth/device'

/**
 * Setting the stream title and category from Hydracast.
 *
 * This is the payoff of logging in that has nothing to do with relaying: the
 * whole point of a multi-platform broadcast is not repeating yourself, and
 * "what am I streaming" is otherwise typed once per dashboard. Both platforms
 * gate the write behind a scope the connected account already holds -
 * `channel:manage:broadcast` on Twitch, `channel:write` on Kick.
 *
 * Categories are not shared vocabulary: the same game has a different id on
 * each platform, so a name is searched per-platform and the ids never mix.
 */

const HELIX = 'https://api.twitch.tv/helix'
const KICK_CHANNELS = 'https://api.kick.com/public/v1/channels'
const KICK_CATEGORIES = 'https://api.kick.com/public/v1/categories'

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Twitch needs this scope to write; reading the channel needs none. */
export const TWITCH_MANAGE_SCOPE = 'channel:manage:broadcast'
export const KICK_WRITE_SCOPE = 'channel:write'

/** Reads `GET /helix/channels`. */
export function readTwitchInfo(body: unknown): StreamInfo | null {
  const first = rec(list(rec(body)['data'])[0])
  if (!Object.keys(first).length) return null
  return {
    title: str(first['title']),
    categoryId: str(first['game_id']),
    categoryName: str(first['game_name'])
  }
}

/** Reads `GET /helix/search/categories`. */
export function readTwitchCategories(body: unknown): CategoryOption[] {
  return list(rec(body)['data'])
    .map((entry) => {
      const c = rec(entry)
      return {
        id: str(c['id']),
        name: str(c['name']),
        // Twitch templates the size into the URL; fill it in so it can be shown.
        boxArtUrl: str(c['box_art_url']).replace('{width}', '72').replace('{height}', '96')
      }
    })
    .filter((c) => c.id && c.name)
}

/** Reads `GET /public/v1/categories`. */
export function readKickCategories(body: unknown): CategoryOption[] {
  return list(rec(body)['data'])
    .map((entry) => {
      const c = rec(entry)
      return {
        id: String(c['id'] ?? ''),
        name: str(c['name']),
        boxArtUrl: str(c['thumbnail']) || undefined
      }
    })
    .filter((c) => c.id && c.name)
}

const twitchHeaders = (token: string): Record<string, string> => ({
  ...BROWSER_HEADERS,
  'client-id': TWITCH_CLIENT_ID,
  authorization: `Bearer ${token}`
})

const kickHeaders = (token: string): Record<string, string> => ({
  ...BROWSER_HEADERS,
  authorization: `Bearer ${token}`
})

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  try {
    return JSON.parse(text || '{}')
  } catch {
    throw new Error(`Non-JSON reply (HTTP ${res.status})`)
  }
}

/**
 * What the destination currently shows.
 *
 * Fetched rather than remembered, because the streamer may well have changed it
 * from the platform's own dashboard since Hydracast last looked.
 *
 * Kick is a documented exception. Its channels payload describes the *current
 * livestream*, so `stream_title` and `category` come back empty whenever the
 * channel is offline - verified against a live token immediately after a PATCH
 * that Kick had accepted. There is nothing to read back there, so callers fall
 * back to the last value Hydracast sent rather than showing a blank field that
 * looks like a failure.
 */
export async function fetchStreamInfo(
  platform: Platform,
  token: string,
  userId: string
): Promise<StreamInfo | null> {
  if (platform.kind === 'twitch') {
    const res = await browserFetch(`${HELIX}/channels?broadcaster_id=${userId}`, {
      headers: twitchHeaders(token)
    })
    if (!res.ok) throw new Error(`Twitch replied HTTP ${res.status}`)
    return readTwitchInfo(await readJson(res))
  }

  if (platform.kind === 'kick') {
    const res = await browserFetch(KICK_CHANNELS, { headers: kickHeaders(token) })
    if (!res.ok) throw new Error(`Kick replied HTTP ${res.status}`)
    const first = rec(list(rec(await readJson(res))['data'])[0])
    if (!Object.keys(first).length) return null
    const category = rec(first['category'])
    // Kick reports "no category" as id 0, and `String(0)` is a truthy '0'.
    // Left as-is, every unset category reads as a category that exists.
    const categoryId = Number(category['id'] ?? 0)
    return {
      title: str(first['stream_title']),
      categoryId: categoryId > 0 ? String(categoryId) : '',
      categoryName: str(category['name'])
    }
  }

  return null
}

/** Searches the platform's own category list. Ids are never shared between them. */
export async function searchCategories(
  platform: Platform,
  token: string,
  query: string
): Promise<CategoryOption[]> {
  const q = query.trim()
  if (!q) return []

  if (platform.kind === 'twitch') {
    const res = await browserFetch(
      `${HELIX}/search/categories?first=12&query=${encodeURIComponent(q)}`,
      { headers: twitchHeaders(token) }
    )
    if (!res.ok) throw new Error(`Twitch replied HTTP ${res.status}`)
    return readTwitchCategories(await readJson(res))
  }

  if (platform.kind === 'kick') {
    const res = await browserFetch(`${KICK_CATEGORIES}?q=${encodeURIComponent(q)}`, {
      headers: kickHeaders(token)
    })
    if (!res.ok) throw new Error(`Kick replied HTTP ${res.status}`)
    return readKickCategories(await readJson(res)).slice(0, 12)
  }

  return []
}

/**
 * Pushes title and category to one destination.
 *
 * Never throws: a multi-platform update must report each destination's outcome
 * rather than stopping at the first refusal, so one platform rejecting a title
 * does not hide that the others took it.
 */
export async function pushStreamInfo(
  platform: Platform,
  token: string,
  userId: string,
  scopes: string[],
  info: StreamInfo
): Promise<StreamInfoResult> {
  const base = { platformId: platform.id }
  const title = info.title.trim()

  // An empty field means "leave this as it is", which is what the shared editor
  // has always told the user ("it will keep whatever it shows now") while the
  // request underneath sent `title: ''` and blanked it. It is also what lets
  // /title and /game be independent commands.
  if (!title && !info.categoryId) return { ...base, ok: true, skipped: true }

  try {
    if (platform.kind === 'twitch') {
      if (!scopes.includes(TWITCH_MANAGE_SCOPE)) {
        return { ...base, ok: false, detail: 'Reconnect to grant permission to set the title' }
      }
      // Twitch rejects an empty game_id rather than treating it as "leave it",
      // and the same goes for the title, so absent fields are simply omitted.
      const payload: Record<string, string> = {}
      if (title) payload['title'] = title
      if (info.categoryId) payload['game_id'] = info.categoryId

      const res = await browserFetch(`${HELIX}/channels?broadcaster_id=${userId}`, {
        method: 'PATCH',
        headers: { ...twitchHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      // Helix answers a successful PATCH with 204 and no body.
      if (res.status === 204 || res.ok) return { ...base, ok: true }
      const body = rec(await readJson(res))
      return { ...base, ok: false, detail: str(body['message']) || `HTTP ${res.status}` }
    }

    if (platform.kind === 'kick') {
      if (!scopes.includes(KICK_WRITE_SCOPE)) {
        return { ...base, ok: false, detail: 'Reconnect to grant permission to set the title' }
      }
      const payload: Record<string, unknown> = {}
      if (title) payload['stream_title'] = title
      const categoryId = Number(info.categoryId)
      if (Number.isFinite(categoryId) && categoryId > 0) payload['category_id'] = categoryId

      const res = await browserFetch(KICK_CHANNELS, {
        method: 'PATCH',
        headers: { ...kickHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      if (res.ok || res.status === 204) return { ...base, ok: true }
      const body = rec(await readJson(res))
      return { ...base, ok: false, detail: str(body['message']) || `HTTP ${res.status}` }
    }

    return { ...base, ok: false, detail: `${platform.name} cannot be updated from Hydracast` }
  } catch (err) {
    return { ...base, ok: false, detail: (err as Error).message }
  }
}
