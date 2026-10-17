import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { PluginNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const PluginStatus = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
}).annotate({ identifier: "PluginStatus" })

export const PluginStatusList = Schema.Array(PluginStatus).annotate({ identifier: "PluginStatusList" })
export const TogglePayload = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
})

export const PluginPaths = {
  status: "/plugin",
  toggle: "/plugin/toggle",
} as const

export const PluginApi = HttpApi.make("plugin")
  .add(
    HttpApiGroup.make("plugin")
      .add(
        HttpApiEndpoint.get("status", PluginPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(PluginStatusList, "Plugin status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "plugin.status",
            summary: "Get plugin status",
            description: "Get the enabled state of all configured plugins.",
          }),
        ),
        HttpApiEndpoint.post("toggle", PluginPaths.toggle, {
          query: WorkspaceRoutingQuery,
          payload: TogglePayload,
          success: described(PluginStatusList, "Plugin status after toggle"),
          error: PluginNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "plugin.toggle",
            summary: "Toggle plugin",
            description: "Enable or disable a configured plugin. Takes effect immediately.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "plugin",
          description: "HttpApi plugin routes.",
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
