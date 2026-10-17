import type { Bot } from "grammy"
import type { OpencodeClient } from "@novacode-ai/sdk/v2"
import type { Config } from "./config"
import type { Store } from "./store"
import type { SessionMap } from "./session"
import type { AuthPolicy, ChatContext } from "./auth"
import type { Logger } from "./logging"
import path from "node:path"

export interface CommandContext {
  config: Config
  store: Store
  sessionMap: SessionMap
  auth: AuthPolicy
  novacode: OpencodeClient
  opencode: OpencodeClient
  log: Logger
  botUsername: string
}

interface NativeCommand {
  command: string
  description: string
}

const NATIVE_COMMANDS: NativeCommand[] = [
  { command: "start", description: "Greet the bot and start a session" },
  { command: "help", description: "Show available commands" },
  { command: "status", description: "Show bot status and session stats" },
  { command: "whoami", description: "Show your user id, chat id, and active agent/model" },
  { command: "new", description: "Clear the current session for this chat" },
  { command: "stop", description: "Stop the current session task" },
  { command: "dir", description: "Show or set working directory for this chat (e.g. /dir /path/to/project)" },
  { command: "model", description: "Set model for this chat (e.g. /model anthropic/claude-sonnet-4-5)" },
  { command: "agent", description: "Set agent for this chat (e.g. /agent build)" },
  { command: "activation", description: "Re-check pairing (DM only)" },
  { command: "pair", description: "Approve a pairing code" },
  { command: "context", description: "Show session id and share URL" },
]

const KNOWN_AGENTS = new Set(["build", "plan"])

export async function setMyCommands(bot: Bot, config: Config): Promise<void> {
  const commands: NativeCommand[] = [...NATIVE_COMMANDS]
  for (const [name, description] of Object.entries(config.customCommands ?? {})) {
    if (commands.find((c) => c.command === name)) continue
    commands.push({ command: name, description })
  }
  await bot.api.setMyCommands(commands.map((c) => ({ command: c.command, description: c.description })))
}

function describeChat(threadId?: number, hasTopics?: boolean): ChatContext {
  return {
    isDm: false,
    threadId,
    hasTopicsEnabled: hasTopics,
  }
}

function isDmChat(chatType: string | undefined): boolean {
  return chatType === "private"
}

