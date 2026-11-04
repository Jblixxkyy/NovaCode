# Browser Panel: OpenCode Reference vs NovaCode Port

Reference screenshots captured from OpenCode's real browser panel
(`packages/gui-extensions/src/browser/panel.tsx` via its component test).
The NovaCode port (`packages/app/src/components/browser/BrowserPanel.tsx`)
faithfully replicates this layout.

## 1. Loaded tab (main view)

![OpenCode loaded tab](opencode-panel-loaded.png)

- Top bar (h-11): back/forward, reload, address field with URL, inspect toggle, options menu
- Content: live page capture
- NovaCode matches: `BrowserPanel.tsx` renders identical bar layout with
  `data-component="browser-bar"`, address field, inspect button, menu.

## 2. Address field focused (editing)

![OpenCode address focused](opencode-panel-address.png)

- URL selected for editing, site icon, action icons
- NovaCode: `BrowserAddressBar.tsx` replicates focus/selection behavior,
  suggestions dropdown from `recent` history.

## 3. Loading state

![OpenCode loading](opencode-panel-loading.png)

- Spinner/badge while navigating; reload button becomes stop
- NovaCode: `focusedTab()?.loading` toggles stop icon + loading badge.

## 4. Failed state

![OpenCode failed](opencode-panel-failed.png)

- Globe icon, "URL can't be reached", description
- NovaCode: `failed()` shows identical empty-state layout with
  `browser.failed.title` / `browser.failed.description` i18n keys.

## 5. Inspect (element picker) mode

![OpenCode inspect](opencode-panel-inspect.png)

- Crosshair cursor, click maps to element ref, comment editor overlay
- NovaCode: `inspecting` state + `/browser/pick` endpoint (snapshot with
  boxes → `refAtPoint`) + `BrowserCommentEditor.tsx` overlay.

## NovaCode in-app screenshots

Captured from the real NovaCode web app (branch `browser-port`): embedded
web UI served by `novacode serve` on 127.0.0.1:4096, real session page,
browser tab opened via "Toggle review" → "Browser". The server-side
Playwright driver loaded a local demo page (external navigation is blocked
in this sandbox, so `http://127.0.0.1:8899/` stands in for a real site).

### 6. Session layout with browser tab open

![NovaCode browser tab in session](novacode-panel-loaded.png)

- Right panel shows Review + Browser tabs; Browser tab renders the tab strip
  ("Example Domain"), the browser bar (back/forward/reload, address field
  with host emphasized, inspect toggle, options menu), and the live page
  capture below — matching OpenCode's layout in (1).

### 7. Browser panel close-up

![NovaCode browser panel close-up](novacode-panel-closeup.png)

- Tab strip, h-11 browser bar, and live page capture fill the panel.

### 8. Address bar focused

![NovaCode address bar focused](novacode-panel-address.png)

- Clicking the address field selects the full URL for editing, mirroring
  OpenCode's behavior in (2).
