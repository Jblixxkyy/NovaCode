import type { Config } from "./config"

export interface PairingEntry {
  userId: number
  createdAt: number
  expiresAt: number
}

export interface SessionEntry {
  sessionId: string
  agent?: string
  model?: string
  directory?: string
  createdAt: number
}

export interface Audit {
  lastConfigLoad: number
  transport: "polling" | "webhook"
  lastError?: string
}

interface PersistedState {
  pairings: Array<[string, PairingEntry]>
  pairedUsers: number[]
  sessions: Array<[string, SessionEntry]>
  updateOffsets: Array<[string, number]>
  sentMessages: Array<[string, number]>
  audit: Audit
}

const EMPTY: PersistedState = {
  pairings: [],
  pairedUsers: [],
  sessions: [],
  updateOffsets: [],
  sentMessages: [],
  audit: { lastConfigLoad: 0, transport: "polling" },
}

export class Store {
  private readonly path: string
  private readonly config: Config
  private pairings = new Map<string, PairingEntry>()
  private pairedUsers = new Set<number>()
  private sessions = new Map<string, SessionEntry>()
  private updateOffsets = new Map<string, number>()
  private sentMessages = new Map<string, number>()
  private audit: Audit = { lastConfigLoad: 0, transport: "polling" }
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly flushDelay = 500

  constructor(config: Config) {
    this.config = config
    this.path = config.stateFile
  }

  async load(): Promise<void> {
    const file = Bun.file(this.path)
    const exists = await file.exists()
    if (!exists) {
      this.audit.lastConfigLoad = Date.now()
      return
    }
    const parsed = (await file.json().catch(() => EMPTY)) as Partial<PersistedState>
    this.pairings = new Map(parsed.pairings ?? [])
    this.pairedUsers = new Set(parsed.pairedUsers ?? [])
    this.sessions = new Map(parsed.sessions ?? [])
    this.updateOffsets = new Map(parsed.updateOffsets ?? [])
    this.sentMessages = new Map(parsed.sentMessages ?? [])
    this.audit = { ...EMPTY.audit, ...(parsed.audit ?? {}) }
    this.audit.lastConfigLoad = Date.now()
    this.dirty = false
  }

  save(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, this.flushDelay)
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const data: PersistedState = {
      pairings: Array.from(this.pairings.entries()),
      pairedUsers: Array.from(this.pairedUsers),
      sessions: Array.from(this.sessions.entries()),
      updateOffsets: Array.from(this.updateOffsets.entries()),
      sentMessages: Array.from(this.sentMessages.entries()),
      audit: this.audit,
    }
    await Bun.write(this.path, JSON.stringify(data, null, 2))
  }

  createPairing(code: string, userId: number, ttlMs = 60 * 60 * 1000): PairingEntry {
    const now = Date.now()
    const entry: PairingEntry = { userId, createdAt: now, expiresAt: now + ttlMs }
    this.pairings.set(code, entry)
    this.save()
    return entry
  }

  consumePairing(code: string, userId: number): PairingEntry | null {
    const entry = this.pairings.get(code)
    if (!entry) return null
    this.pairings.delete(code)
    if (entry.userId !== userId) return null
    if (entry.expiresAt < Date.now()) return null
    return entry
  }

  getPairing(code: string): PairingEntry | undefined {
    return this.pairings.get(code)
  }

  pair(userId: number): boolean {
    if (this.pairedUsers.has(userId)) return false
    this.pairedUsers.add(userId)
    this.save()
    return true
  }

  unpair(userId: number): boolean {
    const had = this.pairedUsers.delete(userId)
    if (had) this.save()
    return had
  }

  isPaired(userId: number): boolean {
    return this.pairedUsers.has(userId)
  }

  pairedCount(): number {
    return this.pairedUsers.size
  }

  setSession(key: string, entry: SessionEntry): void {
    this.sessions.set(key, entry)
    this.save()
  }

  getSession(key: string): SessionEntry | undefined {
    return this.sessions.get(key)
  }

  deleteSession(key: string): boolean {
    const had = this.sessions.delete(key)
    if (had) this.save()
    return had
  }

  sessionCount(): number {
    return this.sessions.size
  }

  sessionEntries(): IterableIterator<[string, SessionEntry]> {
    return this.sessions.entries()
  }

  setOffset(token: string, offset: number): void {
    this.updateOffsets.set(token, offset)
    this.save()
  }

  getOffset(token: string): number | undefined {
    return this.updateOffsets.get(token)
  }

  setSentMessage(chatKey: string, messageId: number): void {
    this.sentMessages.set(chatKey, messageId)
  }

  getSentMessage(chatKey: string): number | undefined {
    return this.sentMessages.get(chatKey)
  }

  deleteSentMessage(chatKey: string): void {
    this.sentMessages.delete(chatKey)
  }

  recordError(message: string): void {
    this.audit.lastError = message
    this.save()
  }

  getAudit(): Audit {
    return this.audit
  }
}