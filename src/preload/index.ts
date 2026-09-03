import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActivityEvent,
  AppConfig,
  ChatMessage,
  CheckResult,
  LogEntry,
  Platform,
  PlatformKind,
  Snapshot
} from '@shared/types'

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  saveConfig: (config: AppConfig): Promise<AppConfig> => ipcRenderer.invoke('config:save', config),

  updatePlatform: (id: string, patch: Partial<Platform>): Promise<AppConfig> =>
    ipcRenderer.invoke('platform:update', id, patch),
  addPlatform: (kind: PlatformKind): Promise<AppConfig> => ipcRenderer.invoke('platform:add', kind),
  removePlatform: (id: string): Promise<AppConfig> => ipcRenderer.invoke('platform:remove', id),

  testRelay: (platform: Platform): Promise<CheckResult[]> =>
    ipcRenderer.invoke('relay:test', platform),
  startRelay: (id: string): Promise<void> => ipcRenderer.invoke('relay:start', id),
  stopRelay: (id: string): Promise<void> => ipcRenderer.invoke('relay:stop', id),
  startBroadcast: (): Promise<void> => ipcRenderer.invoke('broadcast:start'),
  stopBroadcast: (): Promise<void> => ipcRenderer.invoke('broadcast:stop'),

  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke('snapshot:get'),
  getLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke('logs:get'),
  getChatHistory: (): Promise<ChatMessage[]> => ipcRenderer.invoke('chat:history'),
  getActivity: (): Promise<ActivityEvent[]> => ipcRenderer.invoke('activity:history'),
  clearActivity: (): Promise<boolean> => ipcRenderer.invoke('activity:clear'),
  clearChat: (): Promise<boolean> => ipcRenderer.invoke('chat:clear'),
  reconnectChat: (id: string): Promise<boolean> => ipcRenderer.invoke('chat:reconnect', id),

  getIngestInfo: (): Promise<{ ingestUrl: string; streamKey: string; previewUrl: string }> =>
    ipcRenderer.invoke('ingest:info'),
  restartIngest: (): Promise<boolean> => ipcRenderer.invoke('ingest:restart'),

  detectEncoders: (): Promise<string[]> => ipcRenderer.invoke('system:encoders'),
  getFfmpegPath: (): Promise<string> => ipcRenderer.invoke('system:ffmpeg-path'),
  pickFfmpeg: (): Promise<string | null> => ipcRenderer.invoke('system:pick-ffmpeg'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('system:open-external', url),

  minimize: (): void => ipcRenderer.send('window:minimize'),
  toggleMaximize: (): void => ipcRenderer.send('window:maximize'),
  close: (): void => ipcRenderer.send('window:close'),

  onSnapshot: (cb: (s: Snapshot) => void): (() => void) => {
    const handler = (_e: unknown, s: Snapshot): void => cb(s)
    ipcRenderer.on('snapshot', handler)
    return () => ipcRenderer.removeListener('snapshot', handler)
  },
  onChatMessage: (cb: (m: ChatMessage) => void): (() => void) => {
    const handler = (_e: unknown, m: ChatMessage): void => cb(m)
    ipcRenderer.on('chat-message', handler)
    return () => ipcRenderer.removeListener('chat-message', handler)
  },
  onActivity: (cb: (e: ActivityEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: ActivityEvent): void => cb(event)
    ipcRenderer.on('activity-event', handler)
    return () => ipcRenderer.removeListener('activity-event', handler)
  },
  onLog: (cb: (l: LogEntry) => void): (() => void) => {
    const handler = (_e: unknown, l: LogEntry): void => cb(l)
    ipcRenderer.on('log', handler)
    return () => ipcRenderer.removeListener('log', handler)
  },
  onIngestPublish: (cb: (publishing: boolean) => void): (() => void) => {
    const handler = (_e: unknown, publishing: boolean): void => cb(publishing)
    ipcRenderer.on('ingest-publish', handler)
    return () => ipcRenderer.removeListener('ingest-publish', handler)
  },
  onWindowState: (cb: (s: { maximized: boolean }) => void): (() => void) => {
    const handler = (_e: unknown, s: { maximized: boolean }): void => cb(s)
    ipcRenderer.on('window-state', handler)
    return () => ipcRenderer.removeListener('window-state', handler)
  }
}

export type HydracastApi = typeof api

contextBridge.exposeInMainWorld('hydracast', api)
