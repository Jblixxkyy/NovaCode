import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novacode-ai/core/effect/app-node-builder"
import { SkillPlugin } from "@novacode-ai/core/plugin/skill"
import { SkillV2 } from "@novacode-ai/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-novacode skill and not customize-opencode", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      const list = yield* skill.list()
      expect(list).toContainEqual(
        expect.objectContaining({
          name: "customize-novacode",
          description: expect.stringContaining("NovaCode configuration"),
        }),
      )
      expect(list.find((item) => item.name === "customize-opencode")).toBeUndefined()
      expect(list.find((item) => item.name === "customize-novacode")?.description).toContain("novacode.json")
    }),
  )
})
