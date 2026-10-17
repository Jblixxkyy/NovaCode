# Computer Use / Camera / Screen — Build Plan

> Status: proposal · Scope: ~6 weeks for v1 · Target: macOS + Windows desktop

The goal is to let the agent see the user's screen, see the camera, and act on the desktop. This plan splits into **scope decisions**, **architecture**, **phases**, and **risks**.

## 1. Scope decisions to make first

These determine the architecture. Pick before writing code.

| Decision | Options | Tradeoff |
|---|---|---|
| **Target OS** | macOS only / macOS+Win / cross-platform | Win/macOS only is realistic in v1. Linux needs Xvfb/Wayland work. |
| **Where it runs** | Inside `packages/desktop` (Electron has native APIs) / paired-node protocol like OpenClaw | Electron-internal is fastest. Paired-node is more flexible but a 3-month project. |
| **Provider of model capability** | Anthropic `computer-use` tool / OpenAI `computer-use-preview` / OpenComputer / screen-only (no actuation) | Start with Anthropic + OpenAI computer-use APIs; the model drives the loop. |
| **What to expose to agent** | Just `screen` / `screen + camera` / full `computer` (screen + camera + mouse + keyboard) | Full computer in v1 if you have time; screen+camera-only is a safer MVP. |
| **Permission model** | Always ask per action / session-scoped allow / always allow | Per-action ask is the opencode ethos (matches existing `permission/` module). |
| **Sandboxing** | Run on host / OS sandbox / container | Start host-only with strong permission gates, like OpenClaw does pre-Crabbox. |

**Recommendation:** v1 = **macOS + Windows desktop, full computer (screen + camera + input), always-ask per action, Anthropic + OpenAI computer-use providers.** Skip Linux for v1.

## 2. Architecture (fits existing layout)

```
packages/novacode/src/
  computer/
    index.ts          # ComputerService, exported via module pattern
    screen.ts         # screenshot capture
    camera.ts         # webcam capture
    input.ts          # mouse + keyboard synthesis
    provider.ts       # provider abstraction (anthropic, openai, future)
    permission.ts     # per-action approval flow (reuses existing permission module)
    loop.ts           # action -> execute -> observe -> next action
    types.ts          # ComputerAction, ComputerObservation, etc.
packages/desktop/
  electron-main/      # native bridge: desktopCapturer, getUserMedia, nut-js
  preload/            # exposes bridge to renderer
  src/computer/       # renderer-side UI: permission prompt with screenshot, live preview overlay
packages/llm/src/provider/
  anthropic.ts        # wire computer-use tool call
  openai.ts           # wire computer-use-preview tool call
packages/protocol/src/
  computer.ts         # protocol types shared client <-> server
```

The Electron main process does the actual capture/synthesis because it has full OS access without the browser security prompt loop. Renderer sends a `computer.act({...})` request; server routes to Electron via the existing `control-plane`; Electron performs the action and returns observation.

## 3. Provider integration

Both Anthropic and OpenAI expose computer-use as a tool call.

**Anthropic** — model returns `tool_use` blocks with actions: `screenshot`, `left_click`, `type`, `key`, `scroll`, `wait`. The harness executes and feeds the resulting screenshot back as a `tool_result` with an image.

**OpenAI** — same shape, `computer_use_preview` tool, actions: `click`, `type`, `keypress`, `screenshot`, `scroll`, `wait`, `zoom`.

Build a `ComputerProvider` interface so more can be added later (UI-TARS, OpenComputer):

```ts
export interface ComputerProvider {
  id: "anthropic" | "openai"
  parseAction(toolCall: unknown): ComputerAction
  formatObservation(obs: ComputerObservation): unknown
}
```

Tool registration in `packages/novacode/src/tool/` adds `computer` as a built-in tool, gated by config flag `experimental.computer_use: true`.

## 4. Screen capture

**macOS + Windows:** Electron's `desktopCapturer.getSources({ types: ["screen"] })`. Returns a `MediaStream`; draw one frame to a canvas; export as PNG.

```ts
// electron-main/computer/screen.ts
const sources = await desktopCapturer.getSources({ types: ["screen"] })
const stream = await navigator.mediaDevices.getUserMedia({
  video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sources[0].id } }
})
// draw one frame, return PNG buffer
```

**Multi-monitor:** iterate sources, return array; let model pick by display id.

**Performance:** capture at model-native resolution. Don't re-encode — pass PNG through to provider's `image` block directly.

## 5. Camera capture

Same Electron pattern but `video: true` with `getUserMedia`. One-shot photo capture:

```ts
const stream = await navigator.mediaDevices.getUserMedia({ video: true })
const track = stream.getVideoTracks()[0]
const imageCapture = new ImageCapture(track)
const bitmap = await imageCapture.grabFrame()
```

Wire as `computer.camera.snap()`. Camera frames attach to the same `computer` tool as auxiliary inputs.

## 6. Input synthesis

**macOS:** AppleScript via `osascript` (slow, no deps) or `@nut-tree/nut-js` (Node-native, fast, MIT). **Use nut-js.**

**Windows:** nut-js handles Win32 via WinAPI. **Same dep.**

