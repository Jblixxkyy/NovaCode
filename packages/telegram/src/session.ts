import type { Config } from "./config"
import type { Store, SessionEntry } from "./store"

export interface GroupTopicContext {
  isDm: boolean
  hasTopicsEnabled?: boolean
}

export class SessionMap {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
  ) {}

  key(chatId: number | string, threadId?: number, ctx?: GroupTopicContext): string {
    if (!threadId) return `${chatId}`
    if (ctx && !ctx.isDm && threadId === 1) return `${chatId}`
    if (ctx?.isDm && !ctx.hasTopicsEnabled) return `${chatId}`
    return `${chatId}:topic:${threadId}`
  }

  get(chatId: number | string, threadId?: number, ctx?: GroupTopicContext): SessionEntry | undefined {
    return this.store.getSession(this.key(chatId, threadId, ctx))
  }

  set(chatId: number | string, threadId: number | undefined, entry: SessionEntry, ctx?: GroupTopicContext): void {
    this.store.setSession(this.key(chatId, threadId, ctx), entry)
  }

  delete(chatId: number | string, threadId?: number, ctx?: GroupTopicContext): boolean {
    return this.store.deleteSession(this.key(chatId, threadId, ctx))
  }

  resolveAgent(chatId: number | string, threadId?: number, ctx?: GroupTopicContext): string | undefined {
    const groups = this.config.groups
    if (ctx?.isDm) return undefined
    const groupKey = String(chatId)
    const groupConfig = groups[groupKey]
    if (!groupConfig) return undefined
    if (threadId && threadId !== 1) {
      const topic = groupConfig.topics?.[String(threadId)]
      if (topic?.agent) return topic.agent
    }
    return groupConfig.agent
  }

  resolveModel(chatId: number | string, threadId?: number, ctx?: GroupTopicContext): string | undefined {
    const groups = this.config.groups
    if (ctx?.isDm) return undefined
    const groupKey = String(chatId)
    const groupConfig = groups[groupKey]
    if (!groupConfig) return undefined
    if (threadId && threadId !== 1) {
      const topic = groupConfig.topics?.[String(threadId)]
      if (topic?.model) return topic.model
    }
    return groupConfig.model
  }

  setAgent(chatId: number | string, threadId: number | undefined, agent: string, ctx?: GroupTopicContext): void {
    const key = this.key(chatId, threadId, ctx)
    const existing = this.store.getSession(key)
    const next: SessionEntry = existing
      ? { ...existing, agent }
      : { sessionId: "", createdAt: Date.now(), agent }
    this.store.setSession(key, next)
  }

  setModel(chatId: number | string, threadId: number | undefined, model: string, ctx?: GroupTopicContext): void {
    const key = this.key(chatId, threadId, ctx)
    const existing = this.store.getSession(key)
    const next: SessionEntry = existing
      ? { ...existing, model }
      : { sessionId: "", createdAt: Date.now(), model }
    this.store.setSession(key, next)
  }

  getDirectory(chatId: number | string, threadId?: number, ctx?: GroupTopicContext): string | undefined {
    const key = this.key(chatId, threadId, ctx)
    return this.store.getSession(key)?.directory
  }

  setDirectory(chatId: number | string, threadId: number | undefined, directory: string, ctx?: GroupTopicContext): void {
    const key = this.key(chatId, threadId, ctx)
    const existing = this.store.getSession(key)
    const next: SessionEntry = existing
      ? { ...existing, directory }
      : { sessionId: "", createdAt: Date.now(), directory }
    this.store.setSession(key, next)
  }

  count(): number {
    return this.store.sessionCount()
  }
}