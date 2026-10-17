import type { Bot, Context } from "grammy"
import type { OpencodeClient } from "@novacode-ai/sdk/v2"
import type { Config } from "./config"
import type { Logger } from "./logging"
import type { Store } from "./store"
import type { CallbackRouter } from "./callback"

type ReplyKind = "once" | "always" | "reject"

const PREFIX = "perm:"

const LABEL = {
  once: { confirm: "Approved", text: "Approved", emoji: "✅" },
  always: { confirm: "Always allowed", text: "Always allowed", emoji: "✅" },
  reject: { confirm: "Denied", text: "Denied", emoji: "❌" },
} as const satisfies Record<ReplyKind, { confirm: string; text: string; emoji: string }>

export class Approvals {
  private readonly handled = new Set<string>()

  constructor(
    private readonly bot: Bot,
    private readonly client: OpencodeClient,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly config: Config,
  ) {}

  start(router: CallbackRouter): () => void {
    if (!this.config.approvals.enabled) {
      return () => {}
    }
    let stopped = false
    void this.subscribe(router, () => stopped)
    return () => {
      stopped = true
    }
  }

  private async subscribe(router: CallbackRouter, isStopped: () => boolean): Promise<void> {
    try {
      const events = await this.client.event.subscribe()
      for await (const event of events.stream) {
        if (isStopped()) break
        if (event.type !== "permission.asked") continue
        try {
          await this.handleAsked(event, router)
        } catch (err) {
          this.log.error("approval handler error:", err)
        }
      }
    } catch (err) {
      this.log.error("approval subscriber error:", err)
    }
  }

  private async handleAsked(
    event: {
      properties: { id: string; sessionID: string; permission: string; patterns: Array<string> }
    },
    router: CallbackRouter,
  ): Promise<void> {
    const props = event.properties
    const requestID = props.id
    if (this.handled.has(requestID)) return
    this.handled.add(requestID)

    const target = this.findChatForSession(props.sessionID)
    if (!target) {
      this.log.debug("no chat for session", props.sessionID, "permission request", requestID)
      return
    }

    const patterns = props.patterns.length ? props.patterns.join(", ") : "(any)"
    const text = `🔐 Permission needed\n\n*${props.permission}*\nPatterns: ${patterns}`

    const reply_markup = this.config.approvals.allowAlways
      ? {
          inline_keyboard: [
            [
              { text: "Allow", callback_data: `${PREFIX}${requestID}:once` },
              { text: "Always", callback_data: `${PREFIX}${requestID}:always` },
              { text: "Deny", callback_data: `${PREFIX}${requestID}:reject` },
            ],
          ],
        }
      : {
          inline_keyboard: [
            [
              { text: "Allow", callback_data: `${PREFIX}${requestID}:once` },
              { text: "Deny", callback_data: `${PREFIX}${requestID}:reject` },
            ],
          ],
        }

    const sent = await this.bot.api
      .sendMessage(target.chatId, text, {
        message_thread_id: target.threadId,
        parse_mode: "Markdown",
        reply_markup,
      })
      .catch((err: unknown) => {
        this.log.warn("failed to post approval prompt:", err)
        return undefined
      })
    if (!sent) return

    router.register(`${PREFIX}${requestID}:`, (data, ctx) => this.onTap(requestID, data, ctx))
  }

  private onTap = async (requestID: string, data: string, ctx: Context): Promise<void> => {
    const kind = data.slice(`${PREFIX}${requestID}:`.length) as ReplyKind
    if (kind !== "once" && kind !== "always" && kind !== "reject") return
    const meta = LABEL[kind]

    try {
      await this.client.permission.reply({ requestID, reply: kind })
    } catch (err) {
      this.log.warn("permission.reply failed:", err)
      await ctx.answerCallbackQuery("Reply failed").catch(() => {})
      const msgId = ctx.callbackQuery?.message?.message_id
      if (msgId !== undefined && ctx.chatId !== undefined) {
        await this.bot.api
          .editMessageText(ctx.chatId, msgId, "⚠️ Reply failed")
          .catch((e: unknown) => this.log.debug("edit on failure:", e))
      }
      return
    }

    await ctx.answerCallbackQuery(meta.confirm).catch((err: unknown) => this.log.debug("answerCallbackQuery failed:", err))

    const msgId = ctx.callbackQuery?.message?.message_id
    if (msgId !== undefined && ctx.chatId !== undefined) {
      await this.bot.api
        .editMessageText(ctx.chatId, msgId, `${meta.emoji} ${meta.text}`)
        .catch((e: unknown) => this.log.debug("edit after reply failed:", e))
    }
  }

  private findChatForSession(sessionID: string): { chatId: number; threadId: number | undefined } | undefined {
    for (const [key, sess] of this.store.sessionEntries()) {
      if (sess.sessionId !== sessionID) continue
      const sep = key.indexOf(":topic:")
      if (sep === -1) return { chatId: Number(key), threadId: undefined }
      const chatId = Number(key.slice(0, sep))
      const threadId = Number(key.slice(sep + ":topic:".length))
      return { chatId, threadId: threadId !== 1 ? threadId : undefined }
    }
    return undefined
  }
}