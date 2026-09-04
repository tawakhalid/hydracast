/**
 * Parser checks for the per-platform viewer count.
 *
 * The payloads below follow each platform's documented response: Twitch's
 * Helix `/streams`, YouTube's `videos.list(part=liveStreamingDetails)`, and
 * Kick's `api/v2/channels/<slug>` - the last being undocumented, and shaped
 * here the way the chat connector observed it when resolving a chatroom id.
 *
 * What these pin is the reading, not the wire format: the interesting cases are
 * the ones where a platform answers successfully and still has no number to
 * give, because those must not be reported as a broken key.
 */
import {
  readKickCount,
  readTwitchCount,
  readYouTubeCount,
  viewerIdentity,
  apiError
} from '../src/main/viewers'
import { DEFAULT_VIDEO, supportsViewerCount, totalViewers } from '../src/shared/types'
import type { Platform, ViewerCount } from '../src/shared/types'

let failures = 0
const check = (label: string, pass: boolean, extra = '') => {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '   (' + extra + ')' : ''}`)
}

function platform(kind: Platform['kind'], over: Partial<Platform> = {}): Platform {
  return {
    id: `${kind}1`,
    kind,
    name: kind,
    url: '',
    streamKey: '',
    enabled: true,
    video: { ...DEFAULT_VIDEO },
    chat: { enabled: true },
    ...over
  }
}

// ---------------------------------------------------------------- Twitch ----
const twLive = readTwitchCount({
  data: [{ id: '41375541868', user_login: 'chan', type: 'live', viewer_count: 1337 }],
  pagination: {}
})
check('Twitch reads viewer_count', twLive.count === 1337, String(twLive.count))
check('a good Twitch sample needs no explanation', twLive.detail === undefined)

const twOffline = readTwitchCount({ data: [], pagination: {} })
check('an empty Twitch data array is zero, not unknown', twOffline.count === 0)
check('and says why', !!twOffline.detail, twOffline.detail)

const twJunk = readTwitchCount({ data: [{ user_login: 'chan' }] })
check('a Twitch entry with no count is unknown', twJunk.count === -1, String(twJunk.count))

// --------------------------------------------------------------- YouTube ----
const ytLive = readYouTubeCount({
  items: [
    {
      id: 'dQw4w9WgXcQ',
      liveStreamingDetails: {
        actualStartTime: '2026-09-04T10:00:00Z',
        // Documented as a string, which is the whole reason this is parsed.
        concurrentViewers: '4821'
      }
    }
  ]
})
check('YouTube parses the string count', ytLive.count === 4821, String(ytLive.count))

const ytHidden = readYouTubeCount({
  items: [{ liveStreamingDetails: { actualStartTime: '2026-09-04T10:00:00Z' } }]
})
check('a hidden YouTube count is unknown, not zero', ytHidden.count === -1, String(ytHidden.count))
check('and is explained as a choice, not a failure', !!ytHidden.detail, ytHidden.detail)

const ytEnded = readYouTubeCount({
  items: [
    {
      liveStreamingDetails: {
        actualStartTime: '2026-09-04T10:00:00Z',
        actualEndTime: '2026-09-04T12:00:00Z'
      }
    }
  ]
})
check('an ended YouTube broadcast is zero', ytEnded.count === 0, String(ytEnded.count))

const ytMissing = readYouTubeCount({ items: [] })
check('no YouTube item at all is unknown', ytMissing.count === -1)

// ------------------------------------------------------------------ Kick ----
const kickLive = readKickCount({
  id: 12345,
  slug: 'chan',
  livestream: { id: 999, is_live: true, viewer_count: 273 }
})
check('Kick reads viewer_count', kickLive.count === 273, String(kickLive.count))

const kickOffline = readKickCount({ id: 12345, slug: 'chan', livestream: null })
check('a null Kick livestream is zero, not unknown', kickOffline.count === 0)
check('and says why', !!kickOffline.detail, kickOffline.detail)

const kickJunk = readKickCount({ livestream: { is_live: true } })
check('a Kick livestream with no count is unknown', kickJunk.count === -1)

// ----------------------------------------------------------- error bodies ----
check(
  'YouTube nests its reason under error.message',
  apiError({ error: { code: 403, message: 'The request cannot be completed' } }, 403) ===
    'The request cannot be completed'
)
check(
  'Twitch puts its reason at the top level',
  apiError({ status: 401, message: 'Invalid OAuth token' }, 401) === 'Invalid OAuth token'
)
check(
  'a body with no reason falls back to the status',
  apiError({ nonsense: true }, 503) === 'HTTP 503'
)

// -------------------------------------------------------------- identity ----
const base = platform('twitch', { chat: { enabled: true, twitchChannel: 'chan' } })
check(
  'a rename does not restart the poller',
  viewerIdentity(base) === viewerIdentity({ ...base, name: 'Main Twitch' })
)
check(
  'a bitrate change does not restart the poller',
  viewerIdentity(base) ===
    viewerIdentity({ ...base, video: { ...base.video, videoBitrate: 9000 } })
)
check(
  'a channel change does restart it',
  viewerIdentity(base) !==
    viewerIdentity({ ...base, chat: { enabled: true, twitchChannel: 'other' } })
)
check(
  'so does adding app credentials',
  viewerIdentity(base) !== viewerIdentity({ ...base, viewers: { twitchClientId: 'abc' } })
)

// ----------------------------------------------------------------- total ----
const counts = (...list: [string, number][]): Record<string, ViewerCount> =>
  Object.fromEntries(
    list.map(([id, count]) => [id, { platformId: id, count, updatedAt: 1 } as ViewerCount])
  )

check('the total sums what is known', totalViewers(counts(['a', 100], ['b', 25])) === 125)
check(
  'unknown destinations are skipped rather than counted as zero',
  totalViewers(counts(['a', 100], ['b', -1])) === 100
)
check('a total with nothing known is unknown', totalViewers(counts(['a', -1])) === -1)
check('an empty snapshot is unknown', totalViewers({}) === -1)

// ------------------------------------------------------------ capability ----
check('Twitch, YouTube and Kick report counts', ['twitch', 'youtube', 'kick'].every((k) =>
  supportsViewerCount(k as Platform['kind'])
))
check(
  'the account-gated platforms do not',
  !['facebook', 'trovo', 'tiktok', 'custom'].some((k) =>
    supportsViewerCount(k as Platform['kind'])
  )
)

console.log(failures ? `\n${failures} check(s) failed` : '\nAll viewer checks passed')
process.exit(failures ? 1 : 0)
