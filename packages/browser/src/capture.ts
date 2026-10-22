import { Browser } from "./rpc"

/**
 * Per-tab console/network/dialog capture over a raw CDP session.
 *
 * The Playwright driver fills the same shapes from Playwright page events;
 * this module fills them from CDP domain events so a desktop webview tab
 * (which only has a CDP channel) produces byte-identical tool output.
 * Entry bounds and drop accounting mirror session.ts exactly.
 */

export const MAX_LOG_ENTRIES = 500

/** The slice of a CDP session the capture wiring needs (Playwright or Electron debugger). */
export interface CaptureSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(method: string, listener: (params: Record<string, unknown>) => void): void
}

export interface NetworkRecord {
  readonly request: Browser.NetworkRequest
  readonly requestHeaders: ReadonlyArray<{ name: string; value: string }>
  readonly responseHeaders: ReadonlyArray<{ name: string; value: string }>
  readonly requestBody: Browser.Body
  readonly responseBody: Browser.Body
  readonly postData?: string
}

export interface TabCapture {
  console: Browser.ConsoleEntry[]
  consoleDropped: number
  network: NetworkRecord[]
  networkDropped: number
  dialog: { type: string; message: string; defaultValue: string } | undefined
  dialogPending: boolean
}

export function createCapture(): TabCapture {
  return { console: [], consoleDropped: 0, network: [], networkDropped: 0, dialog: undefined, dialogPending: false }
}

export function severityRankOf(level: string): number {
  return level === "error" ? 3 : level === "warning" ? 2 : level === "info" ? 1 : 0
}

export function bodyOf(text: string | undefined, maxChars: number, include: boolean): Browser.Body {
  if (!include) return { state: "notRequested" }
  if (text === undefined) return { state: "empty" }
  return text.length > maxChars ? { state: "text", text: text.slice(0, maxChars), truncated: true } : { state: "text", text, truncated: false }
}

function pushBounded<T>(list: T[], item: T, max: number, onDrop: () => void): void {
  list.push(item)
  if (list.length > max) {
    list.splice(0, list.length - max)
    onDrop()
  }
}

function truncateText(value: string): { text: string; textTruncated: boolean } {
  return { text: value.slice(0, Browser.MAX_TEXT), textTruncated: value.length > Browser.MAX_TEXT }
}

function formatRemoteArg(arg: Record<string, unknown>): string {
  if ("value" in arg) {
    const value = arg.value
    if (typeof value === "string") return value
    if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return String(value)
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  }
  if (typeof arg.description === "string") return arg.description
  return String(arg.type ?? "undefined")
}

/**
 * Attach console/network/dialog listeners to a tab's CDP session and enable
 * the domains. Idempotent per capture state: callers invoke this once when a
 * tab is created (or lazily before its first captured action).
 */
