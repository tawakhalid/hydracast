/**
 * Checks for the device-code login and token lifecycle.
 *
 * The shapes below follow Twitch's documented Device Code Grant Flow. What
 * these pin is the classification, not the wire format: every interesting case
 * is a failure that must not be mistaken for a different one. Twitch signals
 * "the user has not approved this yet" with an HTTP 400, so a naive reading
 * turns a perfectly normal poll into a fatal error and the login never lands.
 */
import { deadline, readPoll } from '../src/main/auth/device'
import { needsRefresh, readIdentity, readStreamKey } from '../src/main/auth/session'
import { readSendResult } from '../src/main/chat/send'
import { parseCompose } from '../src/shared/types'

let failures = 0
const check = (label: string, pass: boolean, extra = '') => {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '   (' + extra + ')' : ''}`)
}

// ------------------------------------------------------------ poll states ---
const granted = readPoll(
  {
    access_token: 'at-1',
    refresh_token: 'rt-1',
    expires_in: 14400,
    scope: ['channel:read:stream_key', 'user:write:chat'],
    token_type: 'bearer'
  },
  true,
  1_000_000
)
check('an approved poll is granted', granted.status === 'granted', granted.status)
if (granted.status === 'granted') {
  check('carries the access token', granted.tokens.accessToken === 'at-1')
  check('carries the refresh token', granted.tokens.refreshToken === 'rt-1')
  check(
    'expiry is absolute, not a duration',
    granted.tokens.expiresAt === 1_000_000 + 14400 * 1000,
    String(granted.tokens.expiresAt)
  )
  check('keeps the granted scopes', granted.tokens.scopes.length === 2)
}

check(
  'authorization_pending is not an error',
  readPoll({ message: 'authorization_pending', status: 400 }, false).status === 'pending'
)
check(
  'slow_down asks us to back off',
  readPoll({ message: 'slow_down' }, false).status === 'slow-down'
)
check(
  'a denial is terminal',
  readPoll({ message: 'access_denied' }, false).status === 'denied'
)
check(
  'an expired device code is terminal',
  readPoll({ message: 'invalid device code' }, false).status === 'expired'
)
check(
  'an unknown failure is reported, not swallowed',
  readPoll({ message: 'something else entirely' }, false).status === 'error'
)
check(
  'a 200 with no token is not treated as success',
  readPoll({}, true).status === 'error'
)

// Twitch puts the reason under `error` on some replies and `message` on others.
check(
  'the reason is read from either field',
  readPoll({ error: 'authorization_pending' }, false).status === 'pending'
)

// --------------------------------------------------------------- deadline ---
check('deadline uses the stated lifetime', deadline(1800, 60, 5000) === 5000 + 1800 * 1000)
check('deadline falls back when absent', deadline(undefined, 60, 5000) === 5000 + 60 * 1000)
check('deadline falls back on nonsense', deadline('soon', 60, 5000) === 5000 + 60 * 1000)

// ---------------------------------------------------------------- refresh ---
const now = 1_000_000
check('a fresh token is left alone', !needsRefresh(now + 3600_000, now))
check('a token inside the margin is refreshed early', needsRefresh(now + 60_000, now))
check('an expired token is refreshed', needsRefresh(now - 1, now))
check(
  'a token exactly at the margin is refreshed',
  needsRefresh(now + 5 * 60 * 1000, now)
)

// --------------------------------------------------------------- identity ---
const identity = readIdentity({
  data: [
    {
      id: '141981764',
      login: 'twitchdev',
      display_name: 'TwitchDev',
      profile_image_url: 'https://example.invalid/a.png'
    }
  ]
})
check('identity reads the user id', identity?.userId === '141981764')
check('identity reads the login', identity?.login === 'twitchdev')
check('identity reads the display name', identity?.displayName === 'TwitchDev')
check('an empty data array yields no identity', readIdentity({ data: [] }) === null)

const noName = readIdentity({ data: [{ id: '1', login: 'someone' }] })
check('display name falls back to the login', noName?.displayName === 'someone')

// ------------------------------------------------------------- stream key ---
check(
  'stream key is read from the first row',
  readStreamKey({ data: [{ stream_key: 'live_44322889_a34ub' }] }) === 'live_44322889_a34ub'
)
check('a missing stream key reads empty', readStreamKey({ data: [] }) === '')

// ------------------------------------------------------------- send reply ---
check('is_sent true is a success', readSendResult({ data: [{ is_sent: true }] }).ok)

// A dropped message still returns HTTP 200, which is the trap this guards.
const dropped = readSendResult({
  data: [
    {
      message_id: 'abc',
      is_sent: false,
      drop_reason: { code: 'channel_settings', message: 'follower only mode' }
    }
  ]
})
check('a dropped message is not a success', !dropped.ok)
check('the drop reason is surfaced', dropped.detail === 'follower only mode', dropped.detail)

const droppedNoMsg = readSendResult({
  data: [{ is_sent: false, drop_reason: { code: 'blocked_term' } }]
})
check('the drop code is used when there is no message', droppedNoMsg.detail === 'blocked_term')

// ----------------------------------------------------------------- routing ---
const all = parseCompose('hello everyone')
check('bare text goes everywhere', all.route === null && all.text === 'hello everyone')

const tw = parseCompose('/twitch hello there')
check('a prefix picks one platform', tw.route === 'twitch', String(tw.route))
check('the prefix is stripped', tw.text === 'hello there', tw.text)

check('prefixes are case insensitive', parseCompose('/TWITCH hi').route === 'twitch')
check('the /yt alias works', parseCompose('/yt hi').route === 'youtube')
check('kick routes too', parseCompose('/kick hi').route === 'kick')

const bare = parseCompose('/twitch')
check('a prefix with no message sends nothing', bare.route === 'twitch' && bare.text === '')

// Twitch commands are not processed by the send endpoint, so they must not be
// silently forwarded as if they were.
const cmd = parseCompose('/me waves')
check('an unknown slash is not a route', cmd.route === null, String(cmd.route))
check('an unknown slash is flagged as literal', cmd.literalSlash)
check('an unknown slash keeps its full text', cmd.text === '/me waves', cmd.text)
check('bare text is never flagged literal', !all.literalSlash)

check('surrounding whitespace is trimmed', parseCompose('   hi   ').text === 'hi')
check(
  'whitespace before the message is trimmed',
  parseCompose('/twitch    hi').text === 'hi'
)

console.log(failures ? `\n${failures} check(s) failed` : '\nAll auth checks passed')
process.exit(failures ? 1 : 0)
