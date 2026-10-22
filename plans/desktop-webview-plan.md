# Desktop Webview Browser — Phase 1 Plan

**Branch:** `desktop-webview` (off `browser-port` @ 3226a8d)
**Decision (Josh, locked):** the desktop app gets a real live webview browser
like OpenCode's. The web app keeps the current screenshot/Playwright browser,
which also stays as the fallback whenever no desktop is attached.
**Status:** phase 1 — design + working slice. No push, no deploy.

## What OpenCode does (from the comparison, verified in their source)

- Tabs are real Electron `WebContentsView`s owned by the desktop **main**
  process; the agent drives the *same* webContents via
  `webContents.debugger` CDP. One browser, two drivers.
- The server owns tools/permissions. A desktop attaches over a long-lived
  RPC (v4); the server announces a request ID on a `control` event; the
  desktop fetches the command, executes it against its own tab inventory,
  publishes authoritative tab `state`, and returns the `result`.
- `tabs.open` always creates a **new** tab and (unless `focus: false`)
  emits a focus event that opens the Review pane and selects the tab.
- The panel hosts the native view through an embed element; the view is
  **frozen to a still frame** while a comment editor floats above it.
- The browser exists only while a desktop is attached; there is no
  fallback in OpenCode. NovaCode deliberately differs here (see below).

## NovaCode's shape, and the seams that already exist

- Tools (45) are defined once in `packages/browser` (`rpc.ts` operation
  catalog + `tools.ts` definitions whose `run(driver, input, ctx)` calls
  methods on `BrowserSession.Driver`). Both execution paths — the core
  (v2) tool node in `packages/core/src/tool/browser.ts` and the legacy
  registry bridge in `packages/novacode/src/tool/registry.ts` — call the
  same `definition.run` with the **same location-scoped Driver instance**
  that the `/browser/*` panel handlers use. One routing seam inside the
  Driver therefore covers tools, the legacy bridge, and the panel.
