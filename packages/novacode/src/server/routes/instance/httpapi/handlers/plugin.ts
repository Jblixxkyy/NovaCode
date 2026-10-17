import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ConfigPlugin } from "@/config/plugin"
import { ToolRegistry } from "@/tool/registry"
import { Provider } from "@/provider/provider"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PluginNotFoundError } from "../errors"
import { TogglePayload } from "../groups/plugin"

export const pluginHandlers = HttpApiBuilder.group(InstanceHttpApi, "plugin", (handlers) =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const config = yield* Config.Service
    const registry = yield* ToolRegistry.Service
    const provider = yield* Provider.Service

    const status = Effect.fn("PluginHttpApi.status")(function* () {
      return yield* plugin.status()
    })

    const toggle = Effect.fn("PluginHttpApi.toggle")(function* (ctx: { payload: typeof TogglePayload.Type }) {
      const cfg = yield* config.get()
      const configured = new Set((cfg.plugin ?? []).map(ConfigPlugin.pluginSpecifier))
      if (!configured.has(ctx.payload.id)) {
        return yield* new PluginNotFoundError({ id: ctx.payload.id, message: `Plugin not found: ${ctx.payload.id}` })
      }

      const disabled = new Set(cfg.disabled_plugins ?? [])
      if (ctx.payload.enabled) disabled.delete(ctx.payload.id)
      else disabled.add(ctx.payload.id)

      yield* config.updateGlobal({ disabled_plugins: [...disabled].sort() })
      // The plugin set is baked into per-directory instance state (hooks, tools, providers),
      // so apply the new config immediately by invalidating those states for this instance.
      yield* config.invalidateLocal()
      yield* plugin.invalidate()
      yield* registry.invalidate()
      yield* provider.invalidate()

      return yield* plugin.status()
    })

    return handlers.handle("status", status).handle("toggle", toggle)
  }),
)
