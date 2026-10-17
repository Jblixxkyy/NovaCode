export * as Identity from "./identity"

/** Runtime product name. Data/config/cache dirs and native config files use this. */
export const APP_NAME = "novacode"

export const CONFIG_DIR_NAMES = [".novacode"] as const
export const PROJECT_CONFIG_FILES = ["novacode.json", "novacode.jsonc"] as const
export const GIT_CACHE_FILE = "novacode"

/** Env vars are NOVACODE_-prefixed only. */
export function appEnv(key: string) {
  return process.env[key]
}

export function appEnvTruthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export function isAppConfigDir(dir: string, extra?: string) {
  return dir.endsWith(".novacode") || (extra !== undefined && dir === extra)
}
