import { memo, useMemo, useRef, useState } from 'react'
import type { ComposeCommand, PlatformKind, SendOutcome } from '@shared/types'
import { parseCompose } from '@shared/types'
import { AlertIcon, PlatformIcon, PLATFORM_COLORS } from '../icons'

/** Twitch's own cap; enforced here so the error arrives before the round trip. */
const MAX_LEN = 500

/** One destination that can be sent to, flattened so the props stay stable. */
export interface SendTarget {
  id: string
  kind: PlatformKind
  name: string
  /** Display name of the connected account, for the tooltip. */
  as: string
}

interface Props {
  targets: SendTarget[]
  onSend: (platformIds: string[], text: string) => Promise<SendOutcome[]>
  /** Wipes the visible feed; the same action as the toolbar's bin button. */
  onClear: () => void
}

/**
 * Composer for sending chat as the connected account.
 *
 * A bare message goes to every connected platform at once, which is the whole
 * point of a relay; `/twitch hello` narrows it to one. The platform icons to the
 * left of the box show where the message will land before it is sent.
 *
 * It also answers to three commands of its own - `/clear`, `/title` and `/game`
 * - because this box is the one control always on screen while live, and going
 * to a settings window to rename a stream mid-broadcast is a worse trade than
 * remembering three words.
 *
 * Memoised on purpose: the snapshot tick re-renders the pane every second, and
 * a text input that re-renders under the user's cursor at 1Hz feels broken.
 */
function ChatSend({ targets, onSend, onClear }: Props) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Outcome of the last command, shown where the send errors go. */
  const [note, setNote] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const composed = useMemo(() => parseCompose(text), [text])

  const routed = useMemo(
    () => (composed.route ? targets.filter((t) => t.kind === composed.route) : targets),
    [targets, composed.route]
  )

  const command = composed.command
  const tooLong = composed.text.length > MAX_LEN
  const canSend = command
    ? // `/clear` needs no argument; the other two are inert until given one.
      !sending && (command.name === 'clear' || command.value.length > 0)
    : !sending && composed.text.length > 0 && routed.length > 0 && !tooLong

  /**
   * Carries out one of our own commands.
   *
   * Kept apart from sending on purpose: a command that silently went out as a
   * chat message would be the worst possible outcome, so the two paths never
   * share a code path where one could fall through to the other.
   */
  const runCommand = async (cmd: NonNullable<typeof composed.command>): Promise<void> => {
    if (cmd.name === 'clear') {
      onClear()
      setText('')
      setNote('Chat cleared')
      return
    }

    setSending(true)
    setError(null)
    setNote(null)
    try {
      const results = await window.hydracast.applyStreamInfo(
        cmd.name === 'title' ? { title: cmd.value } : { game: cmd.value }
      )
      if (!results.length) {
        setError('No connected destination can be updated')
        return
      }
      const failed = results.filter((r) => !r.ok)
      const done = results.length - failed.length
      if (!failed.length) {
        setText('')
        setNote(cmd.name === 'title' ? 'Title updated everywhere' : `Category set to ${cmd.value}`)
      } else if (done) {
        // Partly applied, so the text stays put - retyping it to fix one
        // destination is worse than leaving it there to edit.
        setError(`${failed[0].detail ?? 'One destination refused'} (${done} updated)`)
      } else {
        setError(failed[0].detail ?? 'No destination accepted the change')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const submit = async (): Promise<void> => {
    if (!canSend) return
    if (command) {
      await runCommand(command)
      return
    }
    setSending(true)
    setError(null)
    try {
      const outcomes = await onSend(
        routed.map((t) => t.id),
        composed.text
      )
      const failed = outcomes.filter((o) => !o.ok)
      if (failed.length && failed.length === outcomes.length) {
        // Nothing got through, so the text is kept for editing - throwing away
        // a message the user just typed is worse than showing the error.
        setError(failed[0].detail ?? 'The message was not sent')
      } else {
        setText('')
        if (failed.length) setError(failed[0].detail ?? 'Partly delivered')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  if (!targets.length) return null

  const hint = error
    ? { text: error, bad: true }
    : command
      ? { text: commandHint(command), bad: false }
      : note
        ? { text: note, bad: false }
        : composed.route && routed.length === 0
          ? { text: `No connected ${composed.route} account`, bad: true }
          : composed.literalSlash
            ? { text: 'Chat commands are not supported - this sends as plain text', bad: false }
            : null

  return (
    <div className="chat-send">
      <div className="chat-send-row">
        <span className="send-targets" title={routed.map((t) => `${t.name} as ${t.as}`).join('\n')}>
          {routed.length ? (
            routed.map((t) => (
              <span
                key={t.id}
                className="send-dot"
                style={{ ['--pc' as string]: PLATFORM_COLORS[t.kind] }}
              >
                <PlatformIcon kind={t.kind} size={11} />
              </span>
            ))
          ) : (
            <span className="send-dot off" />
          )}
        </span>

        <input
          ref={inputRef}
          className="input chat-send-input"
          placeholder={
            targets.length > 1 ? 'Send to all, or /twitch, /title, /game' : 'Send a message'
          }
          value={text}
          maxLength={MAX_LEN + 40}
          onChange={(e) => {
            setText(e.target.value)
            if (error) setError(null)
            if (note) setNote(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          disabled={sending}
        />

        {composed.text.length > MAX_LEN * 0.8 && (
          <span className={`send-count ${tooLong ? 'over' : ''}`}>
            {MAX_LEN - composed.text.length}
          </span>
        )}

        <button
          className="btn icon sm send-btn"
          onClick={() => void submit()}
          disabled={!canSend}
          title="Send (Enter)"
        >
          <SendIcon />
        </button>
      </div>

      {hint && (
        <div className={`send-note ${hint.bad ? 'err' : ''}`}>
          {hint.bad && <AlertIcon size={11} />}
          {hint.text}
        </div>
      )}
    </div>
  )
}

/** What the composer says while a command is half typed. */
function commandHint(cmd: ComposeCommand): string {
  if (cmd.name === 'clear') return 'Clears the chat feed here - nothing is sent'
  if (!cmd.value) {
    return cmd.name === 'title'
      ? 'Type a title after /title to set it on every destination'
      : 'Type a game after /game to set it on every destination'
  }
  return cmd.name === 'title'
    ? `Sets the title on every connected destination`
    : `Looks up "${cmd.value}" on each destination and sets it`
}

const SendIcon = () => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 12l16-8-6 16-2.5-6.5L4 12z" />
  </svg>
)

export default memo(ChatSend)
