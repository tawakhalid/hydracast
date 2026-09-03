import { app } from 'electron'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import {
  AppConfig,
  DEFAULT_SETTINGS,
  DEFAULT_VIDEO,
  ensureLayouts,
  Platform,
  PLATFORM_PRESETS,
  PlatformKind
} from '@shared/types'

let configPath = ''
let cache: AppConfig | null = null

function makePlatform(kind: PlatformKind, enabled = false): Platform {
  const preset = PLATFORM_PRESETS.find((p) => p.kind === kind)!
  return {
    id: randomUUID(),
    kind,
    name: preset.name,
    url: preset.url,
    streamKey: '',
    enabled,
    video: { ...DEFAULT_VIDEO, videoBitrate: preset.recommendedBitrate },
    chat: { enabled: true }
  }
}

function defaultConfig(): AppConfig {
  return {
    settings: { ...DEFAULT_SETTINGS },
    platforms: [makePlatform('twitch'), makePlatform('youtube')]
  }
}

/**
 * Fills in fields added by newer versions so an old config file never
 * produces `undefined` deep in the relay argument builder.
 *
 * This only ever adds missing fields. Nothing here may rewrite or clear a value
 * the user entered: a migration that edits saved credentials destroys a working
 * setup on load, and the user has no way to tell that it happened.
 */
function migrate(raw: Partial<AppConfig>): AppConfig {
  const base = defaultConfig()
  const settings = ensureLayouts({ ...base.settings, ...(raw.settings ?? {}) })
  const platforms = (raw.platforms ?? base.platforms).map((p) => ({
    ...p,
    id: p.id || randomUUID(),
    video: { ...DEFAULT_VIDEO, ...(p.video ?? {}) },
    chat: { ...(p.chat ?? {}), enabled: p.chat?.enabled ?? true }
  }))
  return { settings, platforms }
}

export function initConfig(): AppConfig {
  configPath = path.join(app.getPath('userData'), 'hydracast.config.json')
  try {
    if (fs.existsSync(configPath)) {
      cache = migrate(JSON.parse(fs.readFileSync(configPath, 'utf-8')))
    } else {
      cache = defaultConfig()
      persist()
    }
  } catch {
    // A corrupt file must not stop the app from booting.
    cache = defaultConfig()
  }
  return cache
}

export function getConfig(): AppConfig {
  if (!cache) return initConfig()
  return cache
}

function persist(): void {
  if (!cache || !configPath) return
  fs.writeFileSync(configPath, JSON.stringify(cache, null, 2), 'utf-8')
}

export function saveConfig(next: AppConfig): AppConfig {
  cache = migrate(next)
  persist()
  return cache
}

export function updatePlatform(id: string, patch: Partial<Platform>): AppConfig {
  const cfg = getConfig()
  cfg.platforms = cfg.platforms.map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p))
  return saveConfig(cfg)
}

export function addPlatform(kind: PlatformKind): AppConfig {
  const cfg = getConfig()
  cfg.platforms = [...cfg.platforms, makePlatform(kind)]
  return saveConfig(cfg)
}

export function removePlatform(id: string): AppConfig {
  const cfg = getConfig()
  cfg.platforms = cfg.platforms.filter((p) => p.id !== id)
  return saveConfig(cfg)
}

export function getConfigPath(): string {
  return configPath
}