- `rpc.ts` already defines a serializable `Browser.Action` union for all
  45 operations (it was modeled on OpenCode's command protocol). Actions
  are the tunnel's command payload — no new command vocabulary.
- Desktop main already runs authenticated HTTP clients of its own sidecar
  (health checks in `main/server.ts`, the permission auto-responder's
  permanent `/global/event` SSE consumer in
  `main/permission-auto-responder.ts`). A main-side tunnel client follows
  that established pattern; main already holds the sidecar URL +
  `novacode:<password>` credentials for both the v1 sidecar
  (`spawnLocalServer`) and the v2 background CLI (`startBackgroundCli`).
- The renderer already has a `Platform` abstraction with desktop-only
  optional capabilities (`packages/app/src/context/platform.tsx`),
  implemented for desktop in `packages/desktop/src/renderer/index.tsx`
  over `window.api` (preload). The embed hooks into exactly that seam.
- IPC rules (desktop AGENTS.md): handlers in `main/ipc.ts`, renderer only
  calls `window.api` from `src/preload`.

## Architecture

```
        agent tool call / panel action
                    │
        ┌───────────▼────────────┐         ┌──────────────────────────┐
        │ server (sidecar)       │  HTTP   │ desktop main             │
        │  Driver (per Location) │ tunnel  │  BrowserTabManager       │
        │   ├─ attached? ──yes──►│◄────────│   WebContentsView / tab  │
        │   │   DesktopHost      │  long-  │  Executor (CDP via       │
        │   │   (in packages/    │  poll   │   webContents.debugger)  │
        │   │    browser)        │         │  Embed manager (views)   │
        │   └─ no: Playwright    │         └───────────▲──────────────┘
        │      Driver (unchanged)│                     │ IPC (preload)
        └───────────▲────────────┘         ┌───────────┴──────────────┐
                    │ /browser/*           │ renderer (shared app)    │
                    └──────────────────────│  BrowserPanel: embed     │
                                           │  placeholder on desktop, │
                                           │  screenshot <img> on web│
                                           └──────────────────────────┘
```

### 1. Tab ownership & state model

- **Desktop attached → desktop owns the tabs.** One `WebContentsView` per
  tab in main, keyed by **scope** (= the Location directory the Driver
  serves; commands and state publishes carry it). Tab IDs keep the
  existing `tab_<uuid>` brand so tools, refs, and panel code are
  unchanged.
- Inventory per tab mirrors `Browser.Tab`: `id, url, title, loading,
  loadError, canGoBack, canGoForward, generation`. `generation` increments
  on navigation and on snapshot, exactly like the Playwright driver, so
  ref-invalidation semantics match.
- The desktop publishes its per-scope inventory to the server after every
  change (and as a heartbeat). The server's copy is authoritative for
  `tabs.list` and the panel — the same "desktop publishes state, server
  resolves tab IDs" rule OpenCode uses.
- Web preferences mirror OpenCode's: `sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false`, `devTools: false`,
  `backgroundThrottling: false`, `focusOnNavigation: false` (panel
  selection must not steal the user's caret).
- **Phase-1 simplification:** one persistent partition
  (`persist:novacode-browser`) for all scopes, so logins persist across
  restarts like a browser profile. OpenCode partitions per attachment;
  per-scope partitions are a phase-2 refinement.
- Views are created unattached and load immediately; a view is added to a
  window only when the renderer's embed claims it. (Assumption to verify
  on a real desktop: an unattached `WebContentsView`'s webContents loads
  and answers CDP/`capturePage` normally.)

### 2. Transport — the server↔desktop tunnel

Chosen: **plain authenticated HTTP on the root API + long-poll**, all in
`packages/novacode` (`groups/browser-desktop.ts`, `handlers/browser-desktop.ts`),
backed by a process-wide `DesktopHost` in `packages/browser/src/desktop.ts`
(the one module both the server handlers and the Driver already share).

| Endpoint | Purpose |
|---|---|
| `POST /browser/desktop/attach` `{version, client}` | Register/refresh the attachment → `{attachment, replaced}`. A new attach replaces the previous one (OpenCode semantics). |
| `GET /browser/desktop/commands?attachment=<id>` | Long-poll (≤25 s): next command envelope `{requestID, scope, action}` or `{command: null}` on timeout, `{detached: true}` if the attachment is gone (client re-attaches). Each poll is also a heartbeat. |
| `POST /browser/desktop/result` `{attachment, requestID, outcome}` | `outcome` = `{type:"success", result}` or `{type:"failure", code, message}` (`code`: `unsupported` for ops a desktop build can't decode/do yet — the agent gets a clear answer instead of a timeout, mirroring OpenCode). |
| `POST /browser/desktop/state` `{attachment, scope, state, viewport?}` | Inventory publish + heartbeat. `viewport` is the focused tab's CSS-pixel size (the panel needs it to scale pick/click coordinates; Playwright tabs are fixed 1280×800). |
| `POST /browser/desktop/detach` `{attachment}` | Clean detach on quit. |

Why long-poll over the alternatives:

- **vs. EventV2/SSE announce (OpenCode's `control` event):** announcing on
  NovaCode's event bus means a new EventV2 definition in the event
  manifest + codegen churn, and the desktop would still fetch/result over
  HTTP. Long-poll reaches identical dispatch latency with zero event
  plumbing. The protocol leaves room to add the announcement later —
  command envelopes are fetchable by ID either way.
- **vs. WebSocket:** the only WS surface is PTY connect (ticket auth,
  instance-scoped). A second WS stack for one client is more machinery
  than a held GET.
- **vs. renderer-relayed IPC:** the renderer is not always running/focused
  (the permission auto-responder exists precisely because main must act
  while the renderer is throttled). The tunnel must be main↔server direct.
- Auth: the same `Authorization` middleware as every root route; the
  desktop authenticates with the sidecar password it already holds. The
  endpoints are **not** instance routes — attach is server-wide and must
  not require a directory the desktop doesn't know yet; scope travels
  inside envelopes.

Liveness: an attachment is live while any of its endpoints was hit within
30 s (polls make this continuous in practice). Expiry ⇒ the Driver falls
back to Playwright for new calls; in-flight commands fail with a clear
"desktop detached" error. Command execution timeout: 120 s envelope
(navigation etc. self-bound at 30 s inside the executor).

### 3. Tool routing & fallback rules

Routing lives **inside `BrowserSession.Driver`** so every caller (core
tools, legacy bridge, panel handlers) inherits it:

- `DriverOptions` gains `scope` (the location directory; the core layer
  passes `location.directory`).
- `ready()`: no-op while a desktop is attached (no Chromium launch for a
  desktop-backed session); otherwise today's lazy Playwright launch,
  unchanged.
- Each public method first checks the host: **attached → forward** the
  equivalent `Browser.Action` (or wire-only op) and adapt the result;
  **not attached → the existing Playwright implementation, byte-for-byte.**
  Attachment is checked per call, so a desktop quitting mid-session
  degrades to Playwright on the next call (tabs do not transfer between
  backends — same boundary as OpenCode's detach, except we keep a working
  browser).
- `state()` stays synchronous: when attached it returns the host's last
  published inventory for the scope.
- `panelSnapshot()` when attached: published inventory +
  a `panelStill` wire op (capturePage still of the focused tab) +
  `desktop: true` + the published `viewport`. Recent list is folded
  server-side from published tab URLs (approximation: agent/user
  navigations both appear; local backend uses its exact list).
- **Phase-1 routed set** (desktop executor implements): `tabs.list`,
  `tabs.open`, `tabs.focus`, `tabs.close`, `navigate`, `back`, `forward`,
  `reload`, `stop`, `frames`, `snapshot`, `find`, `evaluate`, `click`,
  `hover`, `fill`, `fill_form`, `select`, `check`, `press`, `scroll`,
  `wait`, `screenshot`, plus wire-only `clickAtPoint` (panel forwarding)
  and `panelStill`. That covers the brief's core list and the fill/type
  basics.
- **Not routed in phase 1** — when a desktop is attached these fail with a
  typed `BrowserError` saying the operation is not available on desktop
  tabs yet (never silently executed against the wrong backend):
  `drag`, `dialog`, `files.upload`, `files.drop`, `console`,
  `network.list`, `network.get`, `trace.*`, `cpu.*`, `heap.*`,
  `lighthouse`. `files.list`/`files.get` serve the server-side registry of
  desktop screenshots materialized by the forwarder (see below).
  `preview` is not tab-bound and always stays local.
- Screenshot results cross as base64; the Driver forwarder materializes
  them with `BrowserFiles.save` into the capture dir (so `FileInfo`
  paths, the model-image stash, and `files.get` behave exactly like local
  captures) and registers them per tab for `files.list`.
- Snapshot `boxes` (inspect) cross in the snapshot result when requested;
  the Driver caches them per tab so the panel's `pickAtPoint` math —
  which is server-side — works unchanged for desktop tabs.
- Permissions are untouched: routing happens *below* `definition.run`,
  after PermissionV2/legacy `ask` has already approved the call, with the
  same resources. Domain ACL (`browser-acl.json`) is a Playwright-driver
  concern today; the desktop executor applies the same URL policy as
  `normalizeAction` (http/https/about:blank, no embedded credentials) —
  full ACL parity is phase 2 (documented gap, desktop pages are
  user-visible by definition).

### 4. Desktop executor (main process)

`packages/desktop/src/main/browser/`:

- `cdp.ts` — lazy `webContents.debugger` attach ("1.3") + typed `send`,
  ported in pattern from OpenCode's `cdp.ts` (no session routing;
  NovaCode tabs are top-level pages).
- `executor.ts` — the action switch, written against a minimal structural
  `PageContents` interface (debugger send, `loadURL`, `goBack`, …) so it
  is unit-testable with a fake contents and testable against real
  Chromium through a Playwright-backed adapter in `packages/browser`
  tests. Snapshot formatting (AX tree → `- role "name" [ref=eN]` lines),
  ref registration into `globalThis.__novacodeRefs`, and ref resolution
  deliberately mirror `session.ts` so refs behave identically on both
  backends: snapshot assigns `e1…eN` from `Accessibility.getFullAXTree`,
  resolves each `backendDOMNodeId` via `DOM.resolveNode` and stores the
  element in the page-side map; actions resolve from that map.
  - `click`: `DOM.getContentQuads` center → `Input.dispatchMouseEvent`
    (press/release, clickCount, modifier bitmask).
  - `fill`: focus + select-all via `Runtime.callFunctionOn`, then
    `Input.insertText`. `select`: set `selected` on options +
    `input`/`change` events. `check`: read state, click if different.
  - `press`: `Input.dispatchKeyEvent` with a key table for named keys
    and `text` for printable characters; chords split on `+`.
  - `evaluate`: `Runtime.evaluate` (`returnByValue`, `awaitPromise`);
    with a `ref`, the script runs as a function on the resolved element,
    same contract as the local driver.
  - `screenshot`: `Page.captureScreenshot` (element clip via quads,
    `captureBeyondViewport` for full page) → base64.
  - `wait`: load state via webContents loading flags + a deadline;
    text conditions polled through `Runtime.evaluate` — same semantics
    and bounds as local.
- `tabs.ts` — `BrowserTabManager`: scope → tabs, view lifecycle,
  `did-finish-load`/`did-fail-load`/`page-title-updated`/
  `did-navigate(-in-page)` wiring into inventory + state publisher,
  popup (`window.open`) handling as a new focused tab in the same scope.
- `embed.ts` — view placement: `setEmbed(sender, {scope, tabID, bounds,
  visible, frozen})` resolves the sender's `BrowserWindow`, attaches the
  tab's view to `window.contentView`, sets bounds (renderer CSS px ×
  sender zoom factor = DIP), hides on `visible:false`/`frozen:true`
  (frozen = hidden; the renderer shows its panel still underneath —
  phase-1 equivalent of OpenCode's freeze frame), detaches on clear,
  window close, or tab close.
- `host.ts` — the attach client loop (attach → long-poll → execute →
  result; publish on inventory change + 10 s heartbeat; 2 s reconnect
  backoff; `stop()` on sidecar kill/app quit), following the
  permission-auto-responder's shape (`AbortController`, injected
  `fetch`/`log` for tests).

### 5. Panel embed contract (renderer)

- `Platform` gains optional `browserEmbed?: { set(input): void; clear():
  void }` (desktop-only capability, fire-and-forget like other platform
  hooks). Desktop's `createPlatform` implements it over new preload APIs
  `browserEmbedSet` / `browserEmbedClear` → IPC `browser-embed-set` /
  `browser-embed-clear` handled in `main/ipc.ts`.
- `BrowserPanelState` (panel API) gains optional `desktop: boolean` and
  `viewport: {width, height}`. The panel uses `viewport` (default
  1280×800) for all pick/click scaling instead of the hardcoded
  constants — correct for both backends.
- Embed mode = `platform.browserEmbed` exists **and** panel state says
  `desktop: true` **and** a focused tab exists and is not blank/failed:
  - The content area renders a full-size placeholder div instead of the
    screenshot `<img>`; a `ResizeObserver` + scroll/resize listeners +
    an effect on (tabID, bounds, frozen, visible) report its rect to
    main. Unmount or switching to a non-embed state calls `clear()`.
  - **Frozen** whenever inspect mode is on or the comment editor is open:
    the view hides and the panel renders tonight's screenshot flow
    (stills keep arriving via `panelSnapshot`), so inspect picking and
    comment anchoring run the *identical* code path as the web panel.
    CDP `Overlay` inspect in the live view is phase 2.
  - Non-inspect interaction needs no forwarding on desktop: the user
    clicks/types/scrolls in the real page. The agent's actions land in
    the same page — visible live.
- Web: nothing changes. `browserEmbed` is absent, `desktop` may still be
  true (a desktop attached to the same server) — web keeps the screenshot
  flow fed by desktop stills, which the routed `panelSnapshot` provides.

### 6. Locked behaviors — how each holds on desktop

- **Typing-ready open:** unchanged panel flow (auto-create + address
  focus); the create routes to the desktop, which creates a real blank
  tab. A zero-tab panel state cannot persist on either backend.
- **Agent page ⇒ sidebar, own new tab:** tonight's renderer watcher
  (tool-part-driven) is backend-agnostic — it opens the panel and the
  Driver focuses the agent's tab; on desktop that focus is the desktop
  inventory's focused tab, and the embed shows it. `tabs.open` on the
  desktop executor always creates a new tab; user tabs are never
  navigated/reused by an open. (OpenCode's server→pane `focus` *event*
  is unnecessary here because panel focus state already flows through
  `/browser/state`.)
- **Inspect/comment discipline:** identical code path via freeze-to-still
  (mutual exclusion, layered Escape, draft-aware click-away, cleanup on
  tab switch all live in the shared panel and are untouched).
- **Shared UI:** one `BrowserPanel` for both platforms; the only
  platform branch is the page-area renderer (embed placeholder vs.
  `<img>`), exactly the seam the task specified.

### 7. Verification possible on this VM (no Electron GUI)

- Typechecks: `packages/browser`, `packages/core`, `packages/novacode`,
  `packages/app`, `packages/desktop` (`bun run typecheck` per package).
- `packages/browser` tests incl. new `desktop.test.ts` (host: attach/
  replace, execute round-trip, timeout, detach expiry, per-scope state)
  and `desktop-protocol.test.ts`: a **fake desktop client** (Playwright
  CDP adapter in the test, same wire actions) attached to the host while
  a real routed `Driver` drives a real Chromium page through the tunnel
  — proves the protocol end-to-end without Electron.
- `packages/desktop` unit tests for the executor's pure parts (snapshot
  formatting, key table, inventory publishing) against a fake
  `PageContents`.
