import Store from "electron-store"
import electron from "electron"
import { rmSync } from "node:fs"
import { join } from "node:path"

import { SETTINGS_STORE } from "./store-keys"
import { deleteStoreFileIfEmpty } from "./store-cleanup"

const cache = new Map<string, Store>()

// We cannot instantiate the electron-store at module load time because
// module import hoisting causes this to run before app.setPath("userData", ...)
// in index.ts has executed, which would result in files being written to the default directory
// (e.g. bad: %APPDATA%\@opencode-ai\desktop\novacode.settings vs good: %APPDATA%\ai.novacode.desktop.dev\novacode.settings).
// The cache is therefore keyed by both name AND data folder: a store created
// before setPath() (default folder) must never be reused after setPath()
// (real folder), or every later read/write silently lands in the wrong place.
export function getStore(name = SETTINGS_STORE) {
  const cwd = electron.app.getPath("userData")
  const key = `${name}:${cwd}`
  const cached = cache.get(key)
  if (cached) return cached
  const next = new Store({
    name,
    cwd,
    fileExtension: "",
    accessPropertiesByDotNotation: false,
  })
  cache.set(key, next)
  return next
}

export async function removeStoreFileIfEmpty(name: string) {
  if (await deleteStoreFileIfEmpty(electron.app.getPath("userData"), name)) {
    for (const key of [...cache.keys()]) {
      if (key.startsWith(`${name}:`)) cache.delete(key)
    }
  }
}

export function removeStoreFile(name: string) {
  rmSync(join(electron.app.getPath("userData"), name), { force: true })
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${name}:`)) cache.delete(key)
  }
}
