# Hydracast OAuth broker

A single Cloudflare Worker that holds the Kick **client secret**.

## Why this exists

Kick has no public OAuth client type. Its token endpoint requires
`client_secret` for the initial code exchange *and* for every refresh —
verified directly: the same authorization code returned HTTP 400 without the
secret and HTTP 200 with it.

Hydracast ships as an unpacked Electron app, so anything embedded in it can be
read with a text editor. A leaked client secret would let someone raise an
OAuth consent screen wearing Hydracast's name, and a suspension earned by their
abuse would break every install at once.

So the desktop app runs the whole PKCE flow itself and hands this Worker only
the authorization code and the verifier. The Worker adds the secret, forwards
to Kick, and returns the reply untouched.

Twitch does not need this — its device flow accepts our client id with no
secret at all, so Twitch talks to `id.twitch.tv` directly.

## What it holds

Tokens pass through and are never logged, cached, or persisted; the only
long-lived secret here is the app's own client secret.

Follower events are the one exception, and a deliberate one. Kick delivers
events only by webhook to a public HTTPS URL, so a desktop app cannot receive
them at all - the broker is the only public address Hydracast has. Each channel
keeps at most its last 50 follows for 6 hours, so an app that was closed when
someone followed still sees it. Follower names are the only personal data here
and they expire on their own.

## Endpoints

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | Liveness check |
| `POST` | `/kick/token` | `{ code, code_verifier, redirect_uri }` | Exchange an authorization code |
| `POST` | `/kick/refresh` | `{ refresh_token }` | Refresh an expired access token |
| `POST` | `/kick/events` | Kick's webhook body | Receives `channel.followed` |
| `GET` | `/kick/stream` | — | WebSocket; pushes a channel's follows to the app |

`/kick/events` is public by necessity, so **every delivery is signature
checked** - Kick signs `id.timestamp.body` with RSA-SHA256 and publishes the key
at `api.kick.com/public/v1/public-key`. Without that check, anyone who learned
the URL could post invented follower alerts straight into a user's feed. An
unsigned or badly signed request gets 401 and is dropped.

`/kick/stream` authenticates with the app's own Kick access token, sent as an
`Authorization` header rather than a query parameter so it stays out of request
logs. The broker spends it on the one call that names the account and serves
only that channel's events, so there is no extra credential to issue or leak.

`redirect_uri` is pinned to `http://localhost:8788/kick/callback`. Anything
else is refused, so the broker cannot be used to finish a flow that was started
against somebody else's listener.

Kick answers its errors with an empty body, so a rejected grant is repackaged
as `{ error, status, detail }` and the upstream status code is preserved — the
app needs to tell an expired code from a revoked one.

## Kick app settings

The callback URL is configured on the **app**, not per subscription, so set it
in Kick's developer portal alongside the redirect URL:

```
Webhook URL:  https://<your-worker>.workers.dev/kick/events
```

Without it Kick has nowhere to deliver, and follower alerts stay silent with no
error anywhere - the subscription call still succeeds.

## Deploying

```sh
cd broker
npm install
npx wrangler login          # opens a browser; a free Cloudflare account is enough
npx wrangler secret put KICK_CLIENT_ID
npx wrangler secret put KICK_CLIENT_SECRET
npx wrangler deploy
```

`wrangler secret put` prompts for the value and stores it encrypted on
Cloudflare. Never put either value in `wrangler.toml` — that file is committed.

Deploy prints the Worker URL. Confirm it with:

```sh
curl https://<your-worker>.workers.dev/health   # -> {"ok":true}
```

That URL goes into `src/main/auth/kick.ts` as the broker base. It is not a
secret: it accepts only PKCE exchanges pinned to a loopback redirect.
