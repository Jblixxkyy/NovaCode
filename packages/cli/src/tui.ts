import { run } from "@novacode-ai/tui"
import { TuiConfig } from "@novacode-ai/tui/config"
import type { TuiPluginHost } from "@novacode-ai/tui/plugin/runtime"
import type { HostSlots } from "@novacode-ai/tui/plugin/slots"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novacode-ai/core/effect/app-node-builder"
import { Global } from "@novacode-ai/core/global"

export function runTui(transport: { url: string; headers: RequestInit["headers"] }) {
  const config = TuiConfig.resolve({}, { terminalSuspend: false })
  return run({
    ...transport,
    args: {},
    config,
    fetch: gracefulFetch,
    pluginHost: createPluginHost(),
  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}

// Slots render their fallback children only once the host binds a registry, so a
// no-op host leaves the whole app (logo, prompt, footer) blank on first launch.
function createPluginHost(): TuiPluginHost {
  let slots: HostSlots | undefined
  return {
    async start(input) {
      slots = input.runtime.setupSlots(input.api)
    },
    async dispose() {
      slots?.dispose()
      slots = undefined
    },
  }
}

const legacyDefaults: Record<string, unknown> = {
  "/config/providers": { providers: [], default: {} },
  "/provider": { all: [], default: {}, connected: [] },
  "/agent": [],
  "/config": {},
}

const gracefulFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init)
    if (response.status !== 404) return response
    const fallback = legacyDefaults[new URL(input instanceof Request ? input.url : input).pathname]
    if (fallback === undefined) return response
    return Response.json(fallback)
  },
  { preconnect: fetch.preconnect },
)
