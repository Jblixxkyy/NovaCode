import type { Bot } from "grammy"
import type { OpencodeClient, ToolPart } from "@novacode-ai/sdk/v2"
import type { Logger } from "./logging"
import type { Store } from "./store"

export function startToolUpdates(bot: Bot, client: OpencodeClient, store: Store, log: Logger): () => void {
  let stopped = false

  void (async () => {
    try {
      const events = await client.event.subscribe()
      for await (const event of events.stream) {
        if (stopped) break
        if (event.type !== "message.part.updated") continue
        const part = (event as { properties: { part: ToolPart } }).properties.part
        if (part.type !== "tool") continue
        if (part.state.status !== "completed") continue

        let target: { chatId: number; thread: number | undefined } | undefined
        for (const [key, sess] of store.sessionEntries()) {
          if (sess.sessionId !== part.sessionID) continue
          const [chatPart, topicPart] = key.split(":topic:")
          target = {
            chatId: Number(chatPart),
            thread: topicPart ? Number(topicPart) : undefined,
          }
          break
        }
        if (!target) continue

        const sent = await bot.api
          .sendMessage(target.chatId, `*${part.tool}* — ${part.state.title}`, {
            message_thread_id: target.thread && target.thread !== 1 ? target.thread : undefined,
            parse_mode: "Markdown",
          })
          .catch((err: unknown) => log.debug("tool update send failed:", err))

        if (sent && typeof sent === "object" && "message_id" in sent) {
          setTimeout(() => {
            bot.api.deleteMessage(target.chatId, (sent as { message_id: number }).message_id).catch(() => {})
          }, 2000)
        }
      }
    } catch (err) {
      if (!stopped) log.error("tool update subscriber error:", err)
    }
  })()

  return () => {
    stopped = true
  }
}