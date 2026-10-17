import path from "path"
import { Global } from "@novacode-ai/core/global"
import { SkillV2 } from "@novacode-ai/core/skill"
import { FSUtil } from "@novacode-ai/core/fs-util"
import { Location } from "@novacode-ai/core/location"
import { AbsolutePath } from "@novacode-ai/core/schema"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { InvalidRequestError } from "@novacode-ai/protocol/errors"
import { Api } from "../api"
import { response } from "../location"

function isSafeSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  )
}

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers
    .handle("skill.list", () => response(SkillV2.Service.use((skill) => skill.list())))
    .handle(
      "skill.create",
      Effect.fn(function* (ctx) {
        const skill = yield* SkillV2.Service
        const fs = yield* FSUtil.Service
        const location = yield* Location.Service
        const global = yield* Global.Service

        const name = ctx.payload.name.trim()
        const description = ctx.payload.description?.trim()
        const content = ctx.payload.content

        if (!isSafeSegment(name)) {
          return yield* Effect.fail(new InvalidRequestError({ message: `Invalid skill name: ${name}`, field: "name" }))
        }
        if (!content || content.trim().length === 0) {
          return yield* Effect.fail(new InvalidRequestError({ message: "Skill content is required", field: "content" }))
        }

        // determine target directory
        const targetDir = location.directory
          ? path.join(location.directory, ".novacode", "skills", name)
          : path.join(global.config, "skills", name)
        const targetFile = path.join(targetDir, "SKILL.md")

        const exists = yield* fs.exists(targetFile).pipe(Effect.orDie)
        if (exists) {
          return yield* Effect.fail(new InvalidRequestError({ message: `Skill already exists: ${name}`, field: "name" }))
        }

        const frontmatterLines = ["---", `name: ${name}`]
        if (description) frontmatterLines.push(`description: ${description}`)
        frontmatterLines.push("---", "")
        const fileContent = `${frontmatterLines.join("\n")}${content.trim()}\n`

        yield* fs.writeWithDirs(targetFile, fileContent).pipe(
          Effect.mapError((cause) => new InvalidRequestError({ message: String(cause), field: "content" })),
        )

        // invalidate cache and reload
        yield* skill.reload().pipe(Effect.orDie)

        const created: SkillV2.Info = {
          name,
          description,
          location: AbsolutePath.make(targetFile),
          content: content.trim(),
        }
        return created
      }),
    )
    .handle(
      "skill.remove",
      Effect.fn(function* (ctx) {
        const skill = yield* SkillV2.Service
        const fs = yield* FSUtil.Service

        const name = ctx.query.name.trim()
        if (!isSafeSegment(name)) {
          return yield* Effect.fail(new InvalidRequestError({ message: `Invalid skill name: ${name}`, field: "name" }))
        }

        const all = yield* skill.list()
        const found = all.find((s) => s.name === name)
        if (!found) {
          return yield* Effect.fail(new InvalidRequestError({ message: `Skill not found: ${name}`, field: "name" }))
        }

        // prevent deleting embedded built-in skills
        if (found.location === "/builtin/customize-novacode.md" || found.location.includes("/builtin/")) {
          return yield* Effect.fail(new InvalidRequestError({ message: "Cannot delete built-in skill", field: "name" }))
        }

        const filePath = found.location
        const isSkillMd = path.basename(filePath) === "SKILL.md"
        const target = isSkillMd ? path.dirname(filePath) : filePath

        const exists = yield* fs.exists(filePath).pipe(Effect.orDie)
        if (!exists) {
          return yield* Effect.fail(new InvalidRequestError({ message: `Skill file not found: ${filePath}`, field: "name" }))
        }

        // remove file or directory
        yield* fs.remove(target, { recursive: true, force: true }).pipe(
          Effect.catch(() => Effect.void),
          Effect.orDie,
        )

        // also try to remove file if we removed directory but file was direct .md
        if (isSkillMd) {
          // directory removal already handled, but ensure file gone
        } else {
          // if skill was a single .md file directly under skills dir, parent dir remains
        }

        yield* skill.reload().pipe(Effect.orDie)

        return HttpApiSchema.NoContent.make()
      }),
    ),
)