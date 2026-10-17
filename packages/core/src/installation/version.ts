import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

declare global {
  const NOVACODE_VERSION: string
  const NOVACODE_CHANNEL: string
}

function packageVersion() {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")
    const version = JSON.parse(raw).version
    return typeof version === "string" ? version : undefined
  } catch {
    return undefined
  }
}

export const InstallationVersion =
  typeof NOVACODE_VERSION === "string" ? NOVACODE_VERSION : (packageVersion() ?? "local")
export const InstallationChannel = typeof NOVACODE_CHANNEL === "string" ? NOVACODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
