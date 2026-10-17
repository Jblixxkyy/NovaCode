import { $ } from "bun"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// NovaCode-native release variables. The NOVACODE_* fallback keeps the existing
// GitHub workflow compatible while the repository is being fully rebranded.
const env = {
  NOVACODE_CHANNEL: process.env["NOVACODE_CHANNEL"] ?? process.env["NOVACODE_CHANNEL"],
  NOVACODE_BUMP: process.env["NOVACODE_BUMP"] ?? process.env["NOVACODE_BUMP"],
  NOVACODE_VERSION: process.env["NOVACODE_VERSION"] ?? process.env["NOVACODE_VERSION"],
  NOVACODE_RELEASE: process.env["NOVACODE_RELEASE"] ?? process.env["NOVACODE_RELEASE"],
}

const CHANNEL = await (async () => {
  if (env.NOVACODE_CHANNEL) return env.NOVACODE_CHANNEL
  if (env.NOVACODE_BUMP) return "latest"
  if (env.NOVACODE_VERSION && !env.NOVACODE_VERSION.startsWith("0.0.0-")) return "latest"
  try {
    return await $`git branch --show-current`.text().then((x) => x.trim())
  } catch {
    return "dev"
  }
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.NOVACODE_VERSION) return env.NOVACODE_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  let current = String(rootPkg.version ?? "")
  if (!current || current === "0.0.0") {
    try {
      const desktopPkg = await Bun.file(path.resolve(import.meta.dir, "../../../packages/desktop/package.json")).json()
      current = String(desktopPkg.version ?? "0.0.0")
    } catch {
      current = "0.0.0"
    }
  }
  const [major, minor, patch] = current.split(".").map((x: string) => Number(x) || 0)
  const t = env.NOVACODE_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

const bot = ["actions-user", "novacode", "novacode-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.NOVACODE_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`novacode script`, JSON.stringify(Script, null, 2))
