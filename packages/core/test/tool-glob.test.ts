import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novacode-ai/core/effect/app-node-builder"
import { LayerNode } from "@novacode-ai/core/effect/layer-node"
import { Location } from "@novacode-ai/core/location"
import { LocationMutation } from "@novacode-ai/core/location-mutation"
import { PermissionV2 } from "@novacode-ai/core/permission"
import { Ripgrep } from "@novacode-ai/core/ripgrep"
import { AbsolutePath } from "@novacode-ai/core/schema"
import { SessionV2 } from "@novacode-ai/core/session"
import { ToolRegistry } from "@novacode-ai/core/tool/registry"
import { ToolOutputStore } from "@novacode-ai/core/tool-output-store"
import { GlobTool } from "@novacode-ai/core/tool/glob"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_glob_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const searches: Array<{ cwd: string; pattern: string; limit: number }> = []
let denyAction: string | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const ripgrep = Layer.effect(
  Ripgrep.Service,
  Effect.gen(function* () {
    const rg = yield* Ripgrep.Service
    return Ripgrep.Service.of({
      ...rg,
      glob: (input) =>
        Effect.sync(() => searches.push({ cwd: input.cwd, pattern: input.pattern, limit: input.limit })).pipe(
          Effect.andThen(rg.glob(input)),
        ),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(Ripgrep.node)))

const reset = () => {
  assertions.length = 0
  searches.length = 0
  denyAction = undefined
}

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, GlobTool.node]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [Ripgrep.node, ripgrep],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: typeof GlobTool.Input.Type, id = "call-glob") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "glob", input },
})

const it = testEffect(Layer.empty)

describe("GlobTool", () => {
  it.live("registers and searches a relative directory inside the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() =>
          Promise.all([
            fs.mkdir(path.join(tmp.path, "src")),
            fs.writeFile(path.join(tmp.path, "root.ts"), "export const root = 1\n"),
          ]),
        ).pipe(
          Effect.andThen(() =>
            Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "inside.ts"), "export const inside = 1\n")),
          ),
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["glob"])
                const settled = yield* settleTool(registry, call({ pattern: "*.ts", path: "src" }))
                expect(settled.result).toEqual({
                  type: "text",
                  value: path.join(tmp.path, "src", "inside.ts"),
                })
                expect(assertions).toMatchObject([
                  { sessionID, action: "glob", resources: ["*.ts"], save: ["*"] },
                ])
                expect(searches).toEqual([
                  {
                    cwd: path.join(tmp.path, "src"),
                    pattern: "*.ts",
                    limit: Number.MAX_SAFE_INTEGER,
                  },
                ])
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not search outside the Location for relative escape paths", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const secret = path.join(outside.path, "secret.ts")
        return Effect.promise(() =>
          Promise.all([
            fs.writeFile(path.join(active.path, "inside.ts"), "export const inside = 1\n"),
            fs.writeFile(secret, "export const secret = 1\n"),
          ]),
        ).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                const parent = yield* executeTool(registry, call({ pattern: "*.ts", path: ".." }, "call-parent"))
                expect(parent).toEqual({
                  type: "error",
                  value: "Unable to find files matching *.ts",
                })
                expect(searches).toEqual([])

                const escape = path.relative(active.path, outside.path)
                const outsideResult = yield* executeTool(
                  registry,
                  call({ pattern: "*.ts", path: escape }, "call-outside"),
                )
                expect(outsideResult).toEqual({
                  type: "error",
                  value: "Unable to find files matching *.ts",
                })
                expect(searches).toEqual([])
                expect(outsideResult.value).not.toContain("secret.ts")
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("approves an explicit external absolute directory before glob", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(outside.path, "external.ts"), "export const external = 1\n")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              settleTool(registry, call({ pattern: "*.ts", path: outside.path })),
            ),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              const canonicalOutside = yield* Effect.promise(() => fs.realpath(outside.path))
              expect(assertions.map((input) => input.action)).toEqual(["external_directory", "glob"])
              expect(assertions[0]).toMatchObject({
                resources: [path.join(canonicalOutside, "*").replaceAll("\\", "/")],
              })
              expect(assertions[1]).toMatchObject({ resources: ["*.ts"], save: ["*"] })
              expect(searches).toEqual([
                {
                  cwd: canonicalOutside,
                  pattern: "*.ts",
                  limit: Number.MAX_SAFE_INTEGER,
                },
              ])
              expect(settled.result).toEqual({
                type: "text",
                value: path.join(canonicalOutside, "external.ts"),
              })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not search when external_directory or glob approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(outside.path, "denied.ts"), "export const denied = 1\n"))

          reset()
          denyAction = "external_directory"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ pattern: "*.ts", path: outside.path })),
            ),
          ).toEqual({
            type: "error",
            value: "Permission denied: external_directory",
          })
          expect(assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(searches).toEqual([])

          reset()
          denyAction = "glob"
          expect(
            yield* withTool(active.path, (registry) => executeTool(registry, call({ pattern: "*.ts" }))),
          ).toEqual({
            type: "error",
            value: "Permission denied: glob",
          })
          expect(assertions.map((input) => input.action)).toEqual(["glob"])
          expect(searches).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("fails when the search path is not a directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "file.ts"), "export const file = 1\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ pattern: "*", path: "file.ts" }))),
          ),
          Effect.andThen((result) =>
            Effect.sync(() => {
              expect(result).toEqual({
                type: "error",
                value: "Search path is not a directory",
              })
              expect(searches).toEqual([])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
