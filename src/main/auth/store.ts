import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import type { PlatformKind } from '@shared/types'

/**
 * Persisted OAuth tokens, encrypted at rest.
 *
 * Deliberately a separate file from `hydracast.config.json` rather than another
 * field on it. The config is plain JSON the user is encouraged to look at, and
 * it already carries stream keys; a refresh token is worse than a stream key,
 * because it can post as the user and read their channel. Keeping the two apart
 * means a config that gets pasted into an issue or shown on stream leaks
 * nothing that can act on someone's account.
 *
 * Encryption is Electron's `safeStorage`, which is DPAPI on Windows - the
 * ciphertext is bound to the OS user account, so copying the file to another
 * machine yields nothing.
 */

export interface StoredToken {
  kind: PlatformKind
  accessToken: string
  /**
   * Twitch refresh tokens are single-use: refreshing returns a new one and
   * invalidates this. It must be written back on every refresh or the account
   * silently disconnects the next time the app restarts.
   */
  refreshToken: string
  /** Epoch ms. Twitch access tokens last only 4 hours. */
  expiresAt: number
  scopes: string[]
  userId: string
  login: string
  displayName: string
  avatarUrl?: string
}

interface FileShape {
  version: 1
  /** base64 of the safeStorage-encrypted JSON payload. */
  encrypted: string
}

/** Keyed by platform id. */
type Records = Record<string, StoredToken>

export class TokenStore {
  private records: Records = {}
  private filePath = ''
  /** False when the OS offers no encryption; nothing is written in that case. */
  private canPersist = false

  init(): void {
    this.filePath = path.join(app.getPath('userData'), 'hydracast.auth.json')
    try {
      this.canPersist = safeStorage.isEncryptionAvailable()
    } catch {
      this.canPersist = false
    }
    this.load()
  }

  /**
   * True when tokens survive a restart. When false the app still works for the
   * session, but the UI has to say the login will not be remembered rather than
   * quietly dropping it - and a plaintext fallback is never written.
   */
  get persistent(): boolean {
    return this.canPersist
  }

  private load(): void {
    if (!this.canPersist || !fs.existsSync(this.filePath)) return
    try {
      const file = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as FileShape
      if (file.version !== 1 || !file.encrypted) return
      const json = safeStorage.decryptString(Buffer.from(file.encrypted, 'base64'))
      const parsed = JSON.parse(json) as Records
      if (parsed && typeof parsed === 'object') this.records = parsed
    } catch {
      // A file encrypted by another OS user, or a corrupt one, must not stop
      // the app booting. Losing it costs one re-login, so it is dropped.
      this.records = {}
    }
  }

  private persist(): void {
    if (!this.canPersist) return
    try {
      const encrypted = safeStorage.encryptString(JSON.stringify(this.records)).toString('base64')
      const file: FileShape = { version: 1, encrypted }
      fs.writeFileSync(this.filePath, JSON.stringify(file), 'utf-8')
    } catch {
      /* a failed write costs a re-login, not a broken session */
    }
  }

  get(platformId: string): StoredToken | undefined {
    return this.records[platformId]
  }

  all(): Records {
    return { ...this.records }
  }

  set(platformId: string, token: StoredToken): void {
    this.records[platformId] = token
    this.persist()
  }

  /** Rewrites just the token half, keeping the identity fields already stored. */
  update(platformId: string, patch: Partial<StoredToken>): void {
    const existing = this.records[platformId]
    if (!existing) return
    this.records[platformId] = { ...existing, ...patch }
    this.persist()
  }

  remove(platformId: string): void {
    delete this.records[platformId]
    this.persist()
  }

  /** Drops entries for destinations that no longer exist. */
  prune(keepIds: string[]): void {
    const keep = new Set(keepIds)
    let changed = false
    for (const id of Object.keys(this.records)) {
      if (!keep.has(id)) {
        delete this.records[id]
        changed = true
      }
    }
    if (changed) this.persist()
  }
}
