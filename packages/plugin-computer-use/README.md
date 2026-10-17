# @novacode-ai/plugin-computer-use

Computer-use plugin for novacode — ChatGPT/Anthropic-style desktop automation.

The model sees the desktop via screenshots and acts via mouse/keyboard, in a loop:

```
screenshot → model decides click/type/key/scroll/drag/wait → plugin executes → screenshot → repeat
```

## Features

- **Single `computer` tool** with actions: `screenshot`, `click`, `double_click`, `right_click`, `move`, `drag`, `scroll`, `type`, `key`/`keypress`, `wait`
- **Always returns a screenshot** as an attachment after every action (closes the observe→act loop like ChatGPT computer-use)
- **Coordinate validation** against configured display size (default 1280×720)
- **Allow/deny gating** (`allowedActions`/`deniedActions`, deny wins)
- **Permission prompt** via `context.ask({ permission: "computer" })` — user sees what will be clicked before it happens; set `requireApproval: false` to skip
- **Runaway guard** (`maxActionsPerSession`, default 500)
- **Cross-platform screenshots**: tries `screenshot-desktop` → PowerShell (Windows) → `screencapture` (macOS) → error with install hint
- **Input synthesis** via `@nut-tree/nut-js` (Windows/macOS, lazy-loaded; screenshot-only works without it)

## Install

```bash
npm i @novacode-ai/plugin-computer-use
# optional but recommended for full control:
npm i screenshot-desktop @nut-tree/nut-js
```

## Usage

Add to your novacode config (`novacode.jsonc` / `novacode.jsonc` — both work via fallback):

```jsonc
{
  "plugin": [
    ["@novacode-ai/plugin-computer-use", {
      "displayWidth": 1280,
      "displayHeight": 720,
      "allowedActions": [],          // empty = all allowed
      "deniedActions": [],           // e.g. ["key"] to block hotkeys
      "requireApproval": true,       // false = no permission prompt
      "maxActionsPerSession": 500,
      "scaleFactor": 1
    }]
  ],
  "permission": {
    "computer": "ask"                // or "allow" / "deny"
  }
}
```

Or register programmatically:

```ts
import { ComputerUsePlugin } from "@novacode-ai/plugin-computer-use"

export default ComputerUsePlugin
```

## Tool schema

| field | type | notes |
|---|---|---|
| `action` | enum | `screenshot` \| `click` \| `double_click` \| `right_click` \| `move` \| `drag` \| `scroll` \| `type` \| `key` \| `keypress` \| `wait` |
| `x`, `y` | int | required for click/move/scroll; validated 0..displayWidth/Height |
| `button` | enum | `left`/`right`/`middle` (click/drag) |
| `path` | {x,y}[] | drag path, ≥2 points |
| `scroll_x`, `scroll_y` / `delta_x`, `delta_y` | int | scroll deltas |
| `text` | string | for `type` (and optional with `key`) |
| `keys` | string[] | for `key`/`keypress`, e.g. `["ctrl","c"]`, `["Enter"]`, `["alt","Tab"]` |
| `ms` / `duration_ms` | int | for `wait` |

Key names are normalized: `enter`, `esc`, `space`, `ctrl`, `alt`, `shift`, `meta`/`cmd`/`win`, `f1`..`f12`, arrows, etc., mapped to `nut-js` `Key` enum.

## Security

- Every non-screenshot action hits the permission system with `permission: "computer"` and patterns `[action, "action:x,y", "computer"]`. The UI should show the pending screenshot so the user can visually approve.
- `deniedActions` always wins — use it to block risky actions (e.g. `["key"]` if you don't want hotkeys).
- Unlike browser-only automation, this controls the whole OS. Prefer `requireApproval: true` (default).

## Windows notes

- Screenshots: `screenshot-desktop` works best. Fallback uses PowerShell `System.Drawing` + `System.Windows.Forms` (no extra deps).
- Input: `@nut-tree/nut-js` uses Win32 `SendInput`; test HiDPI scaling — capture at physical pixels but model may send logical pixels. Adjust `scaleFactor` if clicks drift.
- Latency: budget 5–15s per action (screenshot + model call). The loop is intentionally one action per tool call.

## Future / built-in path

For first-class Electron integration (desktopCapturer, live overlay, fail-safe corner, hotkey takeover) see `plans/computer-use.md` — this plugin is the fastest way to ship without core/desktop changes.
