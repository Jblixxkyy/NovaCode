import { Flag } from "@novacode-ai/core/flag/flag"
import { Effect } from "effect"
import path from "path"

const preserveExerciseGlobalRoot = !!process.env.NOVACODE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.NOVACODE_HTTPAPI_EXERCISE_GLOBAL ??
  path.join(process.env.TMPDIR ?? "/tmp", `opencode-httpapi-global-${process.pid}`)
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.NOVACODE_DISABLE_SHARE = "true"
export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "novacode")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "novacode")

const preserveExerciseDatabase = !!process.env.NOVACODE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.NOVACODE_HTTPAPI_EXERCISE_DB ??
  path.join(process.env.TMPDIR ?? "/tmp", `opencode-httpapi-exercise-${process.pid}.db`)
process.env.NOVACODE_DB = exerciseDatabasePath
Flag.NOVACODE_DB = exerciseDatabasePath

export const original = {
  NOVACODE_SERVER_PASSWORD: Flag.NOVACODE_SERVER_PASSWORD,
  NOVACODE_SERVER_USERNAME: Flag.NOVACODE_SERVER_USERNAME,
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
