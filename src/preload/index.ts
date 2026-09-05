import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActivityEvent,
  AppConfig,
  AuthStatus,
  CategoryOption,
  ChatMessage,
  CheckResult,
  LogEntry,
  Platform,
  PlatformKind,
  SendOutcome,
  Snapshot,
  StreamInfo,
  StreamInfoPatch,
  StreamInfoResult
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

  connectAccount: (id: string): Promise<Record<string, AuthStatus>> =>
    ipcRenderer.invoke('auth:connect', id),
  disconnectAccount: (id: string): Promise<AppConfig> => ipcRenderer.invoke('auth:disconnect', id),
  cancelConnect: (id: string): Promise<boolean> => ipcRenderer.invoke('auth:cancel', id),
  refreshStreamKey: (id: string): Promise<AppConfig> => ipcRenderer.invoke('auth:refresh-key', id),
  hasClientId: (): Promise<boolean> => ipcRenderer.invoke('auth:has-client-id'),

  sendChat: (platformIds: string[], text: string): Promise<SendOutcome[]> =>
    ipcRenderer.invoke('chat:send', platformIds, text),

  getStreamInfo: (id: string): Promise<StreamInfo | null> =>
    ipcRenderer.invoke('stream-info:get', id),
  searchCategories: (id: string, query: string): Promise<CategoryOption[]> =>
    ipcRenderer.invoke('stream-info:search', id, query),
  /** Sets a title or a game on every connected destination; absent fields stay. */
  applyStreamInfo: (patch: StreamInfoPatch): Promise<StreamInfoResult[]> =>
    ipcRenderer.invoke('stream-info:apply-all', patch),

  setStreamInfo: (platformIds: string[], info: StreamInfo): Promise<StreamInfoResult[]> =>
    ipcRenderer.invoke('stream-info:set', platformIds, info),

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
  onConfig: (cb: (c: AppConfig) => void): (() => void) => {
    const handler = (_e: unknown, c: AppConfig): void => cb(c)
    ipcRenderer.on('config', handler)
    return () => ipcRenderer.removeListener('config', handler)
  },
  onWindowState: (cb: (s: { maximized: boolean }) => void): (() => void) => {
    const handler = (_e: unknown, s: { maximized: boolean }): void => cb(s)
    ipcRenderer.on('window-state', handler)
    return () => ipcRenderer.removeListener('window-state', handler)
  }
}

export type HydracastApi = typeof api

contextBridge.exposeInMainWorld('hydracast', api)
