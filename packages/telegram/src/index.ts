import { createOpencode as createNovacode } from "@novacode-ai/sdk/v2"
import { loadConfig } from "./config"
import { createLogger } from "./logging"
import { Store } from "./store"
import { SessionMap } from "./session"
import { AuthPolicy } from "./auth"
import { registerCommands, setMyCommands } from "./commands"
import { createBot } from "./runtime"
import { startMonitor } from "./monitor"
import { startToolUpdates } from "./tool-updates"
import { AlbumBuffer, MediaHandler } from "./media"
import { sendAgentAttachments } from "./outbound-media"
import type { MediaInput } from "./media"
import { StreamingPreview } from "./streaming"
import { Reactions } from "./react"
import { CallbackRouter } from "./callback"
import { Approvals } from "./approvals"
import type { OpencodeClient as NovacodeClient } from "@novacode-ai/sdk/v2"
import type { TextPart, FilePart, ToolStateCompleted } from "@novacode-ai/sdk/v2"
import type { Logger } from "./logging"

const config = await loadConfig()
const log = createLogger(config.logLevel)
const store = new Store(config)
await store.load()
const sessionMap = new SessionMap(store, config)
const auth = new AuthPolicy(config, store, log)

log.info("starting novacode server")
const novacode = await createNovacode({ port: 0, timeout: 15000 })
log.info("novacode server ready at", novacode.server.url)

const bot = createBot(config.token!, { throttler: true })
const me = await bot.api.getMe()
const botUsername = me.username
log.info("bot identity:", me.first_name, "@" + botUsername)

const mediaHandler = new MediaHandler(bot, log)
const albumBuffer = new AlbumBuffer({
  windowMs: 800,
  onFlush: (groupId, media) => {
    const origin = albumOrigins.get(groupId)
    if (!origin) {
      log.debug("album flushed with no origin", groupId)
      return
    }
    albumOrigins.delete(groupId)
    void (async () => {
      const decision = await auth.authorize(
        {
          chatId: origin.chatId,
          chatType: origin.chatType,
          fromId: origin.fromId,
          text: origin.caption,
          isTopicMessage: origin.isTopicMessage,
          threadId: origin.threadId,
          replyToBotMessage: origin.replyToBotMessage,
        },
        botUsername,
      )
      if (!decision.ok) {
        if (decision.reason.startsWith("pairing-required:")) {
          const code = decision.reason.split(":")[1]
          await bot.api.sendMessage(origin.chatId, `Pairing required. Your code: ${code}\nUse /pair ${code} to approve.`, {
            message_thread_id: origin.threadId && origin.threadId !== 1 ? origin.threadId : undefined,
          })
          return
        }
        log.debug("auth denied for album:", decision.reason, "chat", origin.chatId)
        return
      }
      await handleUserTurn({
        chatId: origin.chatId,
        threadId: origin.threadId,
        messageId: 0,
        chatCtx: {
          isDm: origin.chatType === "private",
          threadId: origin.threadId,
          hasTopicsEnabled: origin.isTopicMessage,
        },
        text: origin.caption,
        media,
      })
    })()
  },
})

const commandCtx = {
  config,
  store,
  sessionMap,
  auth,
  novacode: novacode.client,
  opencode: novacode.client,
  log,
  botUsername,
}

await setMyCommands(bot, config)
registerCommands(bot, commandCtx)

const reactions = new Reactions(bot, log, config, store)
reactions.listen()

const callbackRouter = new CallbackRouter(bot, log)
const approvals = new Approvals(bot, novacode.client, store, log, config)
callbackRouter.mount()
const stopApprovals = approvals.start(callbackRouter)

type AuthInput = Parameters<typeof auth.authorize>[0]

bot.on("message", async (ctx) => {
  const msg = ctx.message
  if (!msg) return
  if (msg.text?.startsWith("/")) return

  const media = MediaHandler.fromMessage(msg)
  const groupId = (msg as { media_group_id?: string }).media_group_id

  if (groupId && media.length === 0) return

  const chatId = msg.chat.id
  const isDm = msg.chat.type === "private"
  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined
  const replyToBotMessage = !!msg.reply_to_message?.from && msg.reply_to_message.from.id === me.id
  const caption = "caption" in msg && typeof msg.caption === "string" ? msg.caption : ""
  const text = msg.text ?? caption

  if (groupId) {
    recordAlbumOrigin(groupId, msg)
    albumBuffer.push(msg)
    return
  }

  if (media.length === 0 && !text) return

  const authInput: AuthInput = {
    chatId,
    chatType: msg.chat.type,
    fromId: ctx.from?.id,
    text,
    isTopicMessage: !!msg.is_topic_message,
    threadId,
    replyToBotMessage,
  }

  const decision = await auth.authorize(authInput, botUsername)
  if (!decision.ok) {
    if (decision.reason.startsWith("pairing-required:")) {
      const code = decision.reason.split(":")[1]
      await ctx.reply(`Pairing required. Your code: ${code}\nUse /pair ${code} to approve.`)
      return
    }
    log.debug("auth denied:", decision.reason, "chat", chatId)
    return
  }

  await handleUserTurn({
    chatId,
    threadId,
    messageId: msg.message_id,
    chatCtx: { isDm, threadId, hasTopicsEnabled: !!msg.is_topic_message },
    text,
    media,
  })
})

