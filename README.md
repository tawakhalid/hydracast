# Hydracast

[![Release](https://img.shields.io/github/v/release/tawakhalid/hydracast?style=flat-square)](https://github.com/tawakhalid/hydracast/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/tawakhalid/hydracast/total?style=flat-square)](https://github.com/tawakhalid/hydracast/releases)
[![Licence](https://img.shields.io/badge/licence-MIT-blue?style=flat-square)](LICENSE)

**Free and open source. No account, no subscription, no bitrate tax.**

One stream in from Streamlabs or OBS, many streams out. Hydracast takes a single local feed and
fans it out to Twitch, YouTube, Kick, Facebook, Trovo, TikTok or any custom RTMP endpoint - each
destination with its own stream key, its own video bitrate, and its own on/off switch. Live
latency and health per platform, a local preview, and every platform's chat merged into one
timestamped feed.

```
Streamlabs / OBS ─▶ rtmp://localhost:1935/live ─▶ Hydracast ─┬─▶ Twitch    (passthrough)
                                                             ├─▶ YouTube   (re-encode 4500k)
                                                             └─▶ Kick      (re-encode 6000k)
```

---

## Download

Grab the latest build from the [**Releases**](https://github.com/tawakhalid/hydracast/releases/latest) page:

| File | What it is |
| --- | --- |
| `Hydracast-Setup-<version>.exe` | Windows installer - pick your folder, adds a Start Menu and desktop shortcut |
| `Hydracast-Portable-<version>.exe` | Single portable executable, no install |

Windows 10/11, 64-bit. ffmpeg is bundled - nothing else to install.

Windows SmartScreen will warn on first run because the build is not code-signed (a signing
certificate costs money; this app does not take any). Click **More info -> Run anyway**.

---

## Building from source

```bash
npm install
```

```bash
npm run dev
```

Build a distributable Windows installer:

```bash
npm run dist
```

The installer lands in `release/`. `npm run dist:portable` produces a single portable `.exe`
instead.

---

## Pointing Streamlabs at Hydracast

1. Start Hydracast. The top bar shows the ingest endpoint and key — both have copy buttons.
2. In Streamlabs: **Settings → Stream → Stream to custom ingest**.
3. Server: `rtmp://localhost:1935/live`  ·  Stream key: `streamlabs`
4. Hit **Go Live** in Streamlabs. Hydracast's preview lights up and the status pill flips to
   *Streamlabs connected*.
5. Hit **Go live** in Hydracast to push to every enabled destination.

The port, application path and local key are all editable under **Settings → Application**;
changing them restarts the ingest server in place.

Windows Firewall will ask for network access the first time — Hydracast has to bind a local
RTMP port, so allow it on private networks.

---

## Per-platform video bitrate

Every destination runs its own ffmpeg process, so each one can carry a different bitrate from
the same source feed. Each card has a mode chip that expands into an inline control:

| Mode | What happens | Cost |
| --- | --- | --- |
| **Passthrough** | `-c copy`, the Streamlabs feed is forwarded byte-for-byte | ~0% CPU |
| **Re-encode** | Video is transcoded to your target bitrate with CBR rate control | one encoder session per destination |

Re-encode mode also exposes encoder (x264 / NVENC / QuickSync / AMF — only the ones your ffmpeg
actually supports are offered), resolution, frame rate, buffer size, audio bitrate and keyframe
interval. Bitrate changes apply the next time that destination starts.

A typical setup: send 8000k out of Streamlabs, pass it through to Twitch untouched, and
re-encode a 4000k copy for Facebook — one capture, two very different outputs.

---

## Chat

Twitch, YouTube and Kick messages are merged into one feed, each tagged with its platform icon
and the timestamp the platform itself assigned to the message.

- **Twitch** — anonymous read-only IRC. Just enter the channel name; no token, no login.
- **YouTube** — needs a YouTube Data API v3 key. Give it a video id or a channel id (the channel
  id auto-discovers the active broadcast). Polling honours the interval the API returns so it
  does not burn quota.
- **Kick** — read-only over Kick's public Pusher socket; enter the channel name, no login. The
  chatroom id is looked up automatically, but that lookup sits behind Cloudflare. If the feed
  reports a challenge, open `kick.com/api/v2/channels/<your-channel>` in a browser and paste the
  `chatroom.id` into the Chat tab. Kick does not document this endpoint, so it can change without
  notice — the connector reports exactly what broke rather than showing an empty feed.

Facebook, Trovo and TikTok are relay-only: their chat needs an OAuth app registration, which
Hydracast deliberately avoids.

Click a platform chip to mute that source in the feed, double-click it to reconnect.

---

## When a destination will not connect

Every relay is checked before ffmpeg is launched, and **Test destination** in the settings editor
runs the same checks on demand — it validates the URL and key, resolves the host, opens a TCP
connection and completes the TLS handshake, reporting each step. Anything that fails lands in the
Activity log along with ffmpeg's own stderr and the exact command that was run, with the stream
key redacted.

A relay that never reaches `live` is treated as a configuration problem, not a blip: it retries
with a widening back-off and then stops, so the cause stays on screen instead of being buried
under an endless "reconnecting".

**Kick specifically.** Kick runs on Amazon IVS, which issues every channel its own ingest host,
so there is no shared URL that works for anyone else — paste the Stream URL from your Kick
dashboard exactly as shown. If it gives only the host, the `:443/app` part is filled in when the
relay starts; the value you typed is never rewritten, and the log states the address actually
published to. IVS is also stricter than Twitch: it terminates any session whose keyframe interval
exceeds 2 seconds or whose bitrate is over the channel ceiling, and it holds a session open for
up to a minute after a disconnect, rejecting reconnects with the same key in the meantime. In
passthrough mode the keyframe interval is whatever Streamlabs sends, so set Streamlabs to 2 s
or switch the destination to re-encode.

---

## Metrics

- **Latency** — real TCP round-trip to that platform's ingest edge, sampled every 5 seconds and
  drawn as a sparkline.
- **Outgoing** — bitrate ffmpeg is actually pushing, parsed from its progress stream.
- **Dropped** — frames dropped on that destination.
- **Health** — a 0–100 composite of encode speed, dropped frames, latency and reconnect count.

If a platform drops the connection, the relay reconnects on its own (configurable, on by
default) and the card shows *Reconnecting* rather than silently dying.

---

## Verifying the pipeline

```bash
npm run test:pipeline
```

This boots the real ingest server, publishes a synthetic 6000k feed into it, stands up a second
RTMP server as a stand-in platform, and asserts the relay delivers full rate in passthrough mode
and the requested lower rate in re-encode mode. Requires `ffmpeg` on `PATH`.

---

## Layout

```
src/
  main/          Electron main process
    ingest.ts      local RTMP server + HTTP-FLV preview source
    relay.ts       per-platform ffmpeg processes, stats, reconnect
    latency.ts     TCP round-trip probe
    config.ts      persisted settings (userData/hydracast.config.json)
    diagnose.ts    destination config + DNS/TCP/TLS checks
    chat/          Twitch IRC, YouTube live chat and Kick Pusher connectors
  preload/       context-isolated IPC bridge
  renderer/      React UI
  shared/        types shared across the bridge
```

ffmpeg resolution order: the path set in Settings, then the bundled `ffmpeg-static` binary, then
`ffmpeg` on `PATH`.

---

## Contributing

Issues and pull requests are welcome. Hydracast is MIT licensed and intended to stay free for the
community forever - if it saves you a subscription, that is the whole point.

Ideas that would help most:

- A chat connector for Trovo
- Per-destination audio track selection
- Stream health alerts (desktop notification when a platform drops)
- macOS and Linux builds

## Licence

[MIT](LICENSE) - Copyright (c) 2026 Khalid Tawabini
