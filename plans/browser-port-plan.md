# Port OpenCode Browser to NovaCode (plan from devin session smooth-espadrille, 2026-10-19)

Repo: ~/workspace/novacode (Jblixxkyy/NovaCode), currently on main @7944dd8 (v2.0.2).
WORK RULES: do NOT push to git without the user's explicit approval. Do all work on a NEW local branch (e.g. `browser-port`). The existing `provider-dialog-fixes` branch is on hold — do not touch it.

## Goal

Port OpenCode's browser automation feature to NovaCode by creating a new `packages/browser` package that uses Playwright server-side (headless Chromium), implements all 45 browser tools, and integrates into the web app's right panel (similar to OpenCode's Review pane). No Electron integration for v1.

## Architecture

Server-side Playwright: run headless Chromium entirely in the server process. Screenshots and page data go back to the web app; web app shows the browser in the right panel. No desktop-app dependency.

## Phase 1: Create package structure — `packages/browser/`

```
packages/browser/
  package.json
  tsconfig.json
  src/
    rpc.ts          # Port OpenCode's RPC schema → Effect schemas
    session.ts      # Playwright browser session management
    tools.ts        # Tool registration via Tools.Service
    files.ts        # File transfer logic (adapt to NovaCode)
    permissions.ts  # Permission gates and URL validation
    index.ts        # Package exports
  test/
    tools.test.ts
    session.test.ts
```

Dependencies: `playwright`, `@novacode-ai/core`, `@novacode-ai/plugin`, `effect` (catalog).

## Phase 2: Port RPC schema to Effect schemas

Source: OpenCode `packages/plugin-browser/src/rpc.ts` (fetch from sst/opencode on GitHub if no local copy — no opencode repo in workspace; use sparse clone or raw file fetch).

Changes: replace `Rpc.define` with Effect `Schema.Struct` definitions. Keep all 45 operations in `Browser.Operations`. Preserve branded types `TabID`, `Ref`, `FileID`. Keep constants `MAX_FILE_BYTES = 5 MiB`, `MAX_TEXT = 100k`. Export pure schemas.

Key schemas: `Tab` (id, url, title, loading, generation), `State` (tabs + focusedTabID), `FileInfo`, `File`, plus all 45 operation input/output schemas:
- Tabs: `tabs.list`, `tabs.open`, `tabs.focus`, `tabs.close`
- Navigation: `navigate`, `back`, `forward`, `reload`, `stop`, `frames`
- Observation: `snapshot`, `find`, `evaluate`, `wait`, `screenshot`
- Input: `click`, `hover`, `drag`, `fill`, `fill_form`, `select`, `check`, `press`, `scroll`, `dialog`
- Files: `files.upload`, `files.drop`, `files.list`, `files.get`
- Diagnostics: `console`, `network.list`, `network.get`
- Performance: `trace.start`, `trace.stop`, `trace.analyze`, `cpu.start`, `cpu.stop`, `cpu.analyze`
- Memory: `heap.snapshot`, `heap.summary`, `heap.query`, `heap.object`, `heap.compare`
- Audits: `lighthouse`

## Phase 3: Playwright session management — `packages/browser/src/session.ts`

- Launch persistent Playwright Chromium context via `playwright.chromium.launchPersistentContext()`
- Profile dir: `~/.novacode/browser-profile/`; headless by default (optionally headed for debugging)
- Tab management (open, close, focus, list); CDP deferred to v2
- Effect service: `export class Service extends Context.Service<Service, Interface>()("@novacode/BrowserSession")`
- Key functions: `launch()`, `openTab(url)`, `closeTab(tabID)`, `focusTab(tabID)`, `listTabs()`, `executeAction(tabID, action)`, `screenshot(tabID)`, `dispose()`

## Phase 4: Permission gates — `packages/browser/src/permissions.ts`

- URL validation (reject `file://`, enforce `https://` for sensitive actions)
- Domain allow/deny list in `~/.novacode/browser-acl.json`
- Use NovaCode's `PermissionV2.Service` (do not invent a separate system)
- Default: deny all browser actions; per-session attachment grants browser permission; sensitive actions (forms, payments, settings) always ask; domain ACL for pre-approved domains

## Phase 5: File transfer logic — `packages/browser/src/files.ts`

Port OpenCode `packages/plugin-browser/src/files.ts`: keep `read()` for server-local uploads, `save()` for captures/downloads to temp dir, 5 MiB total limit, filename sanitization (`captureName()`). Use NovaCode's `FileSystem.FileSystem` and temp-dir patterns (not raw `fs/promises`).

## Phase 6: Tool registration via NovaCode tool system — `packages/browser/src/tools.ts`

Port OpenCode `packages/plugin-browser/src/tools.ts`: replace `ctx.tool.transform()` with `Tools.Service.register()`; replace `Tool.Error` with `Tool.ToolFailure`. Namespace tools as `browser.tabs.open`, `browser.click`, etc. Add `permission: "browser"` to each tool. Use `Tool.make()`; each tool calls the session service.

```ts
yield* Tools.Service.register({
  "browser.tabs.open": Tool.make({
    description: "Open a new browser tab",
    input: Browser.TabsOpenInput,
    output: Browser.Tab,
    execute: (input, context) => browserSession.openTab(input.url),
  }),
  // ... 43 more tools
})
```

## Phase 7: Plugin integration

Create internal plugin `packages/core/src/plugin/browser.ts`:

```ts
import { define } from "@novacode-ai/plugin/v2/effect"
import { Effect } from "effect"
import { BrowserSession } from "@novacode-ai/browser/session"
import { BrowserTools } from "@novacode-ai/browser/tools"

export const Plugin = define({
  id: "novacode.browser",
  effect: (ctx) =>
    Effect.gen(function* () {
      const session = yield* BrowserSession.Service
      yield* BrowserTools.register(ctx, session)
    }),
})
```

Add to the internal plugins list in `packages/core/src/plugin/internal.ts` (after existing plugins).

## Phase 8: Web app right panel integration

Target: `packages/app/src/pages/session/session-side-panel.tsx`
- Add "Browser" tab to the right panel alongside "Review" and file tabs; integrate with the existing tab system (like "Open File"); add trigger via the + button menu
- Show screenshots in the panel when browser is active; browser controls (URL bar, back/forward, refresh)

New components in `packages/app/src/components/browser/`:
- `BrowserPanel.tsx` (container), `BrowserTab.tsx`, `BrowserControls.tsx` (URL bar + nav buttons), `BrowserScreenshot.tsx` (screenshot display with data URI), `BrowserTabList.tsx`

Integration pattern (SolidJS, similar to existing file tabs):
```tsx
<Show when={browserActive}>
  <Tabs.Trigger value="browser">Browser</Tabs.Trigger>
</Show>
<Show when={activeTab === "browser"}>
  <BrowserPanel />
</Show>
```

## Phase 9: Testing

`packages/browser/test/`: `tools.test.ts`, `session.test.ts`, `permissions.test.ts`, `files.test.ts` — cover tool registration/execution, permission gating, file-transfer limits, session lifecycle, URL validation, Playwright session mgmt.

## Phase 10: v2 (deferred)

Electron desktop integration for visible browser, CDP for network/console/profiling, annotation mode, network tunneling, TUI integration.

## UX/behavior fidelity (user requirement, 2026-10-19)

The browser must look AND work the same as OpenCode's browser. Port OpenCode's browser UI design faithfully into the NovaCode web app's right panel — same layout, controls, and interaction patterns — not a redesigned NovaCode take. All 45 tools must behave the same as OpenCode's (same inputs, outputs, and semantics).

## UX/behavior fidelity (user requirement, 2026-10-19)

- The browser must look AND work the same as OpenCode's browser. Match OpenCode's browser UI design faithfully
  (same layout, controls, interaction patterns) in the NovaCode web app's right panel — do NOT redesign NovaCode-style.
- All 45 tools keep OpenCode's inputs, outputs, and semantics (source of truth: `Browser.Operations` in
  `@novacode-ai/browser/rpc`, ported from sst/opencode `packages/plugin-browser/src/rpc.ts`).