interface AlbumSample {
  chatId: number
  chatType: string
  fromId?: number
  caption: string
  isTopicMessage: boolean
  threadId?: number
  replyToBotMessage: boolean
}

const albumOrigins = new Map<string, AlbumSample>()

function recordAlbumOrigin(groupId: string, msg: any): void {
  const caption = "caption" in msg && typeof msg.caption === "string" ? msg.caption : ""
  const sample: AlbumSample = {
    chatId: msg.chat.id,
    chatType: msg.chat.type,
    fromId: msg.from?.id,
    caption,
    isTopicMessage: !!msg.is_topic_message,
    threadId: msg.is_topic_message ? msg.message_thread_id : undefined,
    replyToBotMessage: !!msg.reply_to_message?.from && msg.reply_to_message.from.id === me.id,
  }
  albumOrigins.set(groupId, sample)
  setTimeout(() => albumOrigins.delete(groupId), 5000)
}

interface TurnInput {
  chatId: number
  threadId: number | undefined
  messageId: number
  chatCtx: { isDm: boolean; threadId?: number; hasTopicsEnabled?: boolean }
  text: string
  media: MediaInput[]
}

async function handleUserTurn(input: TurnInput): Promise<void> {
  const { chatId, threadId, messageId, chatCtx, text, media } = input
  void reactions.set(chatId, messageId, config.reactions.ackEmoji)
  const sessionKey = sessionMap.key(chatId, threadId, chatCtx)
  let session = sessionMap.get(chatId, threadId, chatCtx)

  if (!session || !session.sessionId) {
    log.info("creating novacode session for", sessionKey)
    const createResult = await novacode.client.session.create({
      title: `Telegram chat ${chatId}${threadId && threadId !== 1 ? ` topic ${threadId}` : ""}`,
    })
    if (createResult.error || !createResult.data) {
      log.error("failed to create session:", createResult.error)
      await bot.api.sendMessage(chatId, "Sorry, I had trouble creating a session. Please try again.", {
        message_thread_id: threadId && threadId !== 1 ? threadId : undefined,
      })
      void reactions.set(chatId, messageId, config.reactions.doneEmoji)
      return
    }

    session = { sessionId: createResult.data.id, createdAt: Date.now() }
    sessionMap.set(chatId, threadId, session, chatCtx)

    const shareResult = await novacode.client.session
      .share({ sessionID: createResult.data.id })
      .catch((err: unknown) => {
        log.debug("share failed:", err)
        return undefined
      })
    const url = shareResult?.data?.share?.url
    if (url) {
      await bot.api.sendMessage(chatId, url, {
        message_thread_id: threadId && threadId !== 1 ? threadId : undefined,
      })
    }
  }

  const downloaded = await downloadMedia(media)

  const parts: Array<
    { type: "text"; text: string } | { type: "file"; mime: string; filename?: string; url: string }
  > = []
  const promptText = text || (media.length ? "(user sent media)" : "")
  if (promptText) parts.push({ type: "text", text: promptText })
  for (let i = 0; i < downloaded.length; i++) {
    const d = downloaded[i]
    if (!d) continue
    const m = media[i]
    parts.push({
      type: "file",
      mime: m.mime ?? guessMime(d),
      filename: m.filename ?? d.split("/").pop(),
      url: `file://${d}`,
    })
  }

  const promptBody: {
    parts: typeof parts
    agent?: string
    model?: { providerID: string; modelID: string }
  } = { parts }
  const resolvedAgent = sessionMap.resolveAgent(chatId, threadId, chatCtx)
  if (resolvedAgent) promptBody.agent = resolvedAgent
  const modelId = sessionMap.resolveModel(chatId, threadId, chatCtx)
  if (modelId) {
    const [providerID, ...rest] = modelId.split("/")
    promptBody.model = { providerID: providerID!, modelID: rest.join("/") }
  }

  const sessionDir = sessionMap.getDirectory(chatId, threadId, chatCtx) ?? config.projectDir
  log.debug("prompting session", session.sessionId, "with", parts.length, "parts in dir", sessionDir)
  const accept = await novacode.client.session
    .promptAsync(
      {
        sessionID: session.sessionId,
        parts,
        ...(promptBody.agent ? { agent: promptBody.agent } : {}),
        ...(promptBody.model ? { model: promptBody.model } : {}),
      },
      sessionDir ? { headers: { "x-opencode-directory": encodeURIComponent(sessionDir) } } : undefined,
    )
    .catch((err: unknown) => {
      log.error("prompt error:", err)
      return { error: err }
    })

  if (!accept || (accept as { error?: unknown }).error) {
    await bot.api.sendMessage(chatId, "Sorry, I had trouble processing your message. Please try again.", {
      message_thread_id: threadId && threadId !== 1 ? threadId : undefined,
    })
    void reactions.set(chatId, messageId, config.reactions.doneEmoji)
    return
  }

  const preview = new StreamingPreview(bot, config, log, store, chatId, threadId)
  await preview.start()

  const collected = await collectTurn(novacode.client, session.sessionId, preview, log)

  const responseText = collected.text || "I received your message but didn't have a response."
  await preview.finish(responseText)
  void reactions.set(chatId, messageId, config.reactions.doneEmoji)

  if (collected.attachments.length) {
    await sendAgentAttachments(bot, chatId, threadId, collected.attachments, log)
  }
}

