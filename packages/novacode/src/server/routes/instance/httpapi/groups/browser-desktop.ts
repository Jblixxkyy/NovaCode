import { BrowserDesktop } from "@novacode-ai/browser/desktop"
import { Browser } from "@novacode-ai/browser/rpc"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

// Server-wide desktop browser tunnel (see plans/desktop-webview-plan.md).
// These routes live on the Root API: attaching a desktop is a property of
// the server process, not of one instance directory. Authorization is
// applied by RootHttpApi.

export const BrowserDesktopCommand = Schema.Struct({
  requestID: Schema.String,
  scope: Schema.String,
  action: BrowserDesktop.DesktopAction,
}).annotate({ identifier: "Browser.DesktopCommand" })

export const BrowserDesktopPoll = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("command"),
    command: BrowserDesktopCommand,
  }),
  Schema.Struct({ status: Schema.Literal("timeout") }),
  Schema.Struct({ status: Schema.Literal("detached") }),
]).annotate({ identifier: "Browser.DesktopPoll" })

export const BrowserDesktopViewport = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
})

export const BrowserDesktopApi = HttpApi.make("browser-desktop")
  .add(
    HttpApiGroup.make("browser-desktop")
      .add(
        HttpApiEndpoint.post("attach", "/browser/desktop/attach", {
          payload: Schema.Struct({
            client: Schema.String,
          }),
          success: described(
            Schema.Struct({
              attachment: Schema.String,
              replaced: Schema.Boolean,
              // The server's effective domain ACL (browser-acl.json): the
              // desktop enforces it on webview navigation so both browser
              // backends apply the same allow/deny rules.
              acl: Schema.Struct({
                allow: Schema.Array(Schema.String),
                deny: Schema.Array(Schema.String),
              }),
            }),
            "Desktop browser attachment",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.desktop.attach",
            summary: "Attach desktop browser",
            description:
              "Attach this server's browser surface to a desktop window. A new attach replaces any previous desktop.",
          }),
        ),
        HttpApiEndpoint.get("commands", "/browser/desktop/commands", {
          query: Schema.Struct({
            attachment: Schema.String,
          }),
          success: described(BrowserDesktopPoll, "Next browser command for the desktop"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.desktop.commands",
            summary: "Poll browser commands",
            description:
              "Long-poll (up to 25s) for the next browser command to execute against the desktop's webview tabs. Each poll is also the attachment heartbeat.",
          }),
        ),
        HttpApiEndpoint.post("result", "/browser/desktop/result", {
          payload: Schema.Struct({
            attachment: Schema.String,
            requestID: Schema.String,
            outcome: BrowserDesktop.DesktopOutcome,
          }),
          success: described(Schema.Boolean, "Whether the result matched a pending command"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.desktop.result",
            summary: "Report browser command result",
            description: "Complete a pending browser command with the desktop's outcome.",
          }),
        ),
        HttpApiEndpoint.post("state", "/browser/desktop/state", {
          payload: Schema.Struct({
            attachment: Schema.String,
            scope: Schema.String,
            state: Browser.State,
            viewport: Schema.optional(BrowserDesktopViewport),
          }),
          success: described(Schema.Boolean, "Whether the state was accepted"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.desktop.state",
            summary: "Publish desktop browser state",
            description:
              "Publish the desktop's authoritative tab inventory for one location scope; also serves as a heartbeat.",
          }),
        ),
        HttpApiEndpoint.post("detach", "/browser/desktop/detach", {
          payload: Schema.Struct({
            attachment: Schema.String,
          }),
          success: described(Schema.Boolean, "Whether an attachment was detached"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.desktop.detach",
            summary: "Detach desktop browser",
            description: "Detach the desktop browser; in-flight commands fail and tools fall back to Playwright.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "browser-desktop",
          description: "Desktop webview browser tunnel routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
