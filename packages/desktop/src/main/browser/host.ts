import type { BrowserDesktop } from "@novacode-ai/browser/desktop"
import { DesktopUnsupportedError, executeDesktopAction, stateOf } from "./executor"
import type { BrowserTabManager } from "./tabs"

/**
 * The desktop side of the browser tunnel (plans/desktop-webview-plan.md):
 * attach to the local sidecar, long-poll for commands, execute them
 * against the WebContentsView tabs, post results, and keep the server's
 * published inventory fresh. Modeled on permission-auto-responder.ts:
 * authenticated fetch, AbortController, 2s reconnect backoff, injectable
 * fetch/log for tests.
 */

const RECONNECT_DELAY_MS = 2_000
const PUBLISH_HEARTBEAT_MS = 10_000
/** Change bursts during a page load (start/stop/title/favicon) collapse into one publish. */
const PUBLISH_DEBOUNCE_MS = 150

type Logger = (message: string, meta?: Record<string, unknown>) => void

export interface BrowserHostClient {
  stop: () => Promise<void>
}

export function startBrowserHost(input: {
  url: string
  username?: string
  password?: string | null
  manager: BrowserTabManager
  fetch?: typeof globalThis.fetch
  log?: Logger
}): BrowserHostClient {
  const fetcher = input.fetch ?? globalThis.fetch
  const log = input.log ?? (() => undefined)
  const manager = input.manager
  const authorization = input.password
    ? `Basic ${Buffer.from(`${input.username ?? "novacode"}:${input.password}`).toString("base64")}`
    : undefined
  const headers: Record<string, string> = {
    ...(authorization ? { authorization } : {}),
    "content-type": "application/json",
  }
  const controller = new AbortController()
  let attachment: string | undefined
  let stopped = false

  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        controller.signal.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      controller.signal.addEventListener("abort", onAbort, { once: true })
    })

  const post = (path: string, body: unknown) =>
    fetcher(new URL(path, input.url), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

  const publish = async (scope: string) => {
    if (!attachment || stopped) return
    await post("/browser/desktop/state", {
      attachment,
      scope,
      state: stateOf(manager, scope),
      viewport: manager.viewportFor(scope),
    }).catch(() => undefined)
  }

  const publishAll = () => {
    for (const scope of manager.knownScopes()) void publish(scope)
  }

  // Tab events arrive in bursts (a single page load fires start/stop,
  // navigate, title and favicon changes); publishing each one immediately
  // spams the sidecar with the full tab inventory. Coalesce per scope so
  // a burst becomes one publish. The 10s heartbeat is the staleness
  // backstop, so a delayed publish can never leave the server stale.
  const publishTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const publishSoon = (scope: string) => {
    const existing = publishTimers.get(scope)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      publishTimers.delete(scope)
      void publish(scope)
    }, PUBLISH_DEBOUNCE_MS)
    timer.unref?.()
    publishTimers.set(scope, timer)
  }

  const unsubscribe = manager.onChange((scope) => {
    publishSoon(scope)
  })
  const unsubscribeInspect = manager.onInspectEvent((scope, event) => {
    if (!attachment || stopped) return
    void post("/browser/desktop/inspect", { attachment, scope, event }).catch(() => undefined)
  })
  const heartbeat = setInterval(publishAll, PUBLISH_HEARTBEAT_MS)
  heartbeat.unref()

  const execute = async (command: BrowserDesktop.DesktopCommand) => {
    let outcome: BrowserDesktop.DesktopOutcome
    try {
      const result = await executeDesktopAction(manager, command.scope, command.action)
      outcome = { type: "success", result }
    } catch (error) {
      outcome = {
        type: "failure",
        code: error instanceof DesktopUnsupportedError ? "unsupported" : "error",
        message: error instanceof Error ? error.message : String(error),
      }
    }
    if (!attachment) return
    await post("/browser/desktop/result", { attachment, requestID: command.requestID, outcome }).catch(
      () => undefined,
    )
  }

  const attach = async (): Promise<boolean> => {
    const response = await post("/browser/desktop/attach", { client: "novacode-desktop" }).catch(() => undefined)
    if (!response?.ok) return false
    const body = (await response.json().catch(() => undefined)) as
      | { attachment?: string; acl?: { allow: string[]; deny: string[] } }
      | undefined
    if (!body?.attachment) return false
    attachment = body.attachment
    // The server ships its effective domain ACL with the attachment; the
    // tab manager enforces it on every webview navigation from here on.
    if (body.acl) manager.setACL(body.acl)
    publishAll()
    return true
  }

  const run = (async () => {
    while (!stopped) {
      if (!attachment) {
        if (!(await attach())) {
          await delay(RECONNECT_DELAY_MS)
          continue
        }
      }
      const current = attachment
      if (!current) continue
      const response = await fetcher(
        new URL(`/browser/desktop/commands?attachment=${encodeURIComponent(current)}`, input.url),
        { headers, signal: controller.signal },
      ).catch(() => undefined)
      if (stopped) return
      if (!response?.ok) {
        // Server restarted or attachment forgotten: re-attach.
        if (attachment === current) attachment = undefined
        await delay(RECONNECT_DELAY_MS)
        continue
      }
      const polled = (await response.json().catch(() => undefined)) as BrowserDesktop.PollResult | undefined
      if (!polled) {
        await delay(RECONNECT_DELAY_MS)
        continue
      }
      if (polled.status === "detached") {
        if (attachment === current) attachment = undefined
        continue
      }
      // Run commands one at a time, like the Playwright driver: the next
      // poll only goes out once this command's result is posted, so two
      // commands can never run concurrently against the same tab. The
      // 10s state heartbeat keeps the attachment alive while a long
      // command runs, and the server queues the next command meanwhile.
      if (polled.status === "command") await execute(polled.command)
    }
  })()

  return {
    stop: async () => {
      stopped = true
      clearInterval(heartbeat)
      for (const timer of publishTimers.values()) clearTimeout(timer)
      publishTimers.clear()
      unsubscribe()
      unsubscribeInspect()
      const current = attachment
      attachment = undefined
      if (current) {
        await fetcher(new URL("/browser/desktop/detach", input.url), {
          method: "POST",
          headers,
          body: JSON.stringify({ attachment: current }),
        }).catch(() => undefined)
      }
      controller.abort()
      await run.catch(() => undefined)
    },
  }
}
