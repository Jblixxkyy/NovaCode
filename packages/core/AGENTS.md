# Core Naming

- `src/identity.ts` is the single source for `APP_NAME=novacode`, `CONFIG_DIR_NAMES`, `PROJECT_CONFIG_FILES`, and `appEnv`/`appEnvTruthy`/`isAppConfigDir`. NovaCode has no OpenCode fallbacks: env vars are `NOVACODE_*` only, config dirs are `.novacode` only, and project config files are `novacode.json[c]` only.
- `src/flag/flag.ts` reads env through `appEnv`/`appEnvTruthy`; `enabledByExperimental` checks the explicit key first, then `NOVACODE_EXPERIMENTAL` via `appEnvTruthy`.
- There is no legacy app-dir migration. `src/global.ts` derives all XDG paths from `APP_NAME` and makes no writes outside them at module load.
- `src/util/path.ts:rewritePathPrefix` is the canonical worktree/session path rewriter: normalizes `\`→`/`, strips trailing `/`, preserves `to` slash style, and only rewrites when `value` equals `from` or is under `from/`. Use it for any project/sandbox/session directory relocation (see `packages/novacode/src/project/project.ts:remapWorktree`).
