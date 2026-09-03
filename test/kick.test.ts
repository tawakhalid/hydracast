/**
 * Feeds the connector a real frame captured off Kick's socket on 2026-09-03 and
 * checks it produces the ChatMessage the renderer expects. The event name and
 * every field below are observed, not assumed - guessing them is what made the
 * feed silently empty in the first place.
 */
import { KickChat } from '../src/main/chat/kick'
import { DEFAULT_VIDEO } from '../src/shared/types'
import type { ChatMessage, Platform } from '../src/shared/types'

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

chat.disconnect()
console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