export async function wireCapture(session: CaptureSession, capture: TabCapture): Promise<void> {
  session.on("Runtime.consoleAPICalled", (params) => {
    const rawType = String(params.type ?? "log")
    const level = (
      (["debug", "info", "warning", "error"] as const).includes(rawType as never)
        ? rawType
        : rawType === "assert"
          ? "error"
          : "info"
    ) as Browser.ConsoleEntry["level"]
    const args = (params.args as Array<Record<string, unknown>> | undefined) ?? []
    const { text, textTruncated } = truncateText(args.map(formatRemoteArg).join(" "))
    const frames = (params.stackTrace as { callFrames?: Array<Record<string, unknown>> } | undefined)?.callFrames
    const frame = frames?.[0]
    const entry: Browser.ConsoleEntry = {
      id: `console_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      timestampMs: Date.now(),
      level,
      text,
      textTruncated,
      source:
        frame && frame.url
          ? {
              url: String(frame.url).slice(0, Browser.MAX_TEXT),
              line: typeof frame.lineNumber === "number" ? frame.lineNumber : 0,
              column: typeof frame.columnNumber === "number" ? frame.columnNumber : 0,
            }
          : undefined,
    }
    pushBounded(capture.console, entry, MAX_LOG_ENTRIES, () => (capture.consoleDropped += 1))
  })
  session.on("Runtime.exceptionThrown", (params) => {
    const details = (params.exceptionDetails ?? {}) as Record<string, unknown>
    const exception = (details.exception ?? {}) as Record<string, unknown>
    const text = typeof exception.description === "string" ? exception.description : String(details.text ?? "Uncaught exception")
    pushBounded(
      capture.console,
      {
        id: `pageerror_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        timestampMs: Date.now(),
        level: "error",
        text: text.slice(0, Browser.MAX_TEXT),
        textTruncated: false,
        source: undefined,
      },
      MAX_LOG_ENTRIES,
      () => (capture.consoleDropped += 1),
    )
  })

  interface MutableRecord {
    request: Browser.NetworkRequest
    requestHeaders: Array<{ name: string; value: string }>
    responseHeaders: Array<{ name: string; value: string }>
    requestBody: Browser.Body
    responseBody: Browser.Body
    postData?: string
    startTime: number
  }
  const pending = new Map<string, MutableRecord>()
  session.on("Network.requestWillBeSent", (params) => {
    const request = (params.request ?? {}) as Record<string, unknown>
    const record: MutableRecord = {
      request: {
        id: String(params.requestId ?? ""),
        url: String(request.url ?? "").slice(0, Browser.MAX_TEXT),
        method: String(request.method ?? "").slice(0, 2048),
        resourceType: toResourceType(params.type),
        timestampMs: Date.now(),
        statusCode: undefined,
        state: "pending",
      } as Browser.NetworkRequest,
      requestHeaders: toHeaders(request.headers),
      responseHeaders: [],
      requestBody: { state: "notRequested" },
      responseBody: { state: "notRequested" },
      postData: typeof request.postData === "string" ? request.postData.slice(0, 20_000) : undefined,
      startTime: Date.now(),
    }
    pending.set(String(params.requestId), record)
  })
  session.on("Network.responseReceived", (params) => {
    const record = pending.get(String(params.requestId))
    if (!record) return
    const response = (params.response ?? {}) as Record<string, unknown>
    record.responseHeaders = toHeaders(response.headers)
    record.request = {
      ...record.request,
      statusCode: typeof response.status === "number" ? response.status : undefined,
    }
  })
  const finish = (requestId: string, failed: boolean, failure: string | undefined) => {
    const record = pending.get(requestId)
    if (!record) return
    pending.delete(requestId)
    const durationMs = Date.now() - record.startTime
    record.request = failed
      ? { ...record.request, state: "failed", durationMs, failure: (failure ?? "unknown").slice(0, 2048) }
      : { ...record.request, state: "completed", durationMs }
    pushBounded(capture.network, record, MAX_LOG_ENTRIES, () => (capture.networkDropped += 1))
  }
  session.on("Network.loadingFinished", (params) => finish(String(params.requestId), false, undefined))
  session.on("Network.loadingFailed", (params) => finish(String(params.requestId), true, String(params.errorText ?? "failed")))

  session.on("Page.javascriptDialogOpening", (params) => {
    capture.dialog = {
      type: String(params.type ?? "alert"),
      message: String(params.message ?? "").slice(0, Browser.MAX_TEXT),
      defaultValue: String(params.defaultPromptValue ?? ""),
    }
    capture.dialogPending = true
  })
  session.on("Page.javascriptDialogClosed", () => {
    capture.dialogPending = false
    capture.dialog = undefined
  })

  await session.send("Runtime.enable").catch(() => {})
  await session.send("Network.enable").catch(() => {})
  await session.send("Page.enable").catch(() => {})
}

function toResourceType(type: unknown): Browser.ResourceType {
  const known = [
    "document",
    "stylesheet",
    "image",
    "media",
    "font",
    "script",
    "xhr",
    "fetch",
    "eventsource",
    "websocket",
    "manifest",
    "other",
  ]
  const value = String(type)
  return (known.includes(value.toLowerCase()) ? value.toLowerCase() : "other") as Browser.ResourceType
}

function toHeaders(headers: unknown): Array<{ name: string; value: string }> {
  if (!headers || typeof headers !== "object") return []
  return Object.entries(headers as Record<string, unknown>)
    .slice(0, 200)
    .map(([name, value]) => ({ name: name.slice(0, 2048), value: String(value).slice(0, Browser.MAX_TEXT) }))
}

/** Fetch a finished response body for network.get; mirrors the Playwright driver's fallback. */
export async function responseBodyOf(
  session: CaptureSession,
  record: NetworkRecord,
  includeBody: boolean,
  maxChars: number,
): Promise<Browser.Body> {
  if (!includeBody) return { state: "notRequested" }
  if (record.request.state !== "completed") return { state: "notRequested" }
  try {
    const body = (await session.send("Network.getResponseBody", { requestId: record.request.id })) as {
      body: string
      base64Encoded: boolean
    }
    const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf-8") : body.body
    return bodyOf(text, maxChars, true)
  } catch {
    return { state: "unavailable", reason: "notCaptured" }
  }
}

export * as BrowserCapture from "./capture"