**Keyboard layout:** nut-js handles layout correctly only via its keymap system. Test carefully.

```ts
// nut-js
await mouse.setPosition(new Point(x, y))
await mouse.click(Button.LEFT)
await keyboard.type("hello")
await keyboard.press(Key.Enter)
```

**Fail-safe corner:** if the mouse moves to a screen corner, abort. Matches Anthropic's safety guidance.

## 7. Permission model

Reuse `packages/novacode/src/permission/` exactly the way other tools do. Each `computer.act` call hits `PermissionNext.ask` with:

```ts
{
  type: "computer",
  action: { kind: "click", x: 1024, y: 768, button: "left" },
  screenshot: <PNG bytes>,  // show user what's about to be clicked
}
```

The permission UI lives in `packages/desktop/src/` and renders the screenshot overlay so the user can approve/deny visually. Match the existing desktop permission dialog style — there's already a toast/dialog surface.

Add a config block:

```ts
experimental: {
  computer_use: {
    enabled: true,
    allowed_actions: ["screenshot", "left_click", "type", "key", "scroll"], // empty = all
    denied_actions: [],  // always wins
    require_approval: "always" | "session" | "never",
    max_actions_per_turn: 50,
  }
}
```

Mirror OpenClaw's `gateway.nodes.commands.allow`/`deny` pattern. Deny always wins.

## 8. Provider wiring detail

**Anthropic** in `packages/llm/src/provider/anthropic.ts`:
- When `model.capabilities.computer_use` is true and config flag is on, add the `computer` tool with Anthropic's tool schema.
- On `tool_use` with name=`computer`, route to `ComputerService.execute(parsedAction)`.
- Return the screenshot as a `tool_result` block: `type: "image"`, source `{"type": "base64", "media_type": "image/png", "data": "..."}`.
- Loop until model returns `end_turn`.

**OpenAI** in same dir:
- Add `computer-use-preview` tool with OpenAI's action schema.
- Map response `output` items to `ComputerAction`.
- Same loop.

The loop itself lives in `packages/novacode/src/computer/loop.ts` — a small `while (!done) { action = await nextAction(); obs = await execute(action); ... }`. ~80 lines.

## 9. UX additions worth shipping

- **Live overlay window** in desktop showing the model's current screen view + next planned action.
- **Action log** in the session transcript — every `computer.act` rendered as a step card with thumbnail before/after.
- **"Take over" hotkey** (e.g. `Ctrl+Shift+F10`) — user takes manual control mid-loop; model pauses until released.
- **Cancel button** in overlay — abort the loop immediately.
- **Fail-safe corner** as mentioned.
- **Indicator dot** in the desktop app when computer-use is active, so the user can't forget it's running.

## 10. Phase plan

**Phase 1 — Screen + permission + Anthropic computer-use (2 weeks)**
- `computer/screen.ts` (Electron desktopCapturer)
- `permission` wiring with screenshot-in-prompt UI
- Anthropic provider hook
- Loop in `computer/loop.ts`
- Test on a real macOS desktop app

**Phase 2 — Input synthesis + cross-platform (2 weeks)**
- nut-js for click/type/key/scroll
- Fail-safe corner
- Cancel hotkey
- Windows testing

**Phase 3 — OpenAI computer-use + camera (1 week)**
- OpenAI provider hook
- `computer/camera.ts`
- `computer.camera.snap()` tool call

**Phase 4 — Polish (1 week)**
- Live overlay window
- Action log in transcript
- Per-action config schema (allow/deny lists)
- Docs page at `packages/web/src/content/docs/computer.mdx`

**Total: ~6 weeks for a credible v1.**

## 11. Risks / things to watch

- **Latency.** Computer-use loops are slow — each turn is one screenshot + one model call. Budget 5–15s per action. TUI must show a "thinking… next action: click at (1024, 768)" indicator.
- **Resolution mismatch.** Anthropic expects specific dimensions (e.g. 1280x720 or 1456x819). Capture at model-native res; don't scale.
- **Coordinate drift on HiDPI.** Capture at physical pixels, send as logical (CSS) pixels — or vice versa. Pick one and test.
- **Keychain / password prompts.** The agent will hit OS password prompts it can't see. Build a "stuck" detector that bails after N identical screenshots.
- **Rate limiting / runaway loops.** Add `max_actions_per_turn` (50) and `max_total_actions_per_session` (500) — matches OpenClaw's runaway-loop protection.
- **Linux.** Defer until v2; X11 is doable, Wayland needs PipeWire portal negotiation.

## 12. The single most important decision

**Don't ship camera/input synthesis without the permission UI showing a screenshot of what's about to be clicked.** That visual approval is the difference between a tool people trust and a tool they uninstall. Anthropic got this right; copy it.

## 13. Phase 1 starting point

Begin with:
- `packages/novacode/src/computer/types.ts` — `ComputerAction`, `ComputerObservation`, provider enum
- `packages/novacode/src/computer/screen.ts` — Electron-side capture wrapper
- `packages/llm/src/provider/anthropic.ts` — wire `computer-use` tool when model supports it
- Stub `permission` integration that reuses existing `permission-next` flow
- Demo: agent books a calendar slot in a browser end-to-end