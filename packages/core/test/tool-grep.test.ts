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
import { GrepTool } from "@novacode-ai/core/tool/grep"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_grep_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const searches: Array<{
  cwd: string
  pattern: string
  file?: string
  include?: string
  limit: number
}> = []
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
      grep: (input) =>
        Effect.sync(() =>
          searches.push({
            cwd: input.cwd,
            pattern: input.pattern,
            file: input.file,
            include: input.include,
            limit: input.limit,
          }),
        ).pipe(Effect.andThen(rg.grep(input))),
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
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, GrepTool.node]),
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

const call = (input: typeof GrepTool.Input.Type, id = "call-grep") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "grep", input },
})

const it = testEffect(Layer.empty)

describe("GrepTool", () => {
  it.live("registers and searches a relative directory inside the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() =>
          Promise.all([
            fs.mkdir(path.join(tmp.path, "src")),
            fs.writeFile(path.join(tmp.path, "root.ts"), "alpha-needle\n"),
          ]),
        ).pipe(
          Effect.andThen(() =>
            Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "inside.ts"), "alpha-needle\n")),
          ),
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["grep"])
                const settled = yield* settleTool(registry, call({ pattern: "alpha-needle", path: "src" }))
                expect(settled.result).toEqual({
                  type: "text",
                  value: [
                    "Found 1 matches",
                    `${path.join(tmp.path, "src", "inside.ts")}:`,
                    "  Line 1: alpha-needle\n",
                  ].join("\n"),
                })
                expect(assertions).toMatchObject([
                  { sessionID, action: "grep", resources: ["alpha-needle"], save: ["*"] },
                ])
                expect(searches).toEqual([
                  {
                    cwd: path.join(tmp.path, "src"),
                    pattern: "alpha-needle",
                    file: undefined,
                    include: undefined,
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
        return Effect.promise(() =>
          Promise.all([
            fs.writeFile(path.join(active.path, "inside.ts"), "alpha-needle\n"),
            fs.writeFile(path.join(outside.path, "secret.ts"), "alpha-needle\n"),
          ]),
        ).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                expect(yield* executeTool(registry, call({ pattern: "alpha-needle", path: ".." }, "call-parent"))).toEqual(
                  {
                    type: "error",
                    value: "Unable to grep for alpha-needle",
                  },
                )
                expect(searches).toEqual([])

                const escape = path.relative(active.path, outside.path)
                expect(
                  yield* executeTool(registry, call({ pattern: "alpha-needle", path: escape }, "call-outside")),
                ).toEqual({
                  type: "error",
                  value: "Unable to grep for alpha-needle",
                })
                expect(searches).toEqual([])
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

  it.live("approves an explicit external absolute directory before grep", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(outside.path, "external.ts"), "alpha-needle\n")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              settleTool(registry, call({ pattern: "alpha-needle", path: outside.path })),
            ),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              const canonicalOutside = yield* Effect.promise(() => fs.realpath(outside.path))
              expect(assertions.map((input) => input.action)).toEqual(["external_directory", "grep"])
              expect(assertions[0]).toMatchObject({
                resources: [path.join(canonicalOutside, "*").replaceAll("\\", "/")],
              })
              expect(assertions[1]).toMatchObject({ resources: ["alpha-needle"], save: ["*"] })
              expect(searches).toEqual([
                {
                  cwd: canonicalOutside,
                  pattern: "alpha-needle",
                  file: undefined,
                  include: undefined,
                  limit: Number.MAX_SAFE_INTEGER,
                },
              ])
              expect(settled.result).toEqual({
                type: "text",
                value: [
                  "Found 1 matches",
                  `${path.join(canonicalOutside, "external.ts")}:`,
                  "  Line 1: alpha-needle\n",
                ].join("\n"),
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

  it.live("does not search when external_directory or grep approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(outside.path, "denied.ts"), "alpha-needle\n"))

          reset()
          denyAction = "external_directory"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ pattern: "alpha-needle", path: outside.path })),
            ),
          ).toEqual({
            type: "error",
            value: "Permission denied: external_directory",
          })
          expect(assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(searches).toEqual([])

          reset()
          denyAction = "grep"
          expect(
            yield* withTool(active.path, (registry) => executeTool(registry, call({ pattern: "alpha-needle" }))),
          ).toEqual({
            type: "error",
            value: "Permission denied: grep",
          })
          expect(assertions.map((input) => input.action)).toEqual(["grep"])
          expect(searches).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("fails for a missing path instead of searching the parent directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "parent.ts"), "alpha-needle\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              executeTool(registry, call({ pattern: "alpha-needle", path: "missing-dir/file.ts" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.sync(() => {
              expect(result).toEqual({
                type: "error",
                value: "Unable to grep for alpha-needle",
              })
              expect(searches).toEqual([])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("greps a relative file path through that file only", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(() =>
            Effect.promise(() =>
              Promise.all([
                fs.writeFile(path.join(tmp.path, "src", "a.ts"), "alpha-needle\n"),
                fs.writeFile(path.join(tmp.path, "src", "b.ts"), "alpha-needle\n"),
              ]),
            ),
          ),
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              settleTool(registry, call({ pattern: "alpha-needle", path: path.join("src", "a.ts") })),
            ),
          ),
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(searches).toEqual([
                {
                  cwd: path.join(tmp.path, "src"),
                  pattern: "alpha-needle",
                  file: "a.ts",
                  include: undefined,
                  limit: Number.MAX_SAFE_INTEGER,
                },
              ])
              expect(settled.result).toEqual({
                type: "text",
                value: [
                  "Found 1 matches",
                  `${path.join(tmp.path, "src", "a.ts")}:`,
                  "  Line 1: alpha-needle\n",
                ].join("\n"),
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
