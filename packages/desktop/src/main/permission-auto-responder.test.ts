import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { acceptKey, directoryAcceptKey } from "@novacode-ai/app/context/permission-auto-respond"
import {
  parseAutoAccept,
  shouldAutoAccept,
  startPermissionAutoResponder,
  type AutoAcceptMap,
  type LineageSession,
} from "./permission-auto-responder"

const directory = "/repo"

describe("parseAutoAccept", () => {
  test("parses a persisted permission store value", () => {
    expect(parseAutoAccept(JSON.stringify({ autoAccept: { a: true, b: false } }))).toEqual({ a: true, b: false })
  })

  test("migrates the legacy autoAcceptEdits shape", () => {
    expect(parseAutoAccept(JSON.stringify({ autoAcceptEdits: { a: true } }))).toEqual({ a: true })
  })

  test("accepts an object value and filters non-boolean entries", () => {
    expect(parseAutoAccept({ autoAccept: { a: true, junk: "yes" } })).toEqual({ a: true })
  })

  test("returns undefined for missing or invalid values", () => {
    expect(parseAutoAccept(undefined)).toBeUndefined()
    expect(parseAutoAccept("not json")).toBeUndefined()
    expect(parseAutoAccept({})).toBeUndefined()
  })
})

describe("shouldAutoAccept", () => {
  const never: () => Promise<LineageSession | undefined> = () => {
    throw new Error("resolver should not be called")
  }

  test("decides from the session key without resolving lineage", async () => {
    const autoAccept = { [acceptKey("ses_a", directory)]: true }
    expect(await shouldAutoAccept({ autoAccept, sessionID: "ses_a", directory, resolveLineage: never })).toBe(true)
  })

  test("inherits auto accept from a parent session", async () => {
    const autoAccept = { [acceptKey("ses_parent", directory)]: true }
    const sessions: Record<string, LineageSession> = {
      ses_child: { id: "ses_child", parentID: "ses_parent" },
      ses_parent: { id: "ses_parent" },
    }
    expect(
      await shouldAutoAccept({
        autoAccept,
        sessionID: "ses_child",
        directory,
        resolveLineage: (sessionID) => Promise.resolve(sessions[sessionID]),
      }),
    ).toBe(true)
  })

  test("a nearer explicit false overrides a parent true", async () => {
    const autoAccept = {
      [acceptKey("ses_child", directory)]: false,
      [acceptKey("ses_parent", directory)]: true,
    }
    const sessions: Record<string, LineageSession> = {
      ses_child: { id: "ses_child", parentID: "ses_parent" },
      ses_parent: { id: "ses_parent" },
    }
    expect(
      await shouldAutoAccept({
        autoAccept,
        sessionID: "ses_child",
        directory,
        resolveLineage: (sessionID) => Promise.resolve(sessions[sessionID]),
      }),
    ).toBe(false)
  })

  test("falls back to the directory wildcard without parent links", async () => {
    const autoAccept = { [directoryAcceptKey(directory)]: true }
    const sessions: Record<string, LineageSession> = { ses_a: { id: "ses_a" } }
    expect(
      await shouldAutoAccept({
        autoAccept,
        sessionID: "ses_a",
        directory,
        resolveLineage: (sessionID) => Promise.resolve(sessions[sessionID]),
      }),
    ).toBe(true)
  })

  test("an unresolvable asking session never falls back to the directory", async () => {
    const autoAccept = { [directoryAcceptKey(directory)]: true }
    expect(
      await shouldAutoAccept({
        autoAccept,
        sessionID: "ses_missing",
        directory,
        resolveLineage: () => Promise.resolve(undefined),
      }),
    ).toBe(false)
  })

  test("a dead end mid-lineage falls back to the directory", async () => {
    const autoAccept = { [directoryAcceptKey(directory)]: true }
    const sessions: Record<string, LineageSession | undefined> = {
      ses_child: { id: "ses_child", parentID: "ses_parent" },
      ses_parent: undefined,
    }
    expect(
      await shouldAutoAccept({
        autoAccept,
        sessionID: "ses_child",
        directory,
        resolveLineage: (sessionID) => Promise.resolve(sessions[sessionID]),
      }),
    ).toBe(true)
  })

  test("a cyclic lineage stops and falls back to the directory", async () => {
    const autoAccept = { [directoryAcceptKey(directory)]: true }
    const sessions: Record<string, LineageSession> = {
      ses_a: { id: "ses_a", parentID: "ses_b" },
      ses_b: { id: "ses_b", parentID: "ses_a" },
    }
    expect(
      await shouldAutoAccept({
        autoAccept,
        sessionID: "ses_a",
        directory,
        resolveLineage: (sessionID) => Promise.resolve(sessions[sessionID]),
      }),
    ).toBe(true)
  })
})