- Visual reference: sst/opencode `packages/gui-extensions/src/browser/panel.tsx` (the real browser pane):
  `aside#browser-panel` > top bar (`data-component="browser-bar"`, h-11: back/forward, reload/stop, address field
  with suggestions + site info + zoom badge + page actions, inspect element-picker button, options menu) + content
  area (live page / empty state w/ globe icon + recent pages / failed state / comment editor overlay). Tabs live in
  the Review panel tab strip as `browser:` tabs (see `tabs.css`).
- Reference checkout for screenshots/comparison: `~/workspace/opencode-ref` (sst/opencode @ HEAD ~2026-10-19).

## Verification

- `bun typecheck` in packages/browser, packages/core, packages/app
- `bun run build` from root (note: no root build script exists — run per-package builds instead)
- `bun test` in packages/browser
- Manual: start web app, test browser tools with permission prompts; browser tab appears in right panel; screenshots display; 5 MiB cap respected; permission model (deny default, allow on attachment); all 45 tools execute

### Results (2026-10-19, branch `browser-port`)

- `bun typecheck` packages/browser: clean. packages/core: clean for browser files (pre-existing errors in
  github-copilot/session files also occur on clean main @7944dd8 — verified via `git stash -u`).
- `bun test` packages/browser: **36 pass, 0 fail** (rpc schemas/normalizeAction/44...45 operations,
  files roundtrip + 5 MiB limit, ACL allow/deny, full Driver integration against real headless Chromium:
  tabs lifecycle, navigate/snapshot/click/fill/evaluate, screenshot/console/network/panelSnapshot, error paths).
- Playwright Chromium 147 (v1217) + headless shell install OK on this VM (`bun x playwright install chromium chromium-headless-shell`).
- Correction: OpenCode's plugin-browser actually defines **45** operations, not 44 — the port carries all 45
  (`Browser.Operations.length === 45`, definitions cover all with no extras).
- OpenCode reference panel screenshots captured from its real component test
  (`packages/app/component-tests/browser-pane.spec.ts` harness): `plans/browser-port-shots/opencode-panel-*.png`
  (loaded, beta, address-focused, loading, failed, inspect states).
- packages/app + packages/novacode typechecks and web-app screenshots: delegated to child agent (in progress).

## Risks

1. Playwright dependency + browser binary install (`playwright install chromium`)
2. No Electron initially — acceptable per user choice
3. Web app only; TUI users get nothing
4. Large surface: 45 tools, each must work with the Playwright API
5. File transfers: 5 MiB limit + filename sanitization
6. Must integrate with existing `PermissionV2.Service`
7. Web app panel: learn the existing SolidJS tab/panel patterns in session-side-panel.tsx
8. Playwright tests can be flaky — good isolation and cleanup

## Dependencies

Root catalog: `"playwright": "1.59.1"`. Dependency direction (per repo AGENTS.md): `packages/browser` does NOT
depend on core — `packages/core` depends on `@novacode-ai/browser` (workspace:*). Browser package deps:
`effect` (catalog:), `playwright` (catalog:), `lighthouse`, `@types/bun` (dev).
