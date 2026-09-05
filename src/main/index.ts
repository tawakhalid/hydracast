import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { randomUUID } from 'crypto'
import path from 'path'
import type {
  ActivityEvent,
  AppConfig,
  AppSettings,
  ChatMessage,
  LogEntry,
  Platform,
  PlatformKind,
  Snapshot,
  StreamInfo,
  StreamInfoPatch,
  StreamInfoResult
} from '@shared/types'
import { supportsStreamInfo } from '@shared/types'
import {
  addPlatform,
  getConfig,
  initConfig,
  removePlatform,
  saveConfig,
  updatePlatform
} from './config'
import { IngestServer } from './ingest'
import { checkDestination } from './diagnose'
import { detectEncoders, RelayManager, resolveFfmpeg } from './relay'
import { ChatManager } from './chat/manager'
import { ViewerCounter } from './viewers'
import { AuthSession } from './auth/session'
import { TWITCH_CLIENT_ID } from './auth/device'
import { ChatSender } from './chat/send'
import { TwitchEventSub } from './eventsub'
import { KickFollows } from './kickfollows'
import { fetchStreamInfo, pushStreamInfo, searchCategories } from './streaminfo'

let mainWindow: BrowserWindow | null = null
let ingest: IngestServer
let relays: RelayManager
let chat: ChatManager
let viewers: ViewerCounter
let auth: AuthSession
let sender: ChatSender
let follows: TwitchEventSub
let kickFollows: KickFollows
let tickTimer: NodeJS.Timeout | null = null
let sessionStartedAt: number | null = null
const logs: LogEntry[] = []

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function log(level: LogEntry['level'], scope: string, message: string): void {
  const entry: LogEntry = {
    id: randomUUID(),
    timestamp: Date.now(),
    level,
    scope,
    message
  }
  logs.push(entry)
  if (logs.length > 400) logs.shift()
  send('log', entry)
}

function snapshot(): Snapshot {
  const stats = relays.getStats()
  // Viewer counts follow the relays: a destination that is not live has no
  // audience to report, and polling one would only spend API quota.
  viewers.setLive(new Set(Object.keys(stats).filter((id) => stats[id].status === 'live')))
  return {
    ingest: ingest.getState(),
    relays: stats,
    chatStatus: chat.getStatus(),
    viewers: viewers.getCounts(),
    auth: auth.getStatus(),
    broadcasting: relays.isAnyLive(),
    sessionStartedAt
  }
}