- `packages/app` unit/browser tests vs. the known baseline (724 pass +
  4 pre-existing hr.ts i18n failures; browser tests 41/41), and
  `packages/novacode` browser tool tests. `bun run generate` in
  `packages/client` after the HttpApi changes (root AGENTS.md rule).
- **Only Josh can verify on his PC:** the GUI slice — view placement/
  zoom math, live interaction, freeze behavior, agent-driven surfacing
  in the real desktop app. Checklist in the final report.

## Deferred to phase 2 (explicit)

- CDP `Overlay` inspect in the live view (element-rect anchoring in-page,
  Ctrl+Shift+C while the page has focus) replacing freeze-to-still picks.
- Console/network capture on desktop tabs; `dialog`; `drag`;
  `files.upload`/`files.drop` into desktop tabs; trace/cpu/heap/
  lighthouse on desktop tabs.
- Domain ACL parity for desktop navigation; per-scope storage
  partitions; tab restore across app restarts; multiple attached
  desktops (latest wins today); SSE announcement instead of long-poll;
  screencast for web (unchanged from the comparison's recommendation —
  independent track).
- `maxWidth` downscaling for desktop screenshots; favicon in inventory
  (the `Browser.Tab` schema has no favicon field on either backend).

## Risks / open assumptions

- Unattached `WebContentsView` loading + `capturePage` behavior (Josh
  verifies; fallback if broken: attach views to an offscreen window).
- Renderer-rect → view-bounds math under app zoom (formula above; Josh
  verifies visually).
- The desktop may also connect to remote/WSL servers: phase 1 attaches
  the host client only for the **local** sidecar (v1 + v2 flows started
  in `main/index.ts`). Sessions on remote servers keep the Playwright
  fallback on that server — no regression, no desktop tabs there.