type Reply = { sessionID: string; permissionID: string; directory: string | null; response: string }

async function until(check: () => boolean, timeoutMs = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function startFakeServer() {
  const sessions: Record<string, LineageSession> = {
    ses_child: { id: "ses_child", parentID: "ses_parent" },
    ses_parent: { id: "ses_parent" },
  }
  const replies: Reply[] = []
  const lineageFetches: string[] = []
  const streams: import("node:http").ServerResponse[] = []

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/global/event") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      streams.push(res)
      req.on("close", () => streams.splice(streams.indexOf(res), 1))
      return
    }
    const session = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (session && req.method === "GET") {
      lineageFetches.push(session[1]!)
      const info = sessions[session[1]!]
      if (!info) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(info))
      return
    }
    const reply = /^\/session\/([^/]+)\/permissions\/([^/]+)$/.exec(url.pathname)
    if (reply && req.method === "POST") {
      let body = ""
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
      req.on("end", () => {
        replies.push({
          sessionID: reply[1]!,
          permissionID: reply[2]!,
          directory: url.searchParams.get("directory"),
          response: (JSON.parse(body) as { response: string }).response,
        })
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (typeof address !== "object" || !address) throw new Error("failed to start fake server")
  const url = `http://127.0.0.1:${address.port}`

  const emit = (event: { type: string; properties: Record<string, unknown>; directory?: string }) =>
    streams.forEach((stream) => stream.write(`data: ${JSON.stringify({ directory: event.directory, payload: event })}\n\n`))

  const ask = (id: string, sessionID: string) =>
    emit({ type: "permission.asked", properties: { id, sessionID, permission: "bash", patterns: [] }, directory })

  return { server, url, replies, lineageFetches, ask, emit, connected: () => streams.length > 0 }
}

describe("startPermissionAutoResponder", () => {
  const servers: Server[] = []
  const responders: { stop: () => Promise<void> }[] = []

  afterEach(async () => {
    await Promise.all(responders.splice(0).map((responder) => responder.stop()))
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          }),
      ),
    )
  })

  test("replies to auto accepted asks and stops when auto accept is off", async () => {
    const fake = await startFakeServer()
    servers.push(fake.server)

    let autoAccept: AutoAcceptMap | undefined = { [acceptKey("ses_child", directory)]: true }
    const responder = startPermissionAutoResponder({
      url: fake.url,
      password: "secret",
      readAutoAccept: () => autoAccept,
    })
    responders.push(responder)

    await until(fake.connected)
    fake.ask("perm_1", "ses_child")
    await until(() => fake.replies.length === 1)
    expect(fake.replies[0]).toEqual({
      sessionID: "ses_child",
      permissionID: "perm_1",
      directory,
      response: "once",
    })

    autoAccept = undefined
    fake.ask("perm_2", "ses_child")
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(fake.replies.length).toBe(1)
  })

  test("walks the lineage to a parent's auto accept", async () => {
    const fake = await startFakeServer()
    servers.push(fake.server)

    const responder = startPermissionAutoResponder({
      url: fake.url,
      password: "secret",
      readAutoAccept: () => ({ [acceptKey("ses_parent", directory)]: true }),
    })
    responders.push(responder)

    await until(fake.connected)
    fake.ask("perm_3", "ses_child")
    await until(() => fake.replies.length === 1)
    expect(fake.replies[0]!.permissionID).toBe("perm_3")
    expect(fake.lineageFetches).toEqual(["ses_child"])
  })
})