function createWindow(): void {
  // Fit the work area so the window is never taller than the display.
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(1500, Math.round(screenW * 0.94))
  const height = Math.min(960, Math.round(screenH * 0.94))

  mainWindow = new BrowserWindow({
    width,
    height,
    center: true,
    minWidth: Math.min(1120, width),
    minHeight: Math.min(700, height),
    show: false,
    backgroundColor: '#07080f',
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('maximize', () => send('window-state', { maximized: true }))
  mainWindow.on('unmaximize', () => send('window-state', { maximized: false }))

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

async function bootServices(): Promise<void> {
  const config = getConfig()

  ingest = new IngestServer(config.settings)
  relays = new RelayManager(config.settings)
  chat = new ChatManager(config.settings.chatBufferSize)
  viewers = new ViewerCounter()
  auth = new AuthSession()
  sender = new ChatSender(auth)
  // Follows are the one audience event IRC never carries, so they come over
  // EventSub instead - which needs the account that is already connected.
  follows = new TwitchEventSub(async (platformId) => {
    const account = auth.account(platformId)
    if (!account) return null
    const token = await auth.ensureToken(platformId)
    return token ? { token, userId: account.userId, scopes: account.scopes } : null
  })
  // Kick has no equivalent socket, so its follows arrive via the broker.
  kickFollows = new KickFollows(async (platformId) => {
    const account = auth.account(platformId)
    if (!account) return null
    const token = await auth.ensureToken(platformId)
    return token ? { token, scopes: account.scopes } : null
  })

  // Lets the viewer count spend a connected account's token instead of asking
  // the user for app credentials of their own.
  viewers.setTokenProvider(async (platformId) => {
    const account = auth.account(platformId)
    if (!account) return null
    const token = await auth.ensureToken(platformId)
    return token ? { clientId: TWITCH_CLIENT_ID, token, userId: account.userId } : null
  })

  ingest.on('log', (level: LogEntry['level'], message: string) => log(level, 'ingest', message))
  ingest.on('publish-start', () => {
    const state = ingest.getState()
    relays.setSource(ingest.localSourceUrl, state.fps)
    relays.setSourcePublishing(true)
    send('ingest-publish', true)
    if (getConfig().settings.autoStartOnIngest) {
      log('info', 'relay', 'Encoder detected - auto-starting enabled destinations')
      void startBroadcast()
    }
  })
  ingest.on('publish-stop', () => {
    relays.setSourcePublishing(false)
    send('ingest-publish', false)
  })

  relays.on('log', (level: LogEntry['level'], message: string) => log(level, 'relay', message))
  relays.on('status', () => send('snapshot', snapshot()))

  chat.on('message', (message: ChatMessage) => send('chat-message', message))
  chat.on('activity', (event: ActivityEvent) => send('activity-event', event))
  chat.on('unknown-event', (platform: string, name: string) =>
    log('info', 'chat', `${platform}: unmapped event "${name}" - not shown in the activity feed`)
  )
  chat.on('status', () => send('snapshot', snapshot()))

  viewers.on('log', (level: LogEntry['level'], message: string) => log(level, 'viewers', message))

  auth.on('log', (level: LogEntry['level'], message: string) => log(level, 'auth', message))
  auth.on('status', () => {
    send('snapshot', snapshot())
    // A newly connected account is what makes follower alerts possible.
    follows.sync(getConfig().platforms)
    kickFollows.sync(getConfig().platforms)
  })

  follows.on('log', (level: LogEntry['level'], message: string) => log(level, 'chat', message))
  // Routed through the manager so follows share the activity history and cap.
  follows.on('activity', (event: ActivityEvent) => chat.addActivity(event))

  kickFollows.on('log', (level: LogEntry['level'], message: string) => log(level, 'chat', message))
  kickFollows.on('activity', (event: ActivityEvent) => chat.addActivity(event))

  // The session fetches these but does not own config; applying them here keeps
  // persistence in one place.
  auth.on('identity', (platformId: string, login: string) => {
    const platform = getConfig().platforms.find((p) => p.id === platformId)
    if (!platform) return
    // Each platform keeps its channel in its own field; writing the Twitch one
    // for every kind left a connected Kick account with its channel unset and a
    // Twitch channel it never had.
    const field = platform.kind === 'kick' ? 'kickChannel' : 'twitchChannel'
    if (platform.chat[field] === login) return
    applyPlatform(platformId, {
      chat: { ...platform.chat, [field]: login }
    })
  })
  // Kick supplies the ingest URL as well as the key, and it is per-account.
  auth.on('ingest-url', (platformId: string, url: string) => {
    const platform = getConfig().platforms.find((p) => p.id === platformId)
    if (!platform || platform.url === url) return
    applyPlatform(platformId, { url })
  })
  auth.on('stream-key', (platformId: string, streamKey: string) => {
    const platform = getConfig().platforms.find((p) => p.id === platformId)
    if (!platform || platform.streamKey === streamKey) return
    applyPlatform(platformId, { streamKey })
  })

  relays.syncPlatforms(config.platforms)
  viewers.syncPlatforms(config.platforms)
  auth.init(config.platforms)
  relays.setSource(ingest.localSourceUrl, 0)

  try {
    await ingest.start(config.settings)
  } catch (err) {
    log('error', 'ingest', `Failed to bind RTMP port: ${(err as Error).message}`)
  }

  chat.sync(config.platforms)
  follows.sync(config.platforms)
  kickFollows.sync(config.platforms)

  tickTimer = setInterval(() => {
    ingest.poll()
    send('snapshot', snapshot())
  }, 1000)
}

/** Applies a platform patch and re-syncs every service that reads platforms. */
function applyPlatform(id: string, patch: Partial<Platform>): void {
  const saved = updatePlatform(id, patch)
  relays.syncPlatforms(saved.platforms)
  viewers.syncPlatforms(saved.platforms)
  auth.syncPlatforms(saved.platforms)
  follows.sync(saved.platforms)
  kickFollows.sync(saved.platforms)
  send('config', saved)
}

async function startBroadcast(): Promise<void> {
  const config = getConfig()
  const state = ingest.getState()
  relays.setSource(ingest.localSourceUrl, state.fps)
  relays.setSourcePublishing(state.publishing)
  if (!state.publishing) {
    log(
      'warn',
      'relay',
      'No encoder is publishing yet - relays will retry until Streamlabs connects'
    )
  }
  const enabled = config.platforms.filter((p) => p.enabled)
  if (!enabled.length) {
    log('warn', 'relay', 'No destinations are enabled')
    return
  }
  sessionStartedAt = Date.now()
  log('info', 'relay', `Going live to ${enabled.length} destination(s)`)
  await relays.startAll(config.platforms)
}

async function stopBroadcast(): Promise<void> {
  await relays.stopAll()
  sessionStartedAt = null
  log('info', 'relay', 'Broadcast stopped')
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => getConfig())

  ipcMain.handle('config:save', async (_e, next: AppConfig) => {
    const previous = getConfig()
    const saved = saveConfig(next)
    relays.setSettings(saved.settings)
    relays.syncPlatforms(saved.platforms)
    viewers.syncPlatforms(saved.platforms)
    auth.syncPlatforms(saved.platforms)
    follows.sync(saved.platforms)
    kickFollows.sync(saved.platforms)
    chat.setBufferSize(saved.settings.chatBufferSize)
    chat.sync(saved.platforms)

    const portsChanged =
      previous.settings.rtmpPort !== saved.settings.rtmpPort ||
      previous.settings.httpPort !== saved.settings.httpPort ||
      previous.settings.ingestApp !== saved.settings.ingestApp ||
      previous.settings.ingestKey !== saved.settings.ingestKey

    if (portsChanged) {
      log('info', 'ingest', 'Ingest endpoint changed - restarting RTMP server')
      try {
        await ingest.start(saved.settings)
        relays.setSource(ingest.localSourceUrl, 0)
      } catch (err) {
        log('error', 'ingest', `Restart failed: ${(err as Error).message}`)
      }
    }
    return saved
  })

  ipcMain.handle('platform:update', (_e, id: string, patch: Partial<Platform>) => {
    const before = getConfig().platforms.find((p) => p.id === id)
    const saved = updatePlatform(id, patch)
    relays.syncPlatforms(saved.platforms)
    viewers.syncPlatforms(saved.platforms)
    auth.syncPlatforms(saved.platforms)
    follows.sync(saved.platforms)
    kickFollows.sync(saved.platforms)
    const platform = saved.platforms.find((p) => p.id === id)
    // Only rebuild the chat connector when its identity actually changed -
    // toggling a destination or nudging its bitrate must not drop chat.
    const chatChanged =
      !!platform &&
      (JSON.stringify(before?.chat) !== JSON.stringify(platform.chat) ||
        before?.kind !== platform.kind)
    if (platform && chatChanged) chat.reconnect(platform)
    return saved
  })

  ipcMain.handle('platform:add', (_e, kind: PlatformKind) => {
    const saved = addPlatform(kind)
    relays.syncPlatforms(saved.platforms)
    viewers.syncPlatforms(saved.platforms)
    auth.syncPlatforms(saved.platforms)
    follows.sync(saved.platforms)
    kickFollows.sync(saved.platforms)
    return saved
  })

  ipcMain.handle('platform:remove', async (_e, id: string) => {
    await relays.stop(id)
    chat.disconnect(id)
    const saved = removePlatform(id)
    relays.syncPlatforms(saved.platforms)
    viewers.syncPlatforms(saved.platforms)
    auth.syncPlatforms(saved.platforms)
    follows.sync(saved.platforms)
    kickFollows.sync(saved.platforms)
    return saved
  })

  // Takes the platform by value rather than by id so the settings screen can
  // test unsaved edits.
  ipcMain.handle('relay:test', async (_e, platform: Platform) => {
    const checks = await checkDestination(platform)
    for (const c of checks) {
      const level = c.level === 'error' ? 'error' : c.level === 'warn' ? 'warn' : 'info'
      log(level, 'relay', `${platform.name}: ${c.label} - ${c.detail}`)
    }
    return checks
  })

  ipcMain.handle('relay:start', (_e, id: string) => relays.start(id))
  ipcMain.handle('relay:stop', (_e, id: string) => relays.stop(id))
  ipcMain.handle('broadcast:start', () => startBroadcast())
  ipcMain.handle('broadcast:stop', () => stopBroadcast())

  ipcMain.handle('auth:connect', async (_e, id: string) => {
    await auth.connect(id)
    return auth.getStatus()
  })
  ipcMain.handle('auth:disconnect', async (_e, id: string) => {
    await auth.disconnect(id)
    return getConfig()
  })
  ipcMain.handle('auth:cancel', (_e, id: string) => {
    auth.cancel(id)
    return true
  })
  ipcMain.handle('auth:refresh-key', async (_e, id: string) => {
    await auth.pullStreamKey(id)
    return getConfig()
  })
  ipcMain.handle('auth:has-client-id', () => !!TWITCH_CLIENT_ID)

  /**
   * Stream title and category.
   *
   * Reads come from the platform rather than from config, because the streamer
   * may have changed either from the platform's own dashboard since Hydracast
   * last looked; showing a stale local copy would invite overwriting it.
   */
  /** Reports what an update did, saying nothing for destinations left alone. */
  const logStreamInfo = (results: StreamInfoResult[], platforms: Platform[]): void => {
    for (const result of results) {
      const platform = platforms.find((p) => p.id === result.platformId)
      if (!platform || result.skipped) continue
      if (result.ok) log('success', 'auth', `${platform.name}: stream info updated`)
      else log('warn', 'auth', `${platform.name}: ${result.detail ?? 'update failed'}`)
    }
  }

  ipcMain.handle('stream-info:get', async (_e, id: string) => {
    const platform = getConfig().platforms.find((p) => p.id === id)
    const account = auth.account(id)
    if (!platform || !account) return null
    const token = await auth.ensureToken(id)
    if (!token) return null
    try {
      return await fetchStreamInfo(platform, token, account.userId)
    } catch (err) {
      log(
        'warn',
        'auth',
        `${platform.name}: could not read stream info - ${(err as Error).message}`
      )
      return null
    }
  })

  ipcMain.handle('stream-info:search', async (_e, id: string, query: string) => {
    const platform = getConfig().platforms.find((p) => p.id === id)
    const account = auth.account(id)
    if (!platform || !account) return []
    const token = await auth.ensureToken(id)
    if (!token) return []
    try {
      return await searchCategories(platform, token, query)
    } catch {
      // A failed lookup is an empty picker, not an error worth a log line per
      // keystroke.
      return []
    }
  })

  /** Applies one title/category to several destinations at once. */
  ipcMain.handle(
    'stream-info:set',
    async (_e, platformIds: string[], info: StreamInfo): Promise<StreamInfoResult[]> => {
      const platforms = getConfig().platforms.filter((p) => platformIds.includes(p.id))
      const results = await Promise.all(
        platforms.map(async (platform) => {
          const account = auth.account(platform.id)
          if (!account) {
            return {
              platformId: platform.id,
              ok: false,
              detail: `Connect your ${platform.name} account first`
            }
          }
          const token = await auth.ensureToken(platform.id)
          if (!token) {
            return { platformId: platform.id, ok: false, detail: 'Session expired - connect again' }
          }
          return pushStreamInfo(platform, token, account.userId, account.scopes, info)
        })
      )
      logStreamInfo(results, platforms)
      return results
    }
  )

  /**
   * Applies a title or a game to every connected destination at once.
   *
   * Separate from `stream-info:set` because the caller here has a game *name*
   * rather than an id, and the two platforms number the same game differently -
   * so the lookup has to happen per destination. Doing that in the main process
   * keeps the renderer from having to fan out a search and an update per
   * platform and then reassemble the outcome.
   */
  ipcMain.handle(
    'stream-info:apply-all',
    async (_e, patch: StreamInfoPatch): Promise<StreamInfoResult[]> => {
      const platforms = getConfig().platforms.filter(
        (p) => supportsStreamInfo(p.kind) && auth.account(p.id)
      )
      if (!platforms.length) return []

      const results = await Promise.all(
        platforms.map(async (platform): Promise<StreamInfoResult> => {
          const account = auth.account(platform.id)
          if (!account) {
            return {
              platformId: platform.id,
              ok: false,
              detail: `Connect your ${platform.name} account first`
            }
          }
          const token = await auth.ensureToken(platform.id)
          if (!token) {
            return { platformId: platform.id, ok: false, detail: 'Session expired - connect again' }
          }

          let categoryId = ''
          let categoryName = ''
          if (patch.game) {
            // First match wins. The alternative is a picker, and a command
            // typed mid-stream is chosen precisely to avoid one.
            const found = await searchCategories(platform, token, patch.game).catch(() => [])
            if (!found.length) {
              return {
                platformId: platform.id,
                ok: false,
                detail: `No ${platform.name} category matching "${patch.game}"`
              }
            }
            categoryId = found[0].id
            categoryName = found[0].name
          }

          return pushStreamInfo(platform, token, account.userId, account.scopes, {
            title: patch.title ?? '',
            categoryId,
            categoryName
          })
        })
      )
      logStreamInfo(results, platforms)
      return results
    }
  )

  /**
   * Sends one composed message to the destinations the renderer resolved. It
   * passes ids rather than a route so the routing rule lives in one place -
   * parseCompose in the shared types - and is unit tested there.
   */
  ipcMain.handle('chat:send', async (_e, platformIds: string[], text: string) => {
    const platforms = getConfig().platforms.filter((p) => platformIds.includes(p.id))
    const outcomes = await Promise.all(platforms.map((p) => sender.send(p, text)))
    // Sent messages are not echoed locally: they arrive back over the platform's
    // own chat connection a moment later, and adding an echo showed each one twice.
    for (const outcome of outcomes.filter((o) => !o.ok)) {
      const platform = platforms.find((p) => p.id === outcome.platformId)
      if (platform) log('warn', 'chat', `${platform.name}: ${outcome.detail ?? 'send failed'}`)
    }
    return outcomes
  })

  ipcMain.handle('snapshot:get', () => snapshot())
  ipcMain.handle('logs:get', () => logs)
  ipcMain.handle('chat:history', () => chat.getHistory())
  ipcMain.handle('activity:history', () => chat.getActivity())
  ipcMain.handle('activity:clear', () => {
    chat.clearActivity()
    return true
  })
  ipcMain.handle('chat:clear', () => {
    chat.clearHistory()
    return true
  })
  ipcMain.handle('chat:reconnect', (_e, id: string) => {
    const platform = getConfig().platforms.find((p) => p.id === id)
    if (platform) chat.reconnect(platform)
    return true
  })

  ipcMain.handle('ingest:info', () => ({
    ingestUrl: ingest.publicIngestUrl,
    streamKey: getConfig().settings.ingestKey,
    previewUrl: ingest.previewUrl
  }))
  ipcMain.handle('ingest:restart', async () => {
    await ingest.start(getConfig().settings)
    relays.setSource(ingest.localSourceUrl, 0)
    return true
  })

  ipcMain.handle('system:encoders', () => detectEncoders(getConfig().settings))
  ipcMain.handle('system:ffmpeg-path', () => resolveFfmpeg(getConfig().settings))
  ipcMain.handle('system:pick-ffmpeg', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select ffmpeg executable',
      properties: ['openFile'],
      filters: [{ name: 'Executable', extensions: ['exe'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('system:open-external', (_e, url: string) => shell.openExternal(url))

  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
}

// A second instance would fight over the RTMP port.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    initConfig()
    registerIpc()
    createWindow()
    await bootServices()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  if (tickTimer) clearInterval(tickTimer)
  chat?.dispose()
  auth?.dispose()
  viewers?.dispose()
  relays?.dispose()
  await ingest?.stop()
})
