/**
 * Checks for Kick login, Twitch EventSub, and the stream info writer.
 *
 * What these pin is classification and shape, not the wire format. The Kick
 * payloads below are copied from real responses captured against a live
 * account, because the one that matters - `GET /public/v1/channels` - is the
 * single source for identity, the ingest URL, the stream key and the viewer
 * count at once, and there is no documented stream-key endpoint to fall back on
 * if this reader drifts.
 */
import {
  readCallback,
  readChannel,
  readTokenSet,
  buildAuthUrl,
  createPkce
} from '../src/main/auth/kick'
import { readFrame, readFollow } from '../src/main/eventsub'
import { readKickCategories, readTwitchCategories, readTwitchInfo } from '../src/main/streaminfo'
import { readKickSendResult } from '../src/main/chat/send'
import { readKickAuthedCount } from '../src/main/viewers'
import { readBrokerFrame, toActivity } from '../src/main/kickfollows'

let failures = 0
const check = (label: string, pass: boolean, extra = '') => {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '   (' + extra + ')' : ''}`)
}

// ------------------------------------------------------------- PKCE start ---
const pkce = createPkce()
check(
  'verifier meets the 43-character minimum',
  pkce.verifier.length >= 43,
  String(pkce.verifier.length)
)
check('verifier is base64url only', /^[A-Za-z0-9_-]+$/.test(pkce.verifier))
check('challenge differs from the verifier', pkce.challenge !== pkce.verifier)
check('two pairs never repeat', createPkce().verifier !== pkce.verifier)

const url = new URL(buildAuthUrl(pkce))
check('authorize uses S256', url.searchParams.get('code_challenge_method') === 'S256')
check('authorize sends the challenge, never the verifier', !url.search.includes(pkce.verifier))
check(
  'redirect is the loopback listener',
  url.searchParams.get('redirect_uri') === 'http://localhost:8788/kick/callback',
  url.searchParams.get('redirect_uri') ?? ''
)
check(
  'user:read is not requested',
  !(url.searchParams.get('scope') ?? '').includes('user:read'),
  url.searchParams.get('scope') ?? ''
)

// ---------------------------------------------------------- the callback ----
const good = readCallback(new URLSearchParams({ code: 'abc', state: 'st-1' }), 'st-1')
check('a matching state yields the code', good.status === 'code' && good.code === 'abc')

// The security-critical one: a code that arrives under the wrong state is an
// attacker's flow, not the user's, and must never be redeemed.
const wrongState = readCallback(new URLSearchParams({ code: 'abc', state: 'other' }), 'st-1')
check('a mismatched state is refused', wrongState.status === 'error', wrongState.status)

const denied = readCallback(
  new URLSearchParams({ error: 'access_denied', error_description: 'nope' }),
  'st-1'
)
check('a refusal is denied, not an error', denied.status === 'denied', denied.status)

const noCode = readCallback(new URLSearchParams({ state: 'st-1' }), 'st-1')
check('a missing code is an error', noCode.status === 'error', noCode.status)

// ------------------------------------------------------------- token set ----
const tokens = readTokenSet(
  {
    access_token: 'at-k',
    refresh_token: 'rt-k',
    expires_in: 7200,
    scope: 'channel:read channel:write streamkey:read chat:write',
    token_type: 'Bearer'
  },
  5_000_000
)
check('kick access token is read', tokens.accessToken === 'at-k')
check('kick refresh token is read', tokens.refreshToken === 'rt-k')
check(
  'two-hour expiry becomes an absolute deadline',
  tokens.expiresAt === 5_000_000 + 7200 * 1000,
  String(tokens.expiresAt)
)
check('space-separated scopes are split', tokens.scopes.length === 4, tokens.scopes.join('|'))

let threw = false
try {
  readTokenSet({ error: 'kick_rejected', detail: 'bad code' })
} catch (err) {
  threw = true
  check('a rejected exchange surfaces the reason', (err as Error).message === 'bad code')
}
check('a token reply with no token throws', threw)

// ------------------------------------------------------------- channel ------
const channel = readChannel({
  data: [
    {
      broadcaster_user_id: 6970190,
      slug: 'tawakhalid',
      banner_picture: 'https://files.kick.com/banner.jpg',
      stream: {
        url: 'rtmps://fa723fc1b171.global-contribute.live-video.net',
        key: 'sk_test_key',
        is_live: true,
        viewer_count: 42
      },
      stream_title: 'Testing Hydracast',
      category: { id: 15, name: 'Just Chatting' }
    }
  ]
})
check('channel yields the broadcaster id', channel?.broadcasterUserId === 6970190)
check('channel yields the slug', channel?.slug === 'tawakhalid')
check('channel yields the ingest URL', channel?.rtmpUrl.startsWith('rtmps://'))
check('channel yields the stream key', channel?.streamKey === 'sk_test_key')
check('channel yields the live flag', channel?.isLive === true)
check('channel yields the viewer count', channel?.viewerCount === 42)
check('channel yields the category name', channel?.category === 'Just Chatting')
check('an empty channel list is null, not a crash', readChannel({ data: [] }) === null)

// -------------------------------------------------- authenticated viewers ---
const offline = readKickAuthedCount({ data: [{ stream: { is_live: false, viewer_count: 0 } }] })
check('an offline channel reads zero, not an error', offline.count === 0, offline.detail ?? '')
const live = readKickAuthedCount({ data: [{ stream: { is_live: true, viewer_count: 1312 } }] })
check('a live channel reads its count', live.count === 1312)
const noChannel = readKickAuthedCount({ data: [] })
check('no channel is unknown (-1), not zero', noChannel.count === -1)

// ----------------------------------------------------------- kick sending ---
check('is_sent true is a success', readKickSendResult({ data: { is_sent: true } }).ok)
const dropped = readKickSendResult({ data: { is_sent: false }, message: 'banned word' })
check('is_sent false is a failure', !dropped.ok)
check('the failure carries the reason', dropped.detail === 'banned word', dropped.detail ?? '')

// ------------------------------------------------------------- eventsub -----
const welcome = readFrame({
  metadata: { message_type: 'session_welcome' },
  payload: { session: { id: 'sess-1', keepalive_timeout_seconds: 10 } }
})
check('welcome yields the session id', welcome.type === 'welcome' && welcome.sessionId === 'sess-1')

const keepalive = readFrame({ metadata: { message_type: 'session_keepalive' }, payload: {} })
check('keepalive is recognised', keepalive.type === 'keepalive')

// A handover, not an outage: treating it as a drop would reconnect to the old
// socket and miss whatever arrived in between.
const reconnect = readFrame({
  metadata: { message_type: 'session_reconnect' },
  payload: { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?id=2' } }
})
check('reconnect carries the replacement URL', reconnect.type === 'reconnect' && !!reconnect.url)

const revoked = readFrame({
  metadata: { message_type: 'revocation' },
  payload: { subscription: { status: 'authorization_revoked' } }
})
check('revocation is recognised', revoked.type === 'revocation')

const notification = readFrame({
  metadata: { message_type: 'notification', subscription_type: 'channel.follow' },
  payload: { event: { user_id: '99', user_name: 'Ada', followed_at: '2026-09-05T10:00:00Z' } }
})
check('a notification carries its subscription type', notification.type === 'notification')

if (notification.type === 'notification') {
  const follow = readFollow(notification.event, { id: 'p-twitch' })
  check('a follow becomes an activity event', follow?.kind === 'follow')
  check('the follower is the actor', follow?.actor === 'Ada')
  check(
    "Twitch's own timestamp is used, not arrival time",
    follow?.timestamp === Date.parse('2026-09-05T10:00:00Z'),
    String(follow?.timestamp)
  )
  // Ids must be stable: a reconnect can redeliver, and an unstable id would
  // show the same follower twice in the feed.
  const again = readFollow(notification.event, { id: 'p-twitch' })
  check('the same follow yields the same id', follow?.id === again?.id)
}

check('a follow with no user is dropped', readFollow({}, { id: 'p' }) === null)
check('an unknown frame is classified as other', readFrame({}).type === 'other')

// ---------------------------------------------------------- stream info -----
const twitchInfo = readTwitchInfo({
  data: [{ title: 'Late night build', game_id: '509658', game_name: 'Just Chatting' }]
})
check('twitch info reads the title', twitchInfo?.title === 'Late night build')
check('twitch info reads the category id', twitchInfo?.categoryId === '509658')
check('twitch info on an empty list is null', readTwitchInfo({ data: [] }) === null)

const twitchCats = readTwitchCategories({
  data: [{ id: '1', name: 'Chess', box_art_url: 'https://x/{width}x{height}.jpg' }]
})
check('twitch categories are read', twitchCats.length === 1 && twitchCats[0].name === 'Chess')
check(
  'box art template is filled in',
  !twitchCats[0].boxArtUrl?.includes('{width}'),
  twitchCats[0].boxArtUrl ?? ''
)

// Kick numbers its categories, so the id arrives as a number and must survive
// as a string - the two platforms never share an id.
const kickCats = readKickCategories({ data: [{ id: 15, name: 'Just Chatting' }] })
check('kick categories are read', kickCats.length === 1)
check('a numeric kick id becomes a string', kickCats[0].id === '15', kickCats[0].id)
check('entries with no name are dropped', readKickCategories({ data: [{ id: 3 }] }).length === 0)

// --------------------------------------------------------- kick follows -----
const backlog = readBrokerFrame({
  type: 'backlog',
  events: [
    { id: 'm1', at: 1000, followerName: 'Ada', followerId: '7' },
    { id: 'm2', at: 2000, followerName: 'Grace', followerId: '8' }
  ]
})
check('a backlog yields every follow', backlog.length === 2, String(backlog.length))
check('backlog order is preserved', backlog[0].followerName === 'Ada')

const pushed = readBrokerFrame({
  type: 'follow',
  event: { id: 'm3', at: 3000, followerName: 'Hopper', followerId: '9' }
})
check('a live push yields one follow', pushed.length === 1)
check('the follower name is read', pushed[0].followerName === 'Hopper')

// A frame with no name is unusable; passing it on would put a blank row in the
// activity feed rather than showing nothing.
check('a nameless follow is dropped', readBrokerFrame({ type: 'follow', event: {} }).length === 0)
check('an unknown frame yields nothing', readBrokerFrame({ type: 'hello' }).length === 0)
check('a malformed frame yields nothing', readBrokerFrame(null).length === 0)

const kickFollow = toActivity(pushed[0], 'p-kick')
check('a follow becomes a kick activity event', kickFollow.kind === 'follow')
check('it is attributed to the right platform', kickFollow.platformKind === 'kick')
check('the actor is the follower', kickFollow.actor === 'Hopper')
// Kick retries deliveries, so the id must be stable across a redelivery or the
// same follower appears twice in the feed.
check(
  'a redelivered follow keeps the same id',
  toActivity(pushed[0], 'p-kick').id === kickFollow.id,
  kickFollow.id
)

console.log(failures ? `\n${failures} check(s) failed` : '\nAll kick/eventsub checks passed')
process.exit(failures ? 1 : 0)
