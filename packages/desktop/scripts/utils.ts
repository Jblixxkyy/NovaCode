import { $ } from "bun"
import * as fs from "node:fs/promises"
import * as path from "node:path"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.NOVACODE_CHANNEL ?? Bun.env.NOVACODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export const RUST_TARGET = Bun.env.RUST_TARGET

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}

/**
 * Copy the locally built CLI binary into desktop resources. The desktop app
 * bundles the CLI built from this same checkout, so there is nothing to
 * download from npm.
 */
export async function copyLocalCliToResources() {
  const osSegment = process.platform === "win32" ? "windows" : process.platform
  const cpu = process.arch
  const distRoot = path.resolve(import.meta.dir, "../../novacode/dist")
  // Prefer the baseline build for x64 — it runs on every CPU.
  const dirs = [
    `novacode-${osSegment}-${cpu}-baseline`,
    `novacode-${osSegment}-${cpu}`,
    `opencode-${osSegment}-${cpu}-baseline`,
    `opencode-${osSegment}-${cpu}`,
  ]
  const bins = ["novacode.exe", "novacode", "opencode.exe", "opencode"]

  for (const dir of dirs) {
    for (const bin of bins) {
      const candidate = path.join(distRoot, dir, "bin", bin)
      if (!(await Bun.file(candidate).exists())) continue
      const dest = windowsify("resources/novacode-cli")
      await fs.copyFile(candidate, dest)
      if (process.platform !== "win32") await $`chmod 755 ${dest}`
      console.log(`Copied ${candidate} to ${dest}`)
      return
    }
  }

  console.warn(`No locally built CLI found in ${distRoot}. Run: bun run --cwd packages/novacode build --single`)
}
