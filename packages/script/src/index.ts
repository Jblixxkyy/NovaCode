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

// Always resolve a real semver. Upstream's free tier gates on the version in the
// request user-agent, so a 0.0.0-<channel> placeholder blocks every model call.
// Prefer the desktop version so the engine reports the same number users see in
// the installed app; the root version is only a fallback.
const baseVersion = await (async () => {
  const candidates = [
    (await Bun.file(path.resolve(import.meta.dir, "../../../packages/desktop/package.json"))
      .json()
      .then((pkg) => pkg.version)
      .catch(() => undefined)),
    rootPkg.version,
  ]
  for (const candidate of candidates) {
    const value = String(candidate ?? "")
    if (value && value !== "0.0.0") return value
  }
  return "0.0.0"
})()

const VERSION = await (async () => {
  if (env.NOVACODE_VERSION) return env.NOVACODE_VERSION
  const [major, minor, patch] = baseVersion.split(".").map((x: string) => Number(x) || 0)
  const t = env.NOVACODE_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  if (t) return `${major}.${minor}.${patch + 1}`
  return baseVersion
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
