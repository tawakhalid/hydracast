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
  Snapshot
} from '@shared/types'
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

let mainWindow: BrowserWindow | null = null
let ingest: IngestServer
let relays: RelayManager
let chat: ChatManager
let tickTimer: NodeJS.Timeout | null = null
let sessionStartedAt: number | null = null
const logs: LogEntry[] = []

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function log(level: LogEntry['level'], scope: string, message: string): void {
  const entry: LogEntry = { id: randomUUID(), timestamp: Date.now(), level, scope, message }
  logs.push(entry)
  if (logs.length > 400) logs.shift()
  send('log', entry)
}

function snapshot(): Snapshot {
  return {
    ingest: ingest.getState(),
    relays: relays.getStats(),
    chatStatus: chat.getStatus(),
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

  relays.syncPlatforms(config.platforms)
  relays.setSource(ingest.localSourceUrl, 0)

  try {
    await ingest.start(config.settings)
  } catch (err) {
    log('error', 'ingest', `Failed to bind RTMP port: ${(err as Error).message}`)
  }

  chat.sync(config.platforms)

  tickTimer = setInterval(() => {
    ingest.poll()
    send('snapshot', snapshot())
  }, 1000)
}

async function startBroadcast(): Promise<void> {
  const config = getConfig()
  const state = ingest.getState()
  relays.setSource(ingest.localSourceUrl, state.fps)
  relays.setSourcePublishing(state.publishing)
  if (!state.publishing) {
    log('warn', 'relay', 'No encoder is publishing yet - relays will retry until Streamlabs connects')
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
    return saved
  })

  ipcMain.handle('platform:remove', async (_e, id: string) => {
    await relays.stop(id)
    chat.disconnect(id)
    const saved = removePlatform(id)
    relays.syncPlatforms(saved.platforms)
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
  relays?.dispose()
  await ingest?.stop()
})
