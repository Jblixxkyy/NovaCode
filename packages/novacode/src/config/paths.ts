export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@novacode-ai/core/flag/flag"
import { Global } from "@novacode-ai/core/global"
import { CONFIG_DIR_NAMES, PROJECT_CONFIG_FILES, isAppConfigDir } from "@novacode-ai/core/identity"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@novacode-ai/core/fs-util"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  return (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const projectConfigFiles = Effect.fn("ConfigPaths.projectConfigFiles")(function* (
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  const hits = yield* afs.up({
    targets: [...PROJECT_CONFIG_FILES],
    start: directory,
    stop: worktree,
  })
  const dirs = unique(hits.map((file) => path.dirname(file))).toReversed()
  const result: string[] = []
  for (const dir of dirs) {
    for (const name of PROJECT_CONFIG_FILES) {
      const file = path.join(dir, name)
      if (yield* afs.existsSafe(file)) result.push(file)
    }
  }
  return result
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  const projectHits = Flag.NOVACODE_DISABLE_PROJECT_CONFIG
    ? []
    : yield* afs.up({
        targets: [...CONFIG_DIR_NAMES],
        start: directory,
        stop: worktree,
      })
  const homeHits = yield* afs.up({
    targets: [...CONFIG_DIR_NAMES],
    start: Global.Path.home,
    stop: Global.Path.home,
  })
  return unique([
    Global.Path.config,
    ...orderConfigDirs([...homeHits, ...projectHits]),
    ...(Flag.NOVACODE_CONFIG_DIR ? [Flag.NOVACODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

export function projectConfigFilesInDirectory(dir: string) {
  return PROJECT_CONFIG_FILES.map((name) => path.join(dir, name))
}

export function isConfigDirectory(dir: string) {
  return isAppConfigDir(dir, Flag.NOVACODE_CONFIG_DIR)
}

function orderConfigDirs(hits: string[]) {
  const parents = unique(hits.map((file) => path.dirname(file)))
  const result: string[] = []
  for (const parent of parents) {
    for (const name of CONFIG_DIR_NAMES) {
      const dir = path.join(parent, name)
      if (hits.some((hit) => path.normalize(hit) === path.normalize(dir))) result.push(dir)
    }
  }
  return result
}
