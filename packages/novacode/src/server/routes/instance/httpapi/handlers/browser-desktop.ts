import { BrowserDesktop } from "@novacode-ai/browser/desktop"
import { BrowserPermissions } from "@novacode-ai/browser/permissions"
import { Global } from "@novacode-ai/core/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"

// Thin handlers over the process-wide BrowserDesktop.host singleton: the
// host owns attachment liveness, the command queue, and published state.
// Attaching is how the desktop app claims the browser surface; while no
// desktop is attached (or its heartbeat lapses) browser tools keep using
// the Playwright driver untouched.
export const browserDesktopHandlers = HttpApiBuilder.group(RootHttpApi, "browser-desktop", (handlers) =>
  Effect.gen(function* () {
    const host = BrowserDesktop.host

    const attach = Effect.fn("BrowserDesktopHttpApi.attach")(function* (ctx: { payload: { client: string } }) {
      // Ship the effective domain ACL with the attachment so the desktop's
      // webview navigation enforces the same rules as the Playwright driver.
      const acl = yield* Effect.promise(() => BrowserPermissions.loadACL(Global.Path.config))
      return yield* Effect.sync(() => host.attach(ctx.payload.client, acl))
    })

    const commands = Effect.fn("BrowserDesktopHttpApi.commands")(function* (ctx: {
      query: { attachment: string }
    }) {
      // Long-poll: resolves with the next command, a timeout, or detached.
      return yield* Effect.promise(() => host.poll(ctx.query.attachment, 25_000))
    })

    const result = Effect.fn("BrowserDesktopHttpApi.result")(function* (ctx: {
      payload: { attachment: string; requestID: string; outcome: BrowserDesktop.DesktopOutcome }
    }) {
      return yield* Effect.sync(() => host.complete(ctx.payload.attachment, ctx.payload.requestID, ctx.payload.outcome))
    })

    const state = Effect.fn("BrowserDesktopHttpApi.state")(function* (ctx: {
      payload: {
        attachment: string
        scope: string
        state: BrowserDesktop.PublishedState["state"]
        viewport?: BrowserDesktop.DesktopViewport
      }
    }) {
      return yield* Effect.sync(() =>
        host.publish(ctx.payload.attachment, ctx.payload.scope, ctx.payload.state, ctx.payload.viewport),
      )
    })

    const detach = Effect.fn("BrowserDesktopHttpApi.detach")(function* (ctx: { payload: { attachment: string } }) {
      return yield* Effect.sync(() => host.detach(ctx.payload.attachment))
    })

    return handlers
      .handle("attach", attach)
      .handle("commands", commands)
      .handle("result", result)
      .handle("state", state)
      .handle("detach", detach)
  }),
)
