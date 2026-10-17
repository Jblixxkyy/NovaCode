#!/usr/bin/env bun
/**
 * One-shot rebrand codemod: renames OpenCode identifiers to NovaCode across
 * git-tracked text files. Deterministic and idempotent — safe to re-run.
 *
 * Exclusions preserve upstream service references that must keep pointing at
 * their real names (URLs, provider names, registry paths).
 */
import { $ } from "bun"

const protectedExact = new Set<string>([
  "OpenCode Zen",
  "opencode.ai",
  "Jblixxkyy/NovaCode",
  "@novacode-cli/cli", // npm publish scope for platform packages, handled separately
])

type Rule = {
  name: string
  patterns: Array<{ find: RegExp; replace: string }>
  // Paths (relative, forward slashes) the rule must not touch.
  skip?: RegExp
  // Paths the rule applies to exclusively.
  only?: RegExp
}

const rules: Rule[] = [
  {
    name: "cli dir packages/novacode -> packages/novacode",
    patterns: [
      { find: /packages\/opencode\b/g, replace: "packages/novacode" },
      { find: /packages\\opencode\b/g, replace: "packages\\novacode" },
      { find: /\.\.\/opencode\b/g, replace: "../novacode" },
      { find: /\.\.\\opencode\b/g, replace: "..\\novacode" },
    ],
    skip: /(^|\/)packages\/novacode\/\.gitignore$/,
  },
  {
    name: "env-vars NOVACODE_ -> NOVACODE_",
    patterns: [{ find: /NOVACODE_/g, replace: "NOVACODE_" }],
  },
  {
    name: "npm scope @novacode-ai/ -> @novacode-ai/",
    patterns: [
      { find: /@opencode-ai\//g, replace: "@novacode-ai/" },
      { find: /"@opencode-ai\/([a-z-]+)":/g, replace: '"@novacode-ai/$1":' },
    ],
  },
  {
    name: "workspace dep opencode -> novacode",
    patterns: [{ find: /"opencode":(\s*)"workspace:/g, replace: '"novacode":$1"workspace:' }],
    only: /\.json$/,
  },
  {
    name: "effect service tags @novacode/ -> @novacode/",
    patterns: [{ find: /@opencode\//g, replace: "@novacode/" }],
  },
  {
    name: "config files novacode.json[c] -> novacode.json[c]",
    patterns: [
      { find: /opencode\.jsonc/g, replace: "novacode.jsonc" },
      { find: /opencode\.json/g, replace: "novacode.json" },
    ],
  },
  {
    name: "databases opencode*.db -> novacode*.db",
    patterns: [
      { find: /opencode-main\.db/g, replace: "novacode-main.db" },
      { find: /opencode-local\.db/g, replace: "novacode-local.db" },
      { find: /opencode-dev\.db/g, replace: "novacode-dev.db" },
      { find: /opencode\.db/g, replace: "novacode.db" },
    ],
  },
  {
    name: "config dir .novacode -> .novacode",
    patterns: [{ find: /\.novacode\b/g, replace: ".novacode" }],
    skip: /packages\/(web|console|docs)\//,
  },
  {
    name: "data dirs xdg opencode -> novacode",
    patterns: [{ find: /(["'`])opencode\1(?=\s*[,)}\]])/g, replace: "$1novacode$1" }],
    only: /packages\/(core|opencode|server|tui|cli)\/src\//,
  },
]

const tracked = await $`git ls-files`.quiet().text()
const others = await $`git ls-files --others --exclude-standard`.quiet().text()
const files = [...tracked.split("\n"), ...others.split("\n")]
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .filter((line) => !/\.(png|jpg|jpeg|gif|ico|icns|woff2?|ttf|mp4|webm|zip|7z|gz|exe|dll|node|wasm|db|sqlite)$/i.test(line))
  .filter((line) => !/^(bun\.lock|bun\.lockb|.*package-lock\.json)$/i.test(line))
  .filter((line) => !/\.bun-cache\//.test(line.replaceAll("\\", "/")))

let touchedFiles = 0
let touchedLines = 0
const perRule = new Map<string, number>()

for (const file of files) {
  const path = file.replaceAll("\\", "/")
  let original: string
  try {
    original = await Bun.file(path).text()
  } catch {
    continue
  }
  if (original.includes("\u0000")) continue

  let next = original
  for (const rule of rules) {
    if (rule.skip?.test(path)) continue
    if (rule.only && !rule.only.test(path)) continue
    let ruleCount = 0
    for (const { find, replace } of rule.patterns) {
      next = next.replace(find, (match) => {
        if (protectedExact.has(match.trim())) return match
        ruleCount++
        return match.replace(find, replace)
      })
    }
    if (ruleCount > 0) perRule.set(rule.name, (perRule.get(rule.name) ?? 0) + ruleCount)
  }

  if (next !== original) {
    await Bun.file(path).write(next)
    touchedFiles++
    touchedLines += Math.abs(next.split("\n").length - original.split("\n").length) || 1
  }
}

console.log(`files changed: ${touchedFiles}`)
for (const [name, count] of perRule) console.log(`  ${name}: ${count}`)
