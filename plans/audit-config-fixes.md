# NovaCode Audit + Fix Plan (2026-08-31)

Audit of project plugins, MCP, skills, commands, agents, model configs, and system
prompt files. Branch: `audit-config-fixes`.

## Findings

### Project config (`.novacode/novacode.jsonc`)
- `provider: {}`, `mcp: {}`, `permission: {}` are all empty.
- `references.novacode-local.path` uses the legacy `~/.local/share/opencode`
  path.
- `references.effect` is a GitHub repo, but the `effect` skill expects a local
  clone at `.novacode/references/effect-smol` — mismatch.
- `"tools": { "github-triage": false, "github-pr-search": false }` is not a
  valid config surface. Tools auto-load from `.novacode/tool/`; the toggle is
  silently ignored.

### Global config (`~/.config/opencode/novacode.jsonc`)
- Stored on the legacy `opencode` path. NovaCode-native is
  `~/.config/novacode/novacode.jsonc`.
- `provider.zen` defines `deepseek-v4-flash-free` aliased to `deepseek`. The
  id does not exist on Zen — real Zen ids are `deepseek-v4-flash`,
  `deepseek-v4-pro`, `gpt-5`, etc. The configured alias will 404 on every
  call.

### Project agents
- `triage.md` and `duplicate-pr.md` are `hidden: true` (correct for CI) but
  have no `description` frontmatter — required by the loader even when hidden.
- Model ids referenced (`opencode/gpt-5.4-mini`, `opencode/claude-haiku-4-5`)
  need verification against the current Zen model list.

### Project commands
- `commit.md` model: `opencode/kimi-k2.5`
- `translate.md` model: `opencode/gpt-5.6-sol`
- `changelog.md` model: `opencode/gpt-5.4`
- `issues.md` model: `opencode/claude-haiku-4-5`
- All four need verification; several suspect (`kimi-k2.5`, `gpt-5.6-sol`,
  `gpt-5.4`).

### Project skills
- `effect/SKILL.md` instructs cloning into `.novacode/references/effect-smol`,
  but the reference is registered as a GitHub repo, not a local path.
- `novacode-dev/SKILL.md` and `rtl-aware-development/SKILL.md` have valid
  frontmatter.

### Built-in agents (`packages/novacode/src/agent/agent.ts`)
- `build`, `plan`, `general`, `explore`, plus hidden `compaction`, `title`,
  `summary`. All well-formed.

### System prompts (`packages/novacode/src/agent/prompt/*.txt`)
- `explore.txt` and `generate.txt` read clean.
- `compaction.txt`, `title.txt`, `summary.txt` not yet reviewed.

### New `jarvis` agent (`~/.config/novacode/agent/jarvis.md`)
- Mode `primary`, model `anthropic/claude-sonnet-4-6`.
- Permissions: `bash: allow` is shorthand for `{"*": "allow"}` — runs any
  shell command unchecked. Real risk for `rm -rf`, force-push, etc.

## Fixes

### F1 — global config model id (high)
File: `~/.config/opencode/novacode.jsonc`
Replace `deepseek-v4-flash-free` alias with `deepseek-v4-flash`.

### F2 — global config path (high)
Copy `~/.config/opencode/novacode.jsonc` → `~/.config/novacode/novacode.jsonc`.
Leave the legacy file alone (fallback reads it).

### F3 — project `references.novacode-local` path (high)
File: `.novacode/novacode.jsonc:11`
`"path": "~/.local/share/opencode"` → `"path": "~/.local/share/novacode"`.

### F4 — `references.effect` vs skill mismatch (high)
File: `.novacode/novacode.jsonc:7`
Keep GitHub reference. Update `.novacode/skills/effect/SKILL.md` to drop the
"clone locally" instructions and reference the GitHub alias via `@effect`.

### F5 — dead `tools` block (high)
File: `.novacode/novacode.jsonc:16-19`
Delete the `tools` key entirely.

### F6 — `jarvis` bash permissions (high)
File: `~/.config/novacode/agent/jarvis.md`
Replace `bash: allow` with:

```yaml
bash:
  "git *": allow
  "ls *": allow
  "cat *": allow
  "rg *": allow
  "*": ask
```

### F7 — command model id sweep (high)
Files:
- `.novacode/command/commit.md` — `opencode/kimi-k2.5`
- `.novacode/command/translate.md` — `opencode/gpt-5.6-sol`
- `.novacode/command/changelog.md` — `opencode/gpt-5.4`
- `.novacode/command/issues.md` — `opencode/claude-haiku-4.5`

Resolve each against current Zen list; fall back to
`anthropic/claude-sonnet-4-6` if missing.

### F8 — hidden agent descriptions (medium)
Files: `.novacode/agent/triage.md`, `.novacode/agent/duplicate-pr.md`
Add `description:` frontmatter.

### F9 — remaining prompt txt files (medium)
Review `packages/novacode/src/agent/prompt/{compaction,title,summary}.txt`
for stale instructions.

### F10 — document plan in AGENTS.md (low)
Append `## Audit 2026-08-31` section to root `AGENTS.md` summarizing the 9
fixes and commit hashes so future agents can trace each change.

## Execution order

1. F1, F5 — config correctness, safest first
2. F4, F3 — project config references
3. F2 — global config path move
4. F7 — command model id sweep
5. F8 — hidden agent descriptions
6. F9 — prompt txt review
7. F10 — AGENTS.md update

## Verification

- After each edit, re-read the file to confirm.
- Parse JSONC with `jsonc-parser` (already a dep).
- Manual smoke: enumerate resolved agents/models from the merged config via a
  one-off Bun script using `@novacode-ai/core/config`.
- No typecheck from the shell (it OOM-kills the shell process on Windows);
  rely on schema parsing and manual review instead.

## Status

- [x] Findings gathered
- [ ] F1 — global model id
- [ ] F2 — global config path move
- [ ] F3 — references.novacode-local path
- [ ] F4 — effect reference + skill alignment
- [ ] F5 — remove dead `tools` block
- [ ] F6 — tighten jarvis bash permissions
- [ ] F7 — command model id sweep
- [ ] F8 — hidden agent descriptions
- [ ] F9 — remaining prompt txt review
- [ ] F10 — AGENTS.md note