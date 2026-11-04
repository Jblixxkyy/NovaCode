import { NodeHttpServer } from "@effect/platform-node"
import { BrowserDesktop } from "@novacode-ai/browser/desktop"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@novacode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { browserDesktopHandlers } from "../../src/server/routes/instance/httpapi/handlers/browser-desktop"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([browserDesktopHandlers, controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

const post = (url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
    HttpClient.execute,
  )

describe("browser desktop tunnel HttpApi", () => {
  it.live("attach, command round-trip, state publish, and detach over HTTP", () =>
    Effect.gen(function* () {
      const host = BrowserDesktop.host

      const attachResponse = yield* post("/browser/desktop/attach", { client: "httpapi-test" })
      expect(attachResponse.status).toBe(200)
      const attached = (yield* attachResponse.json) as { attachment: string; replaced: boolean }
      expect(attached.attachment).toMatch(/^attach_/)
      expect(attached.replaced).toBe(false)
      expect(host.attached()).toBe(true)

      // A driver-side command waits in the host until the desktop polls.
      const pending = host.execute("/work", { type: "tabs.list" })
      const pollResponse = yield* HttpClient.get(`/browser/desktop/commands?attachment=${attached.attachment}`)
      expect(pollResponse.status).toBe(200)
      const polled = (yield* pollResponse.json) as {
        status: string
        command: { requestID: string; scope: string; action: { type: string } }
      }
      expect(polled.status).toBe("command")
      expect(polled.command.scope).toBe("/work")
      expect(polled.command.action).toEqual({ type: "tabs.list" })

      const state = { tabs: [], focusedTabID: null }
      const resultResponse = yield* post("/browser/desktop/result", {
        attachment: attached.attachment,
        requestID: polled.command.requestID,
        outcome: { type: "success", result: state },
      })
      expect(yield* resultResponse.json).toBe(true)
      yield* Effect.promise(() => pending).pipe(
        Effect.tap((resolved) => Effect.sync(() => expect(resolved).toEqual(state))),
      )

      const publishResponse = yield* post("/browser/desktop/state", {
        attachment: attached.attachment,
        scope: "/work",
        state,
        viewport: { width: 900, height: 600 },
      })
      expect(yield* publishResponse.json).toBe(true)
      expect(host.stateFor("/work")?.viewport).toEqual({ width: 900, height: 600 })

      const detachResponse = yield* post("/browser/desktop/detach", { attachment: attached.attachment })
      expect(yield* detachResponse.json).toBe(true)
      expect(host.attached()).toBe(false)
      expect(host.stateFor("/work")).toBeUndefined()
    }),
  )

  it.live("polls for an unknown attachment report detached", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/browser/desktop/commands?attachment=attach_missing")
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ status: "detached" })
    }),
  )
})
