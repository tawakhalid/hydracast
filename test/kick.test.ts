/**
 * Feeds the connector a real frame captured off Kick's socket on 2026-09-03 and
 * checks it produces the ChatMessage the renderer expects. The event name and
 * every field below are observed, not assumed - guessing them is what made the
 * feed silently empty in the first place.
 */
import { KickChat } from '../src/main/chat/kick'
import { DEFAULT_VIDEO } from '../src/shared/types'
import type { ActivityEvent, ChatMessage, Platform } from '../src/shared/types'

const platform: Platform = {
  id: 'kick1',
  kind: 'kick',
  name: 'Kick',
  url: '',
  streamKey: '',
  enabled: true,
  video: { ...DEFAULT_VIDEO },
  chat: { enabled: true, kickChannel: 'tawakhalid', kickChatroomId: '6815433' }
}

// Verbatim capture, including the escaped event name Pusher actually sends.
const CAPTURED = {
  event: 'App\\Events\\ChatMessageEvent',
  data: JSON.stringify({
    id: '2f71340a-c7a3-402d-bcf7-731537a83993',
    chatroom_id: 6815433,
    content: 'test',
    type: 'message',
    created_at: '2026-09-03T10:49:34+00:00',
    sender: {
      id: 6970190,
      username: 'tawakhalid',
      slug: 'tawakhalid',
      identity: {
        color: '#1475E1',
        badges: [{ type: 'broadcaster', text: 'Broadcaster', sort_order: 13 }]
      }
    }
  })
}