async function downloadMedia(media: MediaInput[]): Promise<Array<string | null>> {
  return Promise.all(
    media.map(async (m) => {
      try {
        return await mediaHandler.download(m.fileId, m.mime, m.filename)
      } catch (err) {
        log.warn("media download failed:", err)
        return null
      }
    }),
  )
}

function guessMime(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".ogg")) return "audio/ogg"
  if (lower.endsWith(".mp3")) return "audio/mpeg"
  if (lower.endsWith(".mp4")) return "video/mp4"
  if (lower.endsWith(".webm")) return "video/webm"
  return "application/octet-stream"
}

interface CollectedTurn {
  text: string
  attachments: Array<{ url: string; mime: string; filename?: string }>
}

async function collectTurn(
  client: NovacodeClient,
  sessionID: string,
  preview: StreamingPreview,
  log: Logger,
): Promise<CollectedTurn> {
  const textByPart = new Map<string, { text: string; msgId: string }>()
  const finalTextByMessage = new Map<string, string>()
  const attachments: CollectedTurn["attachments"] = []

  try {
    const events = await client.event.subscribe()
    for await (const event of events.stream) {
      const t = event.type
      if (t === "session.idle" && event.properties.sessionID === sessionID) break
      if (t !== "message.part.updated") continue
      const props = event.properties
      if (props.sessionID !== sessionID) continue
      const part = props.part
      if (part.type === "reasoning") continue
      if (part.type === "text") {
        const tp = part as TextPart
        const prev = textByPart.get(tp.id)
        const prevText = prev?.text ?? ""
        const delta = tp.text.startsWith(prevText) ? tp.text.slice(prevText.length) : tp.text
        textByPart.set(tp.id, { text: tp.text, msgId: tp.messageID })
        if (delta) preview.append(delta)
        if (tp.ignored || tp.synthetic) continue
        finalTextByMessage.set(tp.messageID, tp.text)
      } else if (part.type === "file") {
        const fp = part as FilePart
        attachments.push({ url: fp.url, mime: fp.mime, filename: fp.filename })
      } else if (part.type === "tool") {
        const state = part.state
        if (state.status === "completed") {
          const completed = state as ToolStateCompleted
          for (const att of completed.attachments ?? []) {
            attachments.push({ url: att.url, mime: att.mime, filename: att.filename })
          }
        }
      }
    }
  } catch (err) {
    log.warn("event stream error:", err)
  }

  const text = Array.from(finalTextByMessage.values()).join("\n").trim()
  return { text, attachments }
}

const stopToolUpdates = startToolUpdates(bot, novacode.client, store, log)

bot.catch((err) => {
  log.error("bot error:", err)
  store.recordError(String(err?.message ?? err))
})

const shutdown = async () => {
  log.info("shutting down")
  stopApprovals()
  stopToolUpdates()
  await stopMonitor()
  try {
    novacode.server.close()
  } catch (err) {
    log.warn("server close error:", err)
  }
  await store.flush()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

const stopMonitor = await startMonitor(bot, config, log, store)
log.info("telegram bot is running")