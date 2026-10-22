import * as InstanceState from "@/effect/instance-state"
import { BrowserSession } from "@novacode-ai/browser/session"
import { LocationServiceMap, locationServiceMapLayer } from "@novacode-ai/core/location-services"
import { Location } from "@novacode-ai/core/location"
import { AbsolutePath } from "@novacode-ai/core/schema"
import { BrowserTool } from "@novacode-ai/core/tool/browser"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

// User-driven browser panel calls. These do not go through PermissionV2:
// only the agent's browser tool calls require permission.
export const browserHandlers = HttpApiBuilder.group(InstanceHttpApi, "browser", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service

    // BrowserTool.node is a direct member of locationServices (in addition to
    // its BuiltInTools membership) so the driver service is re-exported here.
    // Layer build failures are server bugs: surface them as defects (HTTP 500).
    const driver = Effect.fn("BrowserHttpApi.driver")(function* () {
      const layer = locations.get(
        Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) }),
      )
      // Note: BrowserTool.Service is a Tag class; it cannot be piped directly
      // at runtime, so wrap it with Effect.service first.
      const service = yield* Effect.service(BrowserTool.Service).pipe(
        Effect.provide(layer),
        Effect.orDie,
      )
      yield* Effect.promise(() => service.ready())
      return service
    })

    const state = Effect.fn("BrowserHttpApi.state")(function* () {
      const service = yield* driver()
      return yield* Effect.promise(() => service.panelSnapshot())
    })

    const open = Effect.fn("BrowserHttpApi.open")(function* (ctx: { payload: { url?: string } }) {
      const service = yield* driver()
      yield* Effect.promise(() => service.openTab(ctx.payload.url, true))
      return yield* Effect.promise(() => service.panelSnapshot())
    })

    const navigate = Effect.fn("BrowserHttpApi.navigate")(function* (ctx: {
      payload: { tabID: string; url: string }
    }) {
      const service = yield* driver()
      yield* Effect.promise(() => service.navigate(ctx.payload.tabID, ctx.payload.url))
      return yield* Effect.promise(() => service.panelSnapshot())
    })

    const back = Effect.fn("BrowserHttpApi.back")(function* (ctx: { payload: { tabID: string } }) {
      const service = yield* driver()
      yield* Effect.promise(() => service.back(ctx.payload.tabID))
      return yield* Effect.promise(() => service.panelSnapshot())
    })

    const forward = Effect.fn("BrowserHttpApi.forward")(function* (ctx: { payload: { tabID: string } }) {
      const service = yield* driver()
      yield* Effect.promise(() => service.forward(ctx.payload.tabID))
      return yield* Effect.promise(() => service.panelSnapshot())
    })

    const reload = Effect.fn("BrowserHttpApi.reload")(function* (ctx: { payload: { tabID: string } }) {
      const service = yield* driver()
      yield* Effect.promise(() => service.reload(ctx.payload.tabID))
      return yield* Effect.promise(() => service.panelSnapshot())
    })

    const stop = Effect.fn("BrowserHttpApi.stop")(function* (ctx: { payload: { tabID: string } }) {
      const service = yield* driver()
      yield* Effect.promise(() => service.stop(ctx.payload.tabID))
      return yield* Effect.promise(() => service.panelSnapshot())
    })

    const focus = Effect.fn("BrowserHttpApi.focus")(function* (ctx: { payload: { tabID: string } }) {
      const service = yield* driver()
      yield* Effect.promise(() => service.focusTab(ctx.payload.tabID))
      return yield* Effect.promise(() => service.panelSnapshot())
    })

    const close = Effect.fn("BrowserHttpApi.close")(function* (ctx: { payload: { tabID: string } }) {
      const service = yield* driver()
      yield* Effect.promise(() => service.closeTab(ctx.payload.tabID))
      return yield* Effect.promise(() => service.panelSnapshot())
    })

    const pick = Effect.fn("BrowserHttpApi.pick")(function* (ctx: {
      payload: { tabID: string; x: number; y: number }
    }) {
      const service = yield* driver()
      yield* Effect.promise(() => service.snapshot(ctx.payload.tabID, { boxes: true }))
      return yield* Effect.promise(() => service.pickAtPoint(ctx.payload.tabID, ctx.payload.x, ctx.payload.y))
    })

    const click = Effect.fn("BrowserHttpApi.click")(function* (ctx: {
      payload: { tabID: string; x: number; y: number }
    }) {
      const service = yield* driver()
      yield* Effect.promise(() => service.clickAtPoint(ctx.payload.tabID, { x: ctx.payload.x, y: ctx.payload.y }))
      return yield* Effect.promise(() => service.panelSnapshot())
    })

    const clearHistory = Effect.fn("BrowserHttpApi.clearHistory")(function* () {
      const service = yield* driver()
      yield* Effect.sync(() => service.clearHistory())
      return yield* Effect.promise(() => service.panelSnapshot())
    })

    return handlers
      .handle("state", state)
      .handle("open", open)
      .handle("navigate", navigate)
      .handle("back", back)
      .handle("forward", forward)
      .handle("reload", reload)
      .handle("stop", stop)
      .handle("focus", focus)
      .handle("close", close)
      .handle("pick", pick)
      .handle("click", click)
      .handle("clearHistory", clearHistory)
  }),
).pipe(Layer.provide(locationServiceMapLayer))