export function registerCommands(bot: Bot, ctx: CommandContext): void {
  const helpText = () => {
    const lines = NATIVE_COMMANDS.map((c) => `/${c.command} — ${c.description}`)
    const custom = Object.entries(ctx.config.customCommands ?? {})
    if (custom.length) {
      lines.push("", "Custom commands:")
      for (const [name, description] of custom) lines.push(`/${name} — ${description}`)
    }
    return lines.join("\n")
  }

  bot.command("start", async (c) => {
    await c.reply("👋 Hi! I'm a novacode bot. Send me a message and I'll start a session for this chat.")
  })

  bot.command("help", async (c) => {
    await c.reply(helpText())
  })

  bot.command("status", async (c) => {
    const audit = ctx.store.getAudit()
    const uptimeSec = Math.round(ctx.auth.uptimeMs() / 1000)
    const lines = [
      `Bot uptime: ${uptimeSec}s`,
      `Transport: ${ctx.config.transport}`,
      `Sessions: ${ctx.sessionMap.count()}`,
      `Paired users: ${ctx.store.pairedCount()}`,
      `Last audit: ${new Date(audit.lastConfigLoad).toISOString()}`,
    ]
    if (audit.lastError) lines.push(`Last error: ${audit.lastError}`)
    await c.reply(lines.join("\n"))
  })

  bot.command("whoami", async (c) => {
    const chatId = c.chat?.id
    const threadId = c.message?.message_thread_id
    const fromId = c.from?.id
    const sess = chatId !== undefined ? ctx.sessionMap.get(chatId, threadId, describeChat(threadId)) : undefined
    const lines = [
      `user id: ${fromId ?? "unknown"}`,
      `chat id: ${chatId ?? "unknown"}`,
      `thread id: ${threadId ?? "(none)"}`,
      `agent: ${sess?.agent ?? "(default)"}`,
      `model: ${sess?.model ?? "(default)"}`,
    ]
    await c.reply(lines.join("\n"))
  })

  bot.command("new", async (c) => {
    const chatId = c.chat?.id
    if (chatId === undefined) return
    const threadId = c.message?.message_thread_id
    const chatCtx = describeChat(threadId)
    const had = ctx.sessionMap.delete(chatId, threadId, chatCtx)
    await c.reply(had ? "Session cleared." : "No active session.")
  })

  bot.command("stop", async (c) => {
    const chatId = c.chat?.id
    if (chatId === undefined) return
    const threadId = c.message?.message_thread_id
    const chatCtx = describeChat(threadId)
    const sess = ctx.sessionMap.get(chatId, threadId, chatCtx)
    if (!sess?.sessionId) {
      await c.reply("No active session to stop.")
      return
    }
    await (ctx.novacode.session as any).interrupt({ sessionID: sess.sessionId }).catch((err: unknown) => {
      ctx.log.debug("stop interrupt failed:", err)
    })
    await c.reply("Task stopped.")
  })

  bot.command("dir", async (c) => {
    const chatId = c.chat?.id
    if (chatId === undefined) return
    const text = c.message?.text ?? ""
    const arg = text.replace(/^\/dir(?:@\w+)?\s*/, "").trim()
    const threadId = c.message?.message_thread_id
    const chatCtx = describeChat(threadId)

    if (!arg) {
      const currentDir = ctx.sessionMap.getDirectory(chatId, threadId, chatCtx) ?? ctx.config.projectDir
      await c.reply(`Current working directory: ${currentDir}\nUsage: /dir <path>`)
      return
    }

    const resolved = path.resolve(ctx.config.projectDir, arg)
    ctx.sessionMap.setDirectory(chatId, threadId, resolved, chatCtx)
    await c.reply(`Working directory set to: ${resolved}`)
  })

  bot.command("model", async (c) => {
    const chatId = c.chat?.id
    if (chatId === undefined) return
    const text = c.message?.text ?? ""
    const arg = text.replace(/^\/model(?:@\w+)?\s*/, "").trim()
    const threadId = c.message?.message_thread_id
    const chatCtx = describeChat(threadId)
    if (!arg) {
      const currentModel = ctx.sessionMap.get(chatId, threadId, chatCtx)?.model ?? ctx.sessionMap.resolveModel(chatId, threadId, chatCtx) ?? "(default)"
      const res = await ctx.novacode.config.providers().catch(() => undefined)
      const providers = res?.data?.providers ?? []

      const lines = [
        `Current model: ${currentModel}`,
        "",
        "Available models to change to (usage: /model <provider/model>):",
      ]

      for (const p of providers) {
        const models = Object.keys(p.models ?? {})
        if (models.length === 0) continue
        lines.push(`• ${p.id} (${p.name}):`)
        for (const m of models.slice(0, 5)) {
          lines.push(`  /model ${p.id}/${m}`)
        }
        if (models.length > 5) {
          lines.push(`  ... and ${models.length - 5} more`)
        }
      }

      if (providers.length === 0) {
        lines.push("No providers found. Usage: /model <provider/model>")
      }

      await c.reply(lines.join("\n"))
      return
    }
    ctx.sessionMap.setModel(chatId, threadId, arg, chatCtx)
    await c.reply(`Model set to ${arg}`)
  })

  bot.command("agent", async (c) => {
    const chatId = c.chat?.id
    if (chatId === undefined) return
    const text = c.message?.text ?? ""
    const arg = text.replace(/^\/agent(?:@\w+)?\s*/, "").trim()
    if (!arg) {
      const known = Array.from(KNOWN_AGENTS).join(", ")
      await c.reply(`Usage: /agent <name> (known: ${known})`)
      return
    }
    ctx.sessionMap.setAgent(chatId, c.message?.message_thread_id, arg, describeChat(c.message?.message_thread_id))
    await c.reply(`Agent set to ${arg}`)
  })

  bot.command("activation", async (c) => {
    if (!isDmChat(c.chat?.type)) {
      await c.reply("This command is only available in direct messages.")
      return
    }
    const fromId = c.from?.id
    if (!fromId) return
    const paired = ctx.store.isPaired(fromId)
    await c.reply(paired ? "You are paired." : "You are not paired. Send a message to receive a pairing code.")
  })

  bot.command("pair", async (c) => {
    const text = c.message?.text ?? ""
    const code = text.replace(/^\/pair(?:@\w+)?\s*/, "").trim()
    if (!code) {
      await c.reply("Usage: /pair <code>")
      return
    }
    const fromId = c.from?.id
    if (!fromId) return
    const ok = ctx.auth.pair(fromId, code)
    await c.reply(ok ? "Paired! You can now chat." : "Invalid or expired code.")
  })

  bot.command("context", async (c) => {
    const chatId = c.chat?.id
    if (chatId === undefined) return
    const threadId = c.message?.message_thread_id
    const sess = ctx.sessionMap.get(chatId, threadId, describeChat(threadId))
    if (!sess?.sessionId) {
      await c.reply("No active session. Send a message first.")
      return
    }
    const share = await (ctx.novacode ?? ctx.novacode!).session.share({ sessionID: sess.sessionId }).catch(() => undefined)
    const url = share?.data?.share?.url
    const lines = [`session: ${sess.sessionId}`]
    if (url) lines.push(url)
    await c.reply(lines.join("\n"))
  })
}