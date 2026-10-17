import { readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@novacode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@novacode-ai/core/installation/version"
import { Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function eventResponse() {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    const desktopDiscovery = Effect.fn("GlobalHttpApi.desktopDiscovery")(function* () {
      const candidates = (() => {
        const paths = new Set<string>()
        // Primary + legacy app dirs (rebrand opencode → novacode)
        paths.add(join(homedir(), ".novacode", "desktop-discovery.json"))
        paths.add(join(homedir(), ".novacode", "desktop-discovery.json"))
        // Windows native homedir when running in WSL or vice versa
        if (process.env.USERPROFILE) {
          paths.add(join(process.env.USERPROFILE, ".novacode", "desktop-discovery.json"))
          paths.add(join(process.env.USERPROFILE, ".novacode", "desktop-discovery.json"))
        }
        if (process.env.HOME && process.env.HOME !== homedir()) {
          paths.add(join(process.env.HOME, ".novacode", "desktop-discovery.json"))
          paths.add(join(process.env.HOME, ".novacode", "desktop-discovery.json"))
        }
        // WSL -> Windows mount: desktop is Windows, server is WSL.
        if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
          try {
            const winUser = process.env.USERPROFILE?.split("\\").pop() ?? process.env.USER?.split("/").pop()
            if (winUser) {
              for (const drive of ["c", "d"]) {
                paths.add(join(`/mnt/${drive}/Users`, winUser, ".novacode", "desktop-discovery.json"))
                paths.add(join(`/mnt/${drive}/Users`, winUser, ".novacode", "desktop-discovery.json"))
              }
            }
          } catch {}
        }
        return [...paths]
      })()
      // WSL fallback: when USERPROFILE/winUser is missing or wrong, enumerate all
      // Windows user profiles on common drives. Done lazily with readdir.
      if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
        for (const drive of ["c", "d"] as const) {
          const base = `/mnt/${drive}/Users`
          const entries = yield* Effect.tryPromise({
            try: () => readdir(base, { withFileTypes: true }),
            catch: () => [] as any[],
          }).pipe(Effect.catch(() => Effect.succeed([] as any[])))
          for (const entry of entries as any[]) {
            if (!entry.isDirectory()) continue
            if (entry.name === "Default" || entry.name === "Public" || entry.name === "All Users" || entry.name === "Default User") continue
            const p = join(base, entry.name, ".novacode", "desktop-discovery.json")
            if (!candidates.includes(p)) candidates.push(p)
            const legacy = join(base, entry.name, ".novacode", "desktop-discovery.json")
            if (!candidates.includes(legacy)) candidates.push(legacy)
          }
        }
      }
      let content: string | undefined
      for (const discoveryPath of candidates) {
        const attempt = yield* Effect.tryPromise({
          try: () => readFile(discoveryPath, "utf-8"),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (attempt) {
          content = attempt
          break
        }
      }
      if (!content) return { available: false as const }
      const parsed = yield* Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (
        typeof parsed === "object" && parsed !== null &&
        "url" in parsed && typeof (parsed as any).url === "string" &&
        "password" in parsed && typeof (parsed as any).password === "string"
      ) {
        return { available: true as const, discovery: parsed as any }
      }
      return { available: false as const }
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
      .handle("desktopDiscovery", desktopDiscovery)
  }),
)
