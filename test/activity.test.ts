/**
 * Parser checks for the activity feed.
 *
 * Twitch USERNOTICE lines below follow the documented IRCv3 shape, including
 * the `\s` escaping Twitch applies to `system-msg`. The YouTube items follow
 * the documented liveChatMessage resource. Neither has been captured off a live
 * channel the way the Kick chat frame was, so these pin the parsing, not the
 * wire format.
 */
import { KickChat } from '../src/main/chat/kick'
import { TwitchChat } from '../src/main/chat/twitch'
import { YouTubeChat } from '../src/main/chat/youtube'
import { DEFAULT_VIDEO } from '../src/shared/types'
import type { ActivityEvent, Platform } from '../src/shared/types'

let failures = 0
const check = (label: string, pass: boolean, extra = '') => {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? '   (' + extra + ')' : ''}`)
}

function platform(kind: Platform['kind'], chat: Platform['chat']): Platform {
  return {
    id: `${kind}1`,
    kind,
    name: kind,
    url: '',
    streamKey: '',
    enabled: true,
    video: { ...DEFAULT_VIDEO },
    chat
  }
}

type Handler = { handle: (raw: string) => void }

// ---------------------------------------------------------------- Twitch ----
const tw = new TwitchChat(platform('twitch', { enabled: true, twitchChannel: 'chan' }))
const twEvents: ActivityEvent[] = []
tw.on('activity', (e: ActivityEvent) => twEvents.push(e))

const feed = (line: string): void => (tw as unknown as Handler).handle(line + '\r\n')

feed(
  '@badge-info=subscriber/8;badges=subscriber/6;display-name=Viewer;id=abc-123;login=viewer;' +
    'msg-id=resub;msg-param-cumulative-months=8;' +
    "system-msg=Viewer\\ssubscribed\\sat\\sTier\\s1.\\sThey've\\ssubscribed\\sfor\\s8\\smonths!;" +
    'tmi-sent-ts=1507246572675 :tmi.twitch.tv USERNOTICE #chan :Great stream!'
)
const resub = twEvents[0]
check('resub produces a subscription event', resub?.kind === 'subscription', resub?.kind)
check('resub actor', resub?.actor === 'Viewer', resub?.actor)
check(
  'resub uses the ready-made system message, unescaped',
  resub?.detail === "Viewer subscribed at Tier 1. They've subscribed for 8 months!",
  resub?.detail
)
check('resub month count', resub?.amount === 8 && resub?.amountLabel === '8 months')
check('resub carries the viewer message', resub?.message === 'Great stream!', resub?.message)
check('resub uses the server timestamp', resub?.timestamp === 1507246572675)

feed(
  '@display-name=Raider;id=raid-1;login=raider;msg-id=raid;msg-param-viewerCount=42;' +
    'system-msg=42\\sraiders\\sfrom\\sRaider\\shave\\sjoined!;tmi-sent-ts=1507246572680' +
    ' :tmi.twitch.tv USERNOTICE #chan'
)
const raid = twEvents[1]
check('raid with no trailing message still parses', raid?.kind === 'raid', raid?.kind)
check('raid viewer count', raid?.amount === 42 && raid?.amountLabel === '42 viewers')
check('raid has no attached message', raid?.message === undefined)

feed(
  '@display-name=Gifter;id=mystery-1;msg-id=submysterygift;msg-param-mass-gift-count=5;' +
    'system-msg=Gifter\\sis\\sgifting\\s5\\sTier\\s1\\sSubs!;tmi-sent-ts=1507246572690' +
    ' :tmi.twitch.tv USERNOTICE #chan'
)
const mystery = twEvents[2]
check('mystery gift is a gift', mystery?.kind === 'gift', mystery?.kind)
check('mystery gift counts subs, not months', mystery?.amountLabel === '5 subs', mystery?.amountLabel)

feed(
  '@badges=;bits=500;display-name=Cheerer;id=cheer-1;tmi-sent-ts=1507246572700' +
    ' :cheerer!cheerer@cheerer.tmi.twitch.tv PRIVMSG #chan :Cheer500 nice one'
)
const cheer = twEvents[3]
check('bits on a normal message produce a cheer', cheer?.kind === 'cheer', cheer?.kind)
check('cheer amount', cheer?.amount === 500 && cheer?.amountLabel === '500 bits')

feed('@display-name=Nobody;msg-id=ritual;system-msg=hi;id=r1 :tmi.twitch.tv USERNOTICE #chan')
check('an unmapped USERNOTICE is ignored, not mis-filed', twEvents.length === 4, `${twEvents.length}`)

// A plain message must not produce activity.
feed('@display-name=Talker;id=m1 :talker!talker@talker.tmi.twitch.tv PRIVMSG #chan :just talking')
check('ordinary chat produces no activity', twEvents.length === 4, `${twEvents.length}`)

// ---------------------------------------------------------------- YouTube ---
const yt = new YouTubeChat(platform('youtube', { enabled: true, youtubeApiKey: 'k' }))
const ytEvents: ActivityEvent[] = []
yt.on('activity', (e: ActivityEvent) => ytEvents.push(e))
const ytFeed = (item: unknown): void =>
  (yt as unknown as { emitActivity: (i: unknown) => void }).emitActivity(item)

ytFeed({
  id: 'sc1',
  snippet: {
    type: 'superChatEvent',
    publishedAt: '2026-09-03T10:00:00Z',
    superChatDetails: { amountDisplayString: '$5.00', userComment: 'love the stream' }
  },
  authorDetails: { displayName: 'Fan' }
})
const sc = ytEvents[0]
check('super chat is a donation', sc?.kind === 'donation', sc?.kind)
check('super chat amount is the display string', sc?.amountLabel === '$5.00', sc?.amountLabel)
check('super chat comment is kept', sc?.message === 'love the stream')
check('super chat actor', sc?.actor === 'Fan')

ytFeed({
  id: 'ns1',
  snippet: { type: 'newSponsorEvent', newSponsorDetails: { memberLevelName: 'Gold' } },
  authorDetails: { displayName: 'Newbie' }
})
check('new member is a subscription', ytEvents[1]?.kind === 'subscription')
check('new member names the tier', ytEvents[1]?.detail === 'became a member at Gold', ytEvents[1]?.detail)

ytFeed({
  id: 'mm1',
  snippet: {
    type: 'memberMilestoneChatEvent',
    memberMilestoneChatDetails: { memberMonth: 12, userComment: 'a year!' }
  },
  authorDetails: { displayName: 'Loyal' }
})
check('member milestone months', ytEvents[2]?.amountLabel === '12 months', ytEvents[2]?.amountLabel)

ytFeed({ id: 't1', snippet: { type: 'textMessageEvent' }, authorDetails: { displayName: 'X' } })
check('plain chat produces no activity', ytEvents.length === 3, `${ytEvents.length}`)

// ---------------------------------------------------------------- Kick ------
// The mapping is a guess, so what matters most is that nothing is dropped in
// silence: an unmapped event must announce itself.
const kick = new KickChat(
  platform('kick', { enabled: true, kickChannel: 'chan', kickChatroomId: '1' })
)
const kickEvents: ActivityEvent[] = []
const unknown: string[] = []
kick.on('activity', (e: ActivityEvent) => kickEvents.push(e))
kick.on('unknown-event', (name: string) => unknown.push(name))
const kickFeed = (event: string, data: unknown): void =>
  (kick as unknown as Handler).handle(JSON.stringify({ event, data: JSON.stringify(data) }))

kickFeed('App\\Events\\FollowersUpdated', { followersCount: 101 })
check('a mapped Kick event becomes activity', kickEvents[0]?.kind === 'follow', kickEvents[0]?.kind)

kickFeed('App\\Events\\SomethingWeHaveNeverSeen', { a: 1 })
check('an unmapped Kick event is reported, never silently dropped', unknown.length === 1, unknown[0])
check('an unmapped Kick event produces no activity', kickEvents.length === 1)

kick.disconnect()
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
