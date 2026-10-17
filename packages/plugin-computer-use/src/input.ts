import type { ComputerAction } from "./types.js"

export async function executeAction(action: ComputerAction): Promise<void> {
  if (action.action === "wait") {
    const ms = (action as any).ms ?? (action as any).duration_ms ?? 500
    await sleep(Math.max(0, Math.min(ms, 10_000)))
    return
  }
  if (action.action === "screenshot") return
  const nut = await loadNut()
  if (!nut) {
    if (action.action === "move") {
      await powershellMove(action.x, action.y)
      return
    }
    throw new Error(
      "Mouse/keyboard backend missing. Install `@nut-tree/nut-js`: `npm i @nut-tree/nut-js` (Windows/macOS). Screenshot-only mode still works without it. (move has PowerShell fallback, others require nut-js)",
    )
  }
  const { mouse, keyboard, Button, Key, Point } = nut

  switch (action.action) {
    case "move": {
      await mouse.setPosition(new Point(action.x, action.y))
      break
    }
    case "click": {
      await mouse.setPosition(new Point(action.x, action.y))
      await mouse.click(toButton(action.button, Button))
      break
    }
    case "double_click": {
      await mouse.setPosition(new Point(action.x, action.y))
      await mouse.doubleClick(toButton(action.button, Button))
      break
    }
    case "right_click": {
      await mouse.setPosition(new Point(action.x, action.y))
      await mouse.rightClick()
      break
    }
    case "drag": {
      if (action.path.length < 2) throw new Error("drag requires at least 2 points in path")
      const [start, ...rest] = action.path
      await mouse.setPosition(new Point(start.x, start.y))
      await mouse.pressButton(toButton(action.button, Button))
      for (const p of rest) {
        await mouse.setPosition(new Point(p.x, p.y))
        await sleep(20)
      }
      await mouse.releaseButton(toButton(action.button, Button))
      break
    }
    case "scroll": {
      // nut-js scroll: scrollUp/scrollDown/scrollLeft/scrollRight
      // Map scroll_y / delta_y to vertical scroll
      const dy = action.scroll_y ?? action.delta_y ?? 0
      const dx = action.scroll_x ?? action.delta_x ?? 0
      if (action.x !== undefined && action.y !== undefined) {
        await mouse.setPosition(new Point(action.x, action.y))
      }
      if (dy !== 0) {
        if (dy > 0) await mouse.scrollDown(Math.abs(dy))
        else await mouse.scrollUp(Math.abs(dy))
      }
      if (dx !== 0) {
        if (dx > 0) await mouse.scrollRight(Math.abs(dx))
        else await mouse.scrollLeft(Math.abs(dx))
      }
      break
    }
    case "type": {
      await keyboard.type(action.text)
      break
    }
    case "key":
    case "keypress": {
      const keys: string[] = (action as any).keys ?? []
      if (keys.length === 0) throw new Error("key/keys requires at least one key")
      // Single key or hotkey combo: press sequentially with modifiers held
      const mapped = keys.map((k) => toKey(k, Key))
      if (mapped.length === 1) {
        await keyboard.pressKey(mapped[0])
      } else {
        // Hold modifiers, press last key, release modifiers
        const mods = mapped.slice(0, -1)
        const main = mapped[mapped.length - 1]
        for (const m of mods) await keyboard.pressKey(m)
        await keyboard.pressKey(main)
        for (const m of mods.reverse()) await keyboard.releaseKey(m)
        // Note: if duplicates, nut-js handles idempotently; also handle case where Key mapping gave same value
      }
      // If legacy `text` provided with key (e.g. type via key), also type it
      const extra = (action as any).text as string | undefined
      if (extra) await keyboard.type(extra)
      break
    }
    default: {
      const _exhaustive: never = action
      throw new Error(`Unsupported action: ${String((_exhaustive as any)?.action)}`)
    }
  }
}

function toButton(
  button: string | undefined,
  Button: { LEFT: number; RIGHT: number; MIDDLE: number; LEFT_MASK?: number },
): number {
  switch (button) {
    case "right":
      return Button.RIGHT
    case "middle":
      return Button.MIDDLE
    case "left":
    default:
      return Button.LEFT
  }
}

function toKey(raw: string, Key: Record<string, number>): number {
  const normalized = raw.trim()
  // Direct mapping for common names; nut-js Key enum is PascalCase
  const candidates = [
    normalized,
    normalized.toUpperCase(),
    capitalize(normalized),
    `Key${normalized.toUpperCase()}`,
  ]
  for (const c of candidates) {
    if (c in Key) return (Key as any)[c]
  }
  // Alias table
  const aliases: Record<string, string> = {
    enter: "Enter",
    return: "Enter",
    esc: "Escape",
    escape: "Escape",
    space: "Space",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    ctrl: "LeftControl",
    control: "LeftControl",
    alt: "LeftAlt",
    shift: "LeftShift",
    meta: "LeftSuper",
    cmd: "LeftSuper",
    command: "LeftSuper",
    super: "LeftSuper",
    win: "LeftSuper",
    f1: "F1",
    f2: "F2",
    f3: "F3",
    f4: "F4",
    f5: "F5",
    f6: "F6",
    f7: "F7",
    f8: "F8",
    f9: "F9",
    f10: "F10",
    f11: "F11",
    f12: "F12",
    pagedown: "PageDown",
    pageup: "PageUp",
    home: "Home",
    end: "End",
    insert: "Insert",
    caps_lock: "CapsLock",
  }
  const lower = normalized.toLowerCase()
  if (aliases[lower] && aliases[lower] in Key) return (Key as any)[aliases[lower]]
  // Single char: map to its letter key (A-Z, 0-9)
  if (lower.length === 1) {
    const upper = lower.toUpperCase()
    if (upper in Key) return (Key as any)[upper]
  }
  throw new Error(`Unknown key: "${raw}" (tried ${candidates.join(", ")})`)
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

async function loadNut(): Promise<any | null> {
  try {
    // @ts-ignore — optional dep
    return await import("@nut-tree/nut-js")
  } catch {
    return null
  }
}

function powershellMove(x: number, y: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const { spawn } = require("node:child_process")
    const ps = spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})`,
    ], { windowsHide: true })
    let err = ""
    ps.stderr.on("data", (d: Buffer) => (err += d.toString()))
    ps.on("error", reject)
    ps.on("close", (code: number) => {
      if (code !== 0) reject(new Error(`PowerShell move failed (${code}): ${err}`))
      else resolve()
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
