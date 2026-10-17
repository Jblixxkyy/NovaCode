import type { Bot } from "grammy"
import type { Config } from "./config"
import type { Logger } from "./logging"
import type { Store } from "./store"
import { formatTelegramText } from "./format"

const chatKey = (chatId: number, threadId: number | undefined) => `${chatId}:${threadId ?? "main"}`

export class StreamingPreview {
  private readonly bot: Bot
  private readonly config: Config
  private readonly log: Logger
  private readonly store: Store
  private readonly chatId: number
  private readonly threadId: number | undefined
  private readonly key: string

  private messageId: number | undefined
  private buffer = ""
  private lastSentLen = 0
  private lastSentAt = 0
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private destroyed = false

  constructor(bot: Bot, config: Config, log: Logger, store: Store, chatId: number, threadId?: number) {
    this.bot = bot
    this.config = config
    this.log = log
    this.store = store
    this.chatId = chatId
    this.threadId = threadId
    this.key = chatKey(chatId, threadId)
  }

  async start(): Promise<void> {
    if (!this.config.streaming.enabled) return
    try {
      const sent = await this.bot.api.sendMessage(this.chatId, "Thinking...", {
        message_thread_id: this.threadId && this.threadId !== 1 ? this.threadId : undefined,
      })
      this.messageId = sent.message_id
      this.lastSentAt = Date.now()
      this.store.setSentMessage(this.key, sent.message_id)
    } catch (err) {
      this.log.debug("streaming preview start failed:", err)
    }
  }

  append(delta: string): void {
    if (this.destroyed) return
    if (!this.messageId) return
    if (!delta) return

    this.buffer += delta

    const debounce = this.config.streaming.debounceMs
    const minDelta = this.config.streaming.minDelta
    const now = Date.now()
    const grew = this.buffer.length - this.lastSentLen

    if (grew >= minDelta && now - this.lastSentAt >= debounce) {
      void this.flush()
      return
    }

    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.flush()
    }, debounce)
  }

  async flush(): Promise<void> {
    if (this.destroyed) return
    if (!this.messageId) return
    const text = this.buffer
    if (text.length === this.lastSentLen) return

    const messageId = this.messageId
    try {
      await this.editWithFallback(messageId, text)
      this.lastSentLen = text.length
      this.lastSentAt = Date.now()
    } catch (err) {
      this.log.debug("streaming preview flush failed:", err)
    }
  }

  async finish(finalText: string): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
    if (!this.messageId) return
    if (this.destroyed) return
    this.destroyed = true

    this.buffer = finalText
    const messageId = this.messageId
    try {
      await this.editWithFallback(messageId, finalText)
      this.lastSentLen = finalText.length
      this.lastSentAt = Date.now()
    } catch (err) {
      this.log.debug("streaming preview finish failed:", err)
    }
    this.store.deleteSentMessage(this.key)
  }

  private async editWithFallback(messageId: number, text: string): Promise<void> {
    const formatted = formatTelegramText(text)
    try {
      await this.bot.api.editMessageText(this.chatId, messageId, formatted, {
        parse_mode: "Markdown",
      })
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("can't parse entities")) throw err
    }
    await this.bot.api.editMessageText(this.chatId, messageId, formatted)
  }
}