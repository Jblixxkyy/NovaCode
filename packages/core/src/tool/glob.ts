export * as GlobTool from "./glob"

import { ToolFailure } from "@novacode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  path: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Directory to search. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval. Defaults to the active Location.",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: "Maximum results to return",
  }),
})

export const Output = Schema.Array(FileSystem.Entry)
type ModelOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.length === 0 ? ["No files found"] : output.map((item) => item.path)
  return lines.join("\n")
}

const denied = (action: string) => (error: unknown) =>
  new ToolFailure({
    message: error instanceof PermissionV2.CorrectedError ? error.feedback : `Permission denied: ${action}`,
  })

/** Glob leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Find files by glob pattern within the active Location. Relative paths stay inside that Location. Absolute paths inside it are accepted; external absolute paths require external_directory approval. Returns concise relative file resources. Use a path to narrow the search and limit to bound the result count.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput(
                output.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })),
              ),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
              const external = target.externalDirectory
              if (external)
                yield* permission
                  .assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                  .pipe(Effect.mapError(denied("external_directory")))
              yield* permission
                .assert({
                  action: name,
                  resources: [input.pattern],
                  save: ["*"],
                  metadata: {
                    root: input.path ?? ".",
                    path: input.path,
                    limit: input.limit,
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                .pipe(Effect.mapError(denied(name)))
              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* new ToolFailure({ message: "Search path is not a directory" })
              const cwd = target.canonical
              return yield* ripgrep
                .glob({
                  cwd,
                  pattern: input.pattern,
                  limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                })
                .pipe(
                  Effect.map((result) =>
                    result.map((entry) =>
                      FileSystem.Entry.make({
                        ...entry,
                        path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                      }),
                    ),
                  ),
                )
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to find files matching ${input.pattern}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/glob",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, Ripgrep.node, Location.node, PermissionV2.node],
})
