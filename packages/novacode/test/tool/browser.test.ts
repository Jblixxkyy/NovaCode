import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@novacode-ai/core/effect/layer-node"
import { ToolRegistry } from "@/tool/registry"
import { ToolJsonSchema } from "@/tool/json-schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@novacode-ai/core/provider"
import { ModelV2 } from "@novacode-ai/core/model"

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".novacode")])),
})
const root = LayerNode.group([ToolRegistry.node, Agent.node])
const replacements = [
  [Config.node, configLayer],
  [RuntimeFlags.node, RuntimeFlags.layer()],
] as const
const it = testEffect(LayerNode.compile(root, replacements))

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry.browser", () => {
  // The browser port's canonical registrations live in the core (v2) registry,
  // but shipped clients run sessions through this registry — the bridge in
  // ToolRegistry.state must expose every browser operation here too.
  it.instance("exposes all browser tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      const browser = ids.filter((id) => id.startsWith("browser_"))

      expect(browser).toHaveLength(45)
      expect(browser).toContain("browser_tabs_list")
      expect(browser).toContain("browser_tabs_open")
      expect(browser).toContain("browser_navigate")
      expect(browser).toContain("browser_snapshot")
      expect(browser).toContain("browser_screenshot")
      expect(browser).toContain("browser_preview")
    }),
  )

  it.instance("derives provider JSON schemas for browser tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const browser = tools.filter((tool) => tool.id.startsWith("browser_"))

      expect(browser).toHaveLength(45)
      for (const tool of browser) {
        const schema = ToolJsonSchema.fromTool(tool)
        expect(schema.type).toBe("object")
      }
      const navigate = browser.find((tool) => tool.id === "browser_navigate")
      const schema = ToolJsonSchema.fromTool(navigate!)
      expect(Object.keys(schema.properties ?? {})).toContain("url")
      expect(Object.keys(schema.properties ?? {})).toContain("tabID")
    }),
  )
})
