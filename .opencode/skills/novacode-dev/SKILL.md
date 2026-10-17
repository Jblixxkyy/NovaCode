---
name: novacode-dev
description: Edit NovaCode source code - add features, remove code, fix bugs, or refactor. Use when the user wants to change anything in packages/*, the TUI, server, protocol, or core.
---

# NovaCode Dev

Make source edits safely. Every change follows discover → plan → edit → verify → learn.

> Memory: read `.novacode/skills/novacode-dev/learnings.md` at the start of every invocation and apply relevant past learnings. Append new learnings at the end (see §6).

## When to Use

- "add feature", "remove", "change", "edit source", "modify novacode", "fix bug in novacode", "refactor novacode"
- Any work touching `packages/*`, `AGENTS.md` style boundaries, Effect services, or generated protocol/client code.

If the request is only about `novacode.json`, `.novacode/` config, agents, or plugins, use `customize-novacode` instead.

## 1. Discovery (never skip)

0. Load memory: `read` `.novacode/skills/novacode-dev/learnings.md` (create if missing). Reuse applicable past learnings for this task; note which ones apply in your plan.

1. Locate the area:
   - `glob` for `packages/<name>/src/**` -- check `packages/` (32 workspaces) and `packages/novacode/src/*` / `packages/core/src/*` for domain dirs.
   - `grep` for symbols, IDs, or error strings mentioned in the request.
   - Read the nearest `AGENTS.md` (`AGENTS.md:1`, `packages/novacode/AGENTS.md:1`) -- they are the source of truth for style, Effect rules, and session semantics.
2. Read the target file(s) in full before editing. Note existing patterns: `Effect.gen` usage, `export * as Foo from "./foo"` module shape (`packages/novacode/AGENTS.md:7`), schema/error style.
3. Check dependency direction (`AGENTS.md:3`): `Schema → Core/Protocol → Server`, `Client → Schema/Protocol` never `Core/Server`, `sdk-next` composes all three. Changing Protocol/Server `HttpApi` requires `bun run generate` from `packages/client` -- do not hand-edit `src/generated` (`AGENTS.md:2`).
4. For rebrand-touching work, the 6-file set must move together: `packages/core/src/identity.ts:APP_NAME` + `packages/core/src/global.ts` + `packages/core/src/global-migrate.ts` + `packages/core/src/flag/flag.ts` + `packages/novacode/src/config/paths.ts` + `packages/app/src/utils/persist.ts` (`AGENTS.md:163`).
5. For Effect work, also load the `effect` skill and verify APIs against `.novacode/references/effect-smol` or nearby repo code -- don't answer from memory (`.novacode/skills/effect/SKILL.md:10`).

## 2. Plan (before touching files)

Produce a short plan in the reply:
- Which packages/files will change and why.
- Whether `bun run generate` / `./packages/sdk/js/script/build.ts` is needed (`AGENTS.md:1`).
- Branch name ≤3 hyphen-words, no slashes/prefixes (`AGENTS.md:7`): e.g. `session-recovery`.
- Commit style `type(scope): summary` with types `feat|fix|docs|chore|refactor|test` (`AGENTS.md:11`).
- Risk: what breaks if this is wrong (session drain, migration, TUI).

Wait for user go-ahead if the plan deletes public API, moves DB schema, or changes placement (`SessionStore`/`LocationServiceMap`).

## 3. Edit

Follow `AGENTS.md:21` style guide exactly:

- Keep logic inline unless reused/composable; don't pre-extract single-use helpers.
- `Bun.file()` over `fs`, `const` over `let`, ternaries/early returns over `else`, `dot` notation over destructuring.
- Never alias imports, never `import * as`. If a namespace is needed, use the project's own export: `import { Project } from "@novacode-ai/core/project"` then `Project.ID`.
- No `try/catch` where Effect errors suffice; no `any`; rely on inference.
- In `src/config`, follow `export * as ConfigAgent from "./agent"` self-export at top.
- Effect: `Effect.gen(function* () { const svc = yield* Foo.Service; ... })`, `Effect.fn("Domain.method")` for named effects, `Schema.Class` / `Schema.brand` / `Schema.TaggedErrorClass`, `Schema.UnknownFromJsonString` over manual `JSON.parse` (`AGENTS.md:97`).
- Drizzle: `snake_case` fields (`AGENTS.md:121`).
- Inlined single-use values: `await Bun.file(path.join(dir, "journal.json")).json()` not a temp var.
- Keep helpers below the main export, close to caller. Don't return `Effect` from sync helpers.

For V2 session work preserve invariants (`AGENTS.md:151`): durable `session_input` admission separate from execution, `SessionExecution.wake` advisory, `SessionRunner`/tool registry `Location`-scoped, one `llm.stream` per provider turn, delivery vocabulary `steer` vs `queue`.

## 4. Verify

Run from the affected **package dir**, never repo root:

- `bun typecheck` in each touched package (`AGENTS.md:147`).
- `bun test` or `bun run test` in `packages/novacode` / `packages/core` as relevant -- root `bun test` is guarded to fail (`AGENTS.md:144`, `package.json:23`).
- If `Protocol`/`Server HttpApi` changed: `bun run generate` from `packages/client`.
- If legacy SDK changed: `./packages/sdk/js/script/build.ts`.
- For live TUI checks: `tmux new-session -d -s opencode-dev 'bun dev'` then `tmux capture-pane -pt opencode-dev` then `tmux kill-session -t opencode-dev` (`packages/novacode/AGENTS.md:7`).
- For Effect services, prefer `testEffect` / `it.live` / `it.instance` / `tmpdirScoped` patterns (`packages/novacode/test/AGENTS.md:1`).

If verification fails, fix before reporting done. Never claim "already verified" without running it.

## 5. Quick Checklist

- [ ] Memory loaded + relevant learnings applied
- [ ] Read target files + nearest AGENTS.md
- [ ] Branch name valid, dependency direction respected
- [ ] Edits follow style/Effect/module-shape rules
- [ ] Desktop: `window.api`/`ipc.ts`/i18n rules respected (if touching `packages/desktop`)
- [ ] Generated code regenerated, not hand-edited
- [ ] `bun typecheck` passes in touched packages
- [ ] Relevant package tests pass
- [ ] Learnings captured (§6)

## 6. Learn (always run -- never skip)

This skill gets smarter every use. At the end of every invocation, even if no code changed:

1. Review the session: what was non-obvious? Include hidden file relationships, execution paths that differed from appearance, misleading errors + fix, env/flag quirks, build/test commands not in README, architectural constraints, files that must change together. Ignore obvious docs, standard language behavior, things already in `AGENTS.md`, or session-specific chatter (`.novacode/command/learn.md:13`).
2. Decide where each learning belongs:
   - Reusable across many tasks → `.novacode/skills/novacode-dev/learnings.md` (skill memory, always).
   - Project-wide / package-specific durable truth → also propose an `AGENTS.md` update at the closest scope: root (`AGENTS.md:1`), `packages/<name>/AGENTS.md`, or `packages/desktop/AGENTS.md:1`. Keep entries 1-3 lines (`learn.md:40`).
3. Append to `learnings.md` (create file if missing) using this format:

   ```md
   ### YYYY-MM-DD -- <scope> -- <one-line summary>
   - Insight: <non-obvious fact>
   - Evidence: `path/to/file.ts:123`
   - Applied: <how to use next time>
   ```

   Deduplicate: if the same insight exists, update it instead of duplicating.
4. If an `AGENTS.md` change is warranted, `read` the target file, `edit` it, and mention it in the final summary. Keep scope tight -- don't spill desktop truths into root or vice-versa.
5. Summarize in the final reply: `learnings.md` entries added/updated + `AGENTS.md` files touched.

For desktop work also capture: exact IPC channel name, preload exposure, native menu/dialog key used, and which translation bundle was touched.

## 7. Desktop Notes

When `packages/desktop` is in scope (`packages/desktop/AGENTS.md:1`):
- Renderer may only call `window.api` exposed by `src/preload`; main registers handlers in `src/main/ipc.ts:1`.
- Never hardcode user-visible English; use typed i18n keys via `nativeT(...)` / app language API, preserve English byte-for-byte, translate whole phrases with placeholders.
- Verify with `bun --cwd packages/desktop typecheck` (`packages/desktop/package.json:13`) and `electron-vite dev` smoke if UI changed.

## References

- `AGENTS.md:1` -- repo-wide generation, deps, branching, commits, style, rebrand
- `packages/novacode/AGENTS.md:1` -- DB, module shape, Effect rules, InstanceState
- `packages/novacode/test/AGENTS.md:1` -- test fixtures and Effect test patterns
- `effect` skill (`.novacode/skills/effect/SKILL.md:1`) -- Effect v4 source of truth
- `repository-discovery` skill -- for deep codebase profiling before large edits