let failures = 0
const check = (label: string, pass: boolean, extra = '') => {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '   (' + extra + ')' : ''}`)
}

const chat = new KickChat(platform)
const seen: ChatMessage[] = []
chat.on('message', (m: ChatMessage) => seen.push(m))

// handle() is the socket entry point; drive it directly with the captured frame.
;(chat as unknown as { handle: (raw: string) => void }).handle(JSON.stringify(CAPTURED))

check('the captured frame produced a message', seen.length === 1, `got ${seen.length}`)

if (seen.length === 1) {
  const m = seen[0]
  check('author', m.author === 'tawakhalid', m.author)
  check('message text', m.message === 'test', m.message)
  check('platform kind', m.platformKind === 'kick', m.platformKind)
  check('platform id carried through', m.platformId === 'kick1', m.platformId)
  check('author colour', m.authorColor === '#1475E1', String(m.authorColor))
  check('badges mapped', JSON.stringify(m.badges) === '["broadcaster"]', JSON.stringify(m.badges))
  check('broadcaster flagged as owner', m.isOwner === true)
  check('not marked moderator', m.isModerator === false)
  check(
    'server timestamp used, not arrival time',
    m.timestamp === Date.parse('2026-09-03T10:49:34+00:00'),
    new Date(m.timestamp).toISOString()
  )
  check('id taken from the payload', m.id === '2f71340a-c7a3-402d-bcf7-731537a83993')
}

// The older spelling must keep working too.
const legacy = { ...CAPTURED, event: 'App\\Events\\ChatMessage' }
;(chat as unknown as { handle: (raw: string) => void }).handle(JSON.stringify(legacy))
check('legacy event name still accepted', seen.length === 2, `got ${seen.length}`)

// Emote markup should render as the emote name.
const emote = {
  event: 'App\\Events\\ChatMessageEvent',
  data: JSON.stringify({
    id: 'e1',
    content: 'nice [emote:1730752:emojiKEKW] run',
    created_at: '2026-09-03T10:50:00+00:00',
    sender: { username: 'someone', identity: { color: '#fff', badges: [] } }
  })
}
;(chat as unknown as { handle: (raw: string) => void }).handle(JSON.stringify(emote))
check(
  'emote markup stripped to its name',
  seen[2]?.message === 'nice emojiKEKW run',
  seen[2]?.message
)

// ---------------------------------------------------------------- activity
//
// Every payload below is verbatim from a 25-minute capture of a live subathon
// on kick.com/odablock (2026-09-03). The first version of this connector mapped
// these from memory and got both money events wrong, so they are pinned here
// rather than described.

const acts: ActivityEvent[] = []
chat.on('activity', (a: ActivityEvent) => acts.push(a))

const unknown: string[] = []
chat.on('unknown-event', (name: string) => unknown.push(name))

const feed = (event: string, data: unknown): void =>
  (chat as unknown as { handle: (raw: string) => void }).handle(
    JSON.stringify({ event, data: JSON.stringify(data) })
  )

feed('App\\Events\\SubscriptionEvent', {
  chatroom_id: 2393554,
  username: 'abdallahOSRS',
  months: 6
})
check('a sub produced one activity event', acts.length === 1, `got ${acts.length}`)
check('sub actor', acts[0]?.actor === 'abdallahOSRS', acts[0]?.actor)
check('sub kind', acts[0]?.kind === 'subscription', acts[0]?.kind)
check('resub months read', acts[0]?.detail === 'resubscribed for 6 months', acts[0]?.detail)

feed('App\\Events\\SubscriptionEvent', { chatroom_id: 2393554, username: 'PhilMadik', months: 1 })
check('a first month reads as a plain sub', acts[1]?.detail === 'subscribed', acts[1]?.detail)

feed('GiftedSubscriptionsEvent', {
  chatroom_id: 2393554,
  correlation_id: 'pi_3UBcQYE5WX7FB3n50rhlFUUu',
  gifted_usernames: [
    'omgshare',
    'polarah',
    'hhhlar',
    'Herlitz',
    'LaserRaccoon',
    'Helionz',
    'pachanator',
    'Canndryy',
    'Critgonemad',
    'Mf_Patty'
  ],
  gifter_username: 'ChrisE',
  gifted_total: 10,
  gifter_total: 3415,
  chunk_details: null
})
// The gifter is under `gifter_username`, which the old generic field hunt
// missed entirely - it rendered "Someone gifted subscriptions".
check('gifter named', acts[2]?.actor === 'ChrisE', acts[2]?.actor)
check('gift kind', acts[2]?.kind === 'gift', acts[2]?.kind)
check('gift count', acts[2]?.amount === 10, String(acts[2]?.amount))
check(
  'gift detail carries the lifetime total',
  acts[2]?.detail === 'gifted 10 subscriptions (3,415 all time)',
  acts[2]?.detail
)
check(
  'recipients listed',
  acts[2]?.message ===
    'omgshare, polarah, hhhlar, Herlitz, LaserRaccoon, Helionz, pachanator, Canndryy and 2 more',
  acts[2]?.message
)

// A 50-sub bomb was captured live; the row must stay one readable line.
feed('GiftedSubscriptionsEvent', {
  chatroom_id: 2393554,
  gifted_usernames: Array.from({ length: 50 }, (_, i) => `user${i}`),
  gifter_username: 'Krowee02',
  gifted_total: 50,
  gifter_total: 1460
})
check(
  'a large gift bomb summarises its tail',
  acts[3]?.message === 'user0, user1, user2, user3, user4, user5, user6, user7 and 42 more',
  acts[3]?.message
)
check('bomb count intact', acts[3]?.amount === 50, String(acts[3]?.amount))

feed('KicksGifted', {
  gift_transaction_id: 'e28a9427-353b-4fa8-9b88-918e40d6d7eb',
  message: 'TAKE  MINE!',
  sender: { id: 3026507, username: 'ChrisE', username_color: '#E9113C' },
  gift: { gift_id: 'pack_it_up', name: 'Pack It Up', amount: 1000, type: 'LEVEL_UP', tier: 'MID' },
  created_at: '2026-09-03T15:21:07.373823974Z'
})
check('Kicks recognised as a tip', acts[4]?.kind === 'donation', acts[4]?.kind)
check('Kicks sender', acts[4]?.actor === 'ChrisE', acts[4]?.actor)
check('Kicks gift named', acts[4]?.detail === 'sent Pack It Up', acts[4]?.detail)
check('Kicks amount formatted', acts[4]?.amountLabel === '1,000 Kicks', acts[4]?.amountLabel)
check('attached note kept', acts[4]?.message === 'TAKE  MINE!', acts[4]?.message)

// Noise must stay silent. PredictionUpdated alone fired 893 times in 25
// minutes; reported as unknown it would bury the Logs tab.
const before = acts.length
feed('PredictionUpdated', { prediction: { id: '01M1KXR7VCB43V1Z32HH8KKBG2' } })
feed('KicksLeaderboardUpdated', { gifts_lifetime: [] })
feed('GiftsLeaderboardUpdated', { leaderboard: [] })
feed('App\\Events\\ChatMessageSentEvent', { message: { action: 'subscribe' } })
feed('App\\Events\\MessageDeletedEvent', { id: 'x' })
feed('App\\Events\\UserBannedEvent', { id: 'x' })
// The channel-wide twin of SubscriptionEvent: counting it too would double
// every sub, so it must not reach the feed.
feed('App\\Events\\ChannelSubscriptionEvent', {
  user_ids: [62166523],
  username: 'abdallahOSRS',
  channel_id: 2401072
})
check('known noise produced no activity', acts.length === before, `${acts.length - before} leaked`)
check('known noise was not reported as unknown', unknown.length === 0, unknown.join(', '))

// Pusher's own protocol chatter is not activity either. The pong that answers
// our keepalive was reported as an unknown event on the first live run.
;(chat as unknown as { handle: (raw: string) => void }).handle(
  JSON.stringify({ event: 'pusher:pong', data: {} })
)
check('protocol frames stay out of the log', unknown.length === 0, unknown.join(', '))

// Anything genuinely new still has to announce itself.
feed('App\\Events\\SomethingBrandNew', {})
check(
  'an unrecognised event self-reports',
  unknown.length === 1 && unknown[0].endsWith('SomethingBrandNew'),
  unknown.join(', ')
)

chat.disconnect()
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
