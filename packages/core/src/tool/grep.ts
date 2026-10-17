export * as GrepTool from "./grep"

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

export const name = "grep"

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "Regex pattern to search for in file contents",
  }),
  path: Schema.String.pipe(Schema.optional).annotate({
    description:
      "File or directory to search. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval. Defaults to the active Location.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'File glob to include in the search (for example, "*.js" or "*.{ts,tsx}")',
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: "Maximum matches to return",
  }),
})

export const Output = Schema.Array(FileSystem.Match)
type ModelOutput = typeof Output.Encoded

/** Format raw search matches into the familiar concise model output. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.length === 0 ? ["No files found"] : [`Found ${output.length} matches`]
  let current = ""
  for (const match of output) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  return lines.join("\n")
}

const denied = (action: string) => (error: unknown) =>
  new ToolFailure({
    message: error instanceof PermissionV2.CorrectedError ? error.feedback : `Permission denied: ${action}`,
  })

/** Grep leaf that defaults its filesystem root to the active Location. */
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
            "Search file contents by regular expression within the active Location. Relative paths stay inside that Location. Absolute paths inside it are accepted; external absolute paths require external_directory approval. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput(
                output.map((match) => ({
                  ...match,
                  entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                })),
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
                    include: input.include,
                    limit: input.limit,
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                .pipe(Effect.mapError(denied(name)))
              const info = yield* fs.stat(target.canonical)
              if (info.type !== "Directory" && info.type !== "File")
                return yield* new ToolFailure({ message: `Unable to grep for ${input.pattern}` })
              const cwd = info.type === "Directory" ? target.canonical : path.dirname(target.canonical)
              return yield* ripgrep
                .grep({
                  cwd,
                  pattern: input.pattern,
                  file: info.type === "File" ? path.basename(target.canonical) : undefined,
                  include: input.include,
                  limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                })
                .pipe(
                  Effect.map((result) =>
                    result.map((match) =>
                      FileSystem.Match.make({
                        ...match,
                        entry: FileSystem.Entry.make({
                          ...match.entry,
                          path: RelativePath.make(
                            path.relative(location.directory, path.resolve(cwd, match.entry.path)),
                          ),
                        }),
                      }),
                    ),
                  ),
                )
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to grep for ${input.pattern}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/grep",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, Ripgrep.node, Location.node, PermissionV2.node],
})
