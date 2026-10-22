import { Browser } from "@novacode-ai/browser/rpc"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

export const BrowserPanelState = Schema.Struct({
  tabs: Schema.Array(Browser.Tab),
  focusedTabID: Schema.NullOr(Browser.TabID),
  recent: Schema.Array(Schema.String),
  screenshot: Schema.optional(
    Schema.Struct({
      mime: Schema.String,
      data: Schema.String,
    }),
  ),
}).annotate({ identifier: "Browser.PanelState" })

export const BrowserTabIDPayload = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  tabID: Browser.TabID,
})

export const BrowserApi = HttpApi.make("browser")
  .add(
    HttpApiGroup.make("browser")
      .add(
        HttpApiEndpoint.get("state", "/browser/state", {
          query: WorkspaceRoutingQuery,
          success: described(BrowserPanelState, "Browser panel state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.state",
            summary: "Get browser state",
            description: "Fresh state for the web app's browser panel, including a live screenshot.",
          }),
        ),
        HttpApiEndpoint.post("open", "/browser/open", {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            url: Schema.optional(Schema.String),
          }),
          success: described(BrowserPanelState, "Browser panel state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.open",
            summary: "Open browser tab",
            description: "Open a new browser tab, optionally navigating to a URL.",
          }),
        ),
        HttpApiEndpoint.post("navigate", "/browser/navigate", {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            tabID: Browser.TabID,
            url: Schema.String,
          }),
          success: described(BrowserPanelState, "Browser panel state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.navigate",
            summary: "Navigate browser tab",
            description: "Navigate a browser tab to a URL.",
          }),
        ),
        HttpApiEndpoint.post("back", "/browser/back", {
          query: WorkspaceRoutingQuery,
          payload: BrowserTabIDPayload,
          success: described(BrowserPanelState, "Browser panel state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.back",
            summary: "Go back",
            description: "Navigate a browser tab back in its history.",
          }),
        ),
        HttpApiEndpoint.post("forward", "/browser/forward", {
          query: WorkspaceRoutingQuery,
          payload: BrowserTabIDPayload,
          success: described(BrowserPanelState, "Browser panel state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.forward",
            summary: "Go forward",
            description: "Navigate a browser tab forward in its history.",
          }),
        ),
        HttpApiEndpoint.post("reload", "/browser/reload", {
          query: WorkspaceRoutingQuery,
          payload: BrowserTabIDPayload,
          success: described(BrowserPanelState, "Browser panel state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.reload",
            summary: "Reload",
            description: "Reload a browser tab.",
          }),
        ),
        HttpApiEndpoint.post("stop", "/browser/stop", {
          query: WorkspaceRoutingQuery,
          payload: BrowserTabIDPayload,
          success: described(BrowserPanelState, "Browser panel state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.stop",
            summary: "Stop",
            description: "Stop a browser tab's pending navigation.",
          }),
        ),
        HttpApiEndpoint.post("focus", "/browser/focus", {
          query: WorkspaceRoutingQuery,
          payload: BrowserTabIDPayload,
          success: described(BrowserPanelState, "Browser panel state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.focus",
            summary: "Focus browser tab",
            description: "Focus a browser tab.",
          }),
        ),
        HttpApiEndpoint.post("close", "/browser/close", {
          query: WorkspaceRoutingQuery,
          payload: BrowserTabIDPayload,
          success: described(BrowserPanelState, "Browser panel state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.close",
            summary: "Close browser tab",
            description: "Close a browser tab.",
          }),
        ),
        HttpApiEndpoint.post("pick", "/browser/pick", {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            tabID: Browser.TabID,
            x: Schema.Number,
            y: Schema.Number,
          }),
          success: described(
            Schema.Struct({
              ref: Schema.optional(Schema.String),
              box: Schema.optional(
                Schema.Struct({
                  x: Schema.Number,
                  y: Schema.Number,
                  width: Schema.Number,
                  height: Schema.Number,
                }),
              ),
            }),
            "Picked element ref",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.pick",
            summary: "Pick element",
            description: "Map a CSS-pixel point on the page to the smallest containing element ref.",
          }),
        ),
        HttpApiEndpoint.post("click", "/browser/click", {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            tabID: Browser.TabID,
            x: Schema.Number,
            y: Schema.Number,
          }),
          success: described(BrowserPanelState, "Browser panel state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.click",
            summary: "Click page point",
            description: "Click a CSS-pixel point on a browser tab's page (panel forwarding of normal clicks).",
          }),
        ),
        HttpApiEndpoint.post("clearHistory", "/browser/clear-history", {
          query: WorkspaceRoutingQuery,
          success: described(BrowserPanelState, "Browser panel state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "browser.clearHistory",
            summary: "Clear history",
            description: "Clear the browser panel's recent-pages history.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "browser",
          description: "Headless browser panel routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
