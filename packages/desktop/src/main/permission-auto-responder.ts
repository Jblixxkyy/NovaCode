import { isDirectoryAutoAccepting, sessionAutoAccept } from "@novacode-ai/app/context/permission-auto-respond"

const RECONNECT_DELAY_MS = 2_000
const LINEAGE_MAX_SESSIONS = 10

export type AutoAcceptMap = Record<string, boolean>
export type LineageSession = { id: string; parentID?: string }
export type PermissionAutoResponder = { stop: () => Promise<void> }

type Logger = (message: string, meta?: Record<string, unknown>) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJSON(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

export function parseAutoAccept(value: unknown): AutoAcceptMap | undefined {
  const data = typeof value === "string" ? parseJSON(value) : value
  if (!isRecord(data)) return undefined
  const source = isRecord(data.autoAccept)
    ? data.autoAccept
    : isRecord(data.autoAcceptEdits)
      ? data.autoAcceptEdits
      : undefined
  if (!source) return undefined
  const entries = Object.entries(source).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
  return Object.fromEntries(entries)
}

// Mirrors the renderer's shouldAutoRespondResolved: a session-level override wins, the lineage is
// walked child-first so the nearest defined entry decides, and only when no session key matches does
// the directory-level fallback apply. An unresolvable asking session never falls back, matching
// the renderer, but a dead end mid-chain does.
export async function shouldAutoAccept(input: {
  autoAccept: AutoAcceptMap
  sessionID: string
  directory?: string
  resolveLineage: (sessionID: string) => Promise<LineageSession | undefined>
}): Promise<boolean> {
  const chain: LineageSession[] = [{ id: input.sessionID }]

  for (;;) {
    const override = sessionAutoAccept(input.autoAccept, chain, { sessionID: input.sessionID }, input.directory)
    if (override !== undefined) return override

    const tail = chain[chain.length - 1]
    const session = await input.resolveLineage(tail.id).catch(() => undefined)
    if (!session) {
      if (chain.length === 1) return false
      break
    }
    if (chain.length >= LINEAGE_MAX_SESSIONS) break

    const parentID = session.parentID
    if (!parentID || chain.some((item) => item.id === parentID)) break
    chain[chain.length - 1] = { id: tail.id, parentID }
    chain.push({ id: parentID })
  }

  return input.directory ? isDirectoryAutoAccepting(input.autoAccept, input.directory) : false
}

function parseSession(value: unknown): LineageSession | undefined {
  if (!isRecord(value)) return undefined
  return {
    id: typeof value.id === "string" ? value.id : "",
    parentID: typeof value.parentID === "string" ? value.parentID : undefined,
  }
}

export function startPermissionAutoResponder(input: {
  url: string
  username?: string
  password?: string | null
  readAutoAccept: () => AutoAcceptMap | undefined
  fetch?: typeof globalThis.fetch
  log?: Logger
}): PermissionAutoResponder {
  const fetcher = input.fetch ?? globalThis.fetch
  const log = input.log ?? (() => undefined)
  const authorization = input.password
    ? `Basic ${Buffer.from(`${input.username ?? "novacode"}:${input.password}`).toString("base64")}`
    : undefined
  const headers: Record<string, string> = { ...(authorization ? { authorization } : {}) }
  const controller = new AbortController()

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

  const fetchSession = (sessionID: string, directory?: string) => {
    const url = new URL(`/session/${encodeURIComponent(sessionID)}`, input.url)
    if (directory) url.searchParams.set("directory", directory)
    return fetcher(url, { headers, signal: controller.signal })
      .then((response) => (response.ok ? response.json().catch(() => undefined) : undefined))
      .then((session) => parseSession(session))
      .catch(() => undefined)
  }

  const reply = (request: { id: string; sessionID: string }, directory?: string) => {
    const url = new URL(
      `/session/${encodeURIComponent(request.sessionID)}/permissions/${encodeURIComponent(request.id)}`,
      input.url,
    )
    if (directory) url.searchParams.set("directory", directory)
    return fetcher(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ response: "once" }),
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) log("permission auto accept reply failed", { status: response.status, request })
        return undefined
      })
      .catch(() => undefined)
  }

  const respond = (request: { id: string; sessionID: string }, directory?: string) => {
    const autoAccept = input.readAutoAccept()
    if (!autoAccept) return Promise.resolve()
    return shouldAutoAccept({
      autoAccept,
      sessionID: request.sessionID,
      directory,
      resolveLineage: (sessionID) => fetchSession(sessionID, directory),
    })
      .then((accept) => {
        if (!accept) return undefined
        log("permission auto accepted", { request, directory })
        return reply(request, directory)
      })
      .catch(() => undefined)
  }

  const handleEvent = (raw: string) => {
    const event = parseJSON(raw)
    if (!isRecord(event) || !isRecord(event.payload)) return
    if (event.payload.type !== "permission.asked") return
    const request = event.payload.properties
    if (!isRecord(request) || typeof request.id !== "string" || typeof request.sessionID !== "string") return
    const directory = typeof event.directory === "string" && event.directory !== "global" ? event.directory : undefined
    void respond({ id: request.id, sessionID: request.sessionID }, directory)
  }

  const consume = async (body: ReadableStream<Uint8Array>) => {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n?/g, "\n")
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
        if (data) handleEvent(data)
      }
    }
  }

  const done = (async () => {
    for (;;) {
      const response = await fetcher(new URL("/global/event", input.url), {
        headers,
        signal: controller.signal,
      }).catch(() => undefined)
      if (response?.ok && response.body) await consume(response.body).catch(() => undefined)
      if (controller.signal.aborted) return
      await delay(RECONNECT_DELAY_MS)
    }
  })()

  return {
    stop: () => {
      controller.abort()
      return done
    },
  }
}
