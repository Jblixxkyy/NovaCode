import { run as runTui, type TuiInput } from "@novacode-ai/tui"
import { Global } from "@novacode-ai/core/global"
import { AppNodeBuilder } from "@novacode-ai/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
