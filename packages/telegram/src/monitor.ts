import { timingSafeEqual } from "node:crypto"
import { InputFile } from "grammy"
import type { Bot } from "grammy"
import type { Config } from "./config"
import type { Logger } from "./logging"
import type { Store } from "./store"

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

async function startWebhook(
  bot: Bot,
  config: Config,
  log: Logger,
  webhook: NonNullable<Config["webhook"]>,
): Promise<() => Promise<void>> {
  const path = webhook.path
  const startedAt = Date.now()

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    if (url.pathname === "/healthz") {
      return jsonResponse({
        status: "ok",
        transport: "webhook",
        uptime: Math.floor((Date.now() - startedAt) / 1000),
      })
    }

    if (url.pathname !== path) return new Response("Not Found", { status: 404 })

    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 })

    if (webhook.secret) {
      const header = req.headers.get("x-telegram-bot-api-secret-token")
      if (!header || !constantTimeEqual(header, webhook.secret)) {
        log.warn("webhook secret token mismatch")
        return new Response("Forbidden", { status: 403 })
      }
    }

    let update: unknown
    try {
      update = await req.json()
    } catch (err) {
      log.warn("webhook invalid json:", err)
      return new Response("Bad Request", { status: 400 })
    }

    try {
      await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0])
    } catch (err) {
      log.error("webhook handleUpdate error:", err)
    }
    return new Response("OK", { status: 200 })
  }

  const server = Bun.serve({
    port: webhook.port,
    hostname: webhook.host,
    fetch: handler,
  })
  log.info(`webhook server listening on http://${webhook.host}:${webhook.port}`)

  const webhookUrl = `${webhook.url}${path}`
  await bot.api.setWebhook(webhookUrl, {
    secret_token: webhook.secret,
    certificate: webhook.cert ? new InputFile(webhook.cert) : undefined,
  })
  log.info("telegram webhook registered at", webhookUrl)

  return async () => {
    try {
      await bot.api.deleteWebhook()
    } catch (err) {
      log.warn("deleteWebhook error:", err)
    }
    await server.stop()
    await bot.stop()
  }
}

function classifyError(err: unknown): "fatal" | "conflict" | "transient" | "unknown" {
  const msg = err instanceof Error ? err.message : String(err)
  const code = (err as { error_code?: number })?.error_code
  if (code === 401 || code === 404 || msg.includes("401") || msg.includes("404") || msg.includes("Unauthorized") || msg.includes("Not Found")) return "fatal"
  if (code === 409 || msg.includes("409") || msg.includes("Conflict") || msg.includes("terminated by other getUpdates")) return "conflict"
  if (code === 429 || code === 500 || code === 502 || code === 503 || msg.includes("429") || msg.includes("Too Many Requests")) return "transient"
  return "unknown"
}

function extractRetryAfter(err: unknown): number | undefined {
  const ra = (err as { parameters?: { retry_after?: number } })?.parameters?.retry_after
  if (typeof ra === "number" && Number.isFinite(ra) && ra >= 0) return ra
  return undefined
}

async function startPolling(bot: Bot, config: Config, log: Logger, store: Store): Promise<() => Promise<void>> {
  const token = config.token ?? (bot as { token?: string }).token ?? "default"
  const persisted = store.getOffset(token)
  if (persisted !== undefined) log.info("resuming from persisted offset", persisted)

  let lastUpdateAt = Date.now()
  let stopped = false
  let watchdog: ReturnType<typeof setInterval> | undefined
  let currentStop: (() => Promise<void>) | undefined

  bot.use(async (ctx, next) => {
    lastUpdateAt = Date.now()
    const updateId = (ctx.update as { update_id?: number })?.update_id
    if (typeof updateId === "number") store.setOffset(token, updateId)
    await next()
  })

  bot.catch((err) => {
    const kind = classifyError(err.error)
    if (kind === "fatal") {
      log.error("fatal polling error (bad token):", err.error)
      return
    }
    if (kind === "conflict") log.warn("polling conflict (409): another instance is polling this token")
    const ra = extractRetryAfter(err.error)
    if (ra !== undefined) log.warn(`polling rate limited, retry_after=${ra}s`)
  })

  const stallMs = config.polling.stallTimeoutMs
  const checkMs = Math.min(Math.max(stallMs / 4, 10_000), 30_000)

  let restartBackoff = config.polling.initialBackoffMs

  watchdog = setInterval(() => {
    if (stopped) return
    const idle = Date.now() - lastUpdateAt
    if (idle > stallMs) {
      log.warn(`polling stall detected (idle ${Math.round(idle / 1000)}s), restarting with ${restartBackoff}ms backoff`)
      lastUpdateAt = Date.now()
      void (async () => {
        try {
          await bot.stop()
        } catch {}
        if (stopped) return
        await new Promise((r) => setTimeout(r, restartBackoff))
        if (stopped) return
        try {
          await bot.start()
          restartBackoff = config.polling.initialBackoffMs
        } catch (err) {
          const kind = classifyError(err)
          if (kind === "conflict") {
            restartBackoff = Math.min(restartBackoff * 2, config.polling.maxBackoffMs)
            log.warn(`polling restart conflict, backing off to ${restartBackoff}ms`)
            return
          }
          log.error("polling restart failed:", err)
          restartBackoff = Math.min(restartBackoff * 2, config.polling.maxBackoffMs)
        }
      })()
    }
  }, checkMs)

  log.info("starting telegram bot via long polling")
  void bot.start().catch((err: unknown) => {
    const kind = classifyError(err)
    if (kind === "fatal") log.error("fatal polling error on start:", err)
    else if (kind === "conflict") log.warn("polling conflict on start:", err)
    else log.warn("polling start error (will retry via watchdog):", err)
  })

  return async () => {
    stopped = true
    if (watchdog) clearInterval(watchdog)
    try {
      await bot.stop()
    } catch {}
  }
}

export async function startMonitor(bot: Bot, config: Config, log: Logger, store?: Store): Promise<() => Promise<void>> {
  if (config.transport === "polling") {
    if (store) return startPolling(bot, config, log, store)
    log.info("starting telegram bot via long polling")
    void bot.start().catch((err: unknown) => log.warn("polling start error:", err))
    return async () => {
      await bot.stop()
    }
  }

  if (!config.webhook) {
    throw new Error("transport is 'webhook' but config.webhook is not defined")
  }
  return startWebhook(bot, config, log, config.webhook)
}