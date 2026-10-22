import { Browser } from "@novacode-ai/browser/rpc"
import type { BrowserDesktop } from "@novacode-ai/browser/desktop"
import type { CdpSession } from "./cdp"

/**
 * Executes desktop-tunnel actions against webview tabs through CDP.
 *
 * This module is deliberately Electron-free: tabs are structural
 * PageContents handles, so the whole action surface is unit-testable
 * headlessly with fakes. tabs.ts provides the real WebContents-backed
 * implementation. Behavior mirrors packages/browser's Playwright driver
 * (same snapshot format, same ref registry, same semantics) so the model
 * cannot tell which backend served a call.
 */

export type DesktopAction = BrowserDesktop.DesktopAction

export class DesktopUnsupportedError extends Error {
  constructor(action: string) {
    super(`The desktop browser does not support ${action} yet.`)
    this.name = "DesktopUnsupportedError"
  }
}

export interface PageContents {
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): Promise<void>
  /** Resolves when the current load finishes (or immediately when idle). */
  onceLoaded(timeoutMs: number): Promise<void>
  getViewportSize(): { width: number; height: number }
  /**
   * Capture the tab's current frame. Unlike CDP Page.captureScreenshot
   * this resolves for views that have never been presented in a window.
   */
  capturePage(): Promise<{ toPNG(): Uint8Array }>
  readonly cdp: CdpSession
}

export interface TabHandle {
  readonly id: string
  readonly contents: PageContents
  generation: number
  loadError?: string
  /** Latest favicon URL reported by the page (desktop tabs only). */
  favicon?: string
  /** Restored tab whose first load is deferred until activation. */
  pendingURL?: string
  boxes: Map<string, { x: number; y: number; width: number; height: number }>
}

export interface TabInventory {
  list(scope: string): TabHandle[]
  focusedID(scope: string): string | null
  get(scope: string, tabID: string): TabHandle | undefined
  open(scope: string, url: string | undefined, focus: boolean): Promise<TabHandle>
  focus(scope: string, tabID: string): TabHandle | undefined
  close(scope: string, tabID: string): Promise<void>
}

export function tabOf(handle: TabHandle): Browser.Tab {
  const contents = handle.contents
  return {
    id: handle.id as Browser.TabID,
    url: contents.getURL() || handle.pendingURL || "about:blank",
    title: contents.getTitle() || contents.getURL() || handle.pendingURL || "about:blank",
    ...(handle.favicon ? { favicon: handle.favicon } : {}),
    loading: contents.isLoading(),
    ...(handle.loadError ? { loadError: handle.loadError } : {}),
    canGoBack: contents.canGoBack(),
    canGoForward: contents.canGoForward(),
    generation: handle.generation,
  }
}

export function stateOf(inventory: TabInventory, scope: string): Browser.State {
  return {
    tabs: inventory.list(scope).map(tabOf),
    focusedTabID: (inventory.focusedID(scope) ?? null) as Browser.TabID | null,
  }
}

function requireTab(inventory: TabInventory, scope: string, tabID: string): TabHandle {
  const handle = inventory.get(scope, tabID)
  if (!handle) throw new Error(`Unknown tab ${tabID}. List tabs with browser.tabs.list first.`)
  return handle
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

// ---------------------------------------------------------------------------
// Snapshot formatting (mirrors packages/browser/src/session.ts exactly)
// ---------------------------------------------------------------------------

export interface AXNodeLike {
  nodeId: string
  role?: { value: string }
  name?: { value: string }
  value?: { value: unknown }
  properties?: Array<{ name: string; value?: { value: unknown } }>
  childIds?: string[]
  backendDOMNodeId?: number
}

export function nodeDepth(nodes: AXNodeLike[], node: AXNodeLike): number {
  const parents = new Map<string, string>()
  for (const candidate of nodes) for (const child of candidate.childIds ?? []) parents.set(child, candidate.nodeId)
  let depth = 0
  let current = parents.get(node.nodeId)
  while (current !== undefined && depth < 100) {
    depth += 1
    current = parents.get(current)
  }
  return depth
}

/** Pure snapshot line formatting; refs are assigned in tree order. */
export function formatSnapshot(nodes: AXNodeLike[], maxDepth: number): { lines: string[]; refs: Map<string, number> } {
  const lines: string[] = []
  const refs = new Map<string, number>()
  let counter = 0
  for (const node of nodes) {
    const depth = nodeDepth(nodes, node)
    if (depth > maxDepth) continue
    if (!node.backendDOMNodeId) continue
    counter += 1
    const ref = `e${counter}`
    refs.set(ref, node.backendDOMNodeId)
    const parts = [`- ${node.role?.value ?? "unknown"}`]
    if (node.name?.value) parts.push(`"${truncate(node.name.value, 120)}"`)
    if (node.value?.value !== undefined && node.value.value !== "")
      parts.push(`[value="${truncate(String(node.value.value), 80)}"]`)
    for (const prop of node.properties ?? []) {
      if (
        (prop.name === "checked" || prop.name === "expanded" || prop.name === "selected" || prop.name === "disabled") &&
        prop.value?.value === true
      )
        parts.push(`[${prop.name}]`)
    }
    parts.push(`[ref=${ref}]`)
    lines.push(`${"  ".repeat(depth)}${parts.join(" ")}`)
  }
  return { lines, refs }
}

// ---------------------------------------------------------------------------
// Keyboard (CDP Input.dispatchKeyEvent)
// ---------------------------------------------------------------------------

const NAMED_KEYS: Record<string, { key: string; code: string; virtualKeyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", virtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", virtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", virtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", virtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", virtualKeyCode: 46 },
  Insert: { key: "Insert", code: "Insert", virtualKeyCode: 45 },
  Home: { key: "Home", code: "Home", virtualKeyCode: 36 },
  End: { key: "End", code: "End", virtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", virtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", virtualKeyCode: 34 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 },
  " ": { key: " ", code: "Space", virtualKeyCode: 32 },
  Space: { key: " ", code: "Space", virtualKeyCode: 32 },
}

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

export interface KeyEventSpec {
  key: string
  code: string
  virtualKeyCode: number
  modifiers: number
  text?: string
}

/** Parse a Playwright-style key or chord ("Enter", "a", "Control+A") into a CDP key event. */
export function keyEventFor(input: string): KeyEventSpec {
  const parts = input.split("+")
  const name = parts[parts.length - 1]!
  let modifiers = 0
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIER_BITS[part]
    if (bit === undefined) throw new Error(`Unknown key modifier "${part}" in "${input}".`)
    modifiers |= bit
  }
  const named = NAMED_KEYS[name]
  if (named) return { ...named, modifiers }
  if (/^F([1-9]|1[0-2])$/.test(name))
    return { key: name, code: name, virtualKeyCode: 111 + Number(name.slice(1)), modifiers }
  if (name.length === 1) {
    const upper = name.toUpperCase()
    const isLetter = upper >= "A" && upper <= "Z"
    return {
      key: name,
      code: isLetter ? `Key${upper}` : name,
      virtualKeyCode: isLetter ? upper.charCodeAt(0) : name.charCodeAt(0),
      modifiers,
      // Printable characters only produce text when no command modifier is held.
      ...(modifiers & (MODIFIER_BITS.Control! | MODIFIER_BITS.Meta! | MODIFIER_BITS.Alt!) ? {} : { text: name }),
    }
  }
  throw new Error(`Unknown key "${name}". Use a named key (Enter, Tab, ArrowDown, ...) or a chord like Control+A.`)
}

export function modifierMask(modifiers: ReadonlyArray<string> | undefined): number {
  let mask = 0
  for (const modifier of modifiers ?? []) mask |= MODIFIER_BITS[modifier] ?? 0
  return mask
}

// ---------------------------------------------------------------------------
// CDP helpers over a tab handle
// ---------------------------------------------------------------------------

function cleanRef(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref
}

async function resolveObjectID(handle: TabHandle, ref: string): Promise<string> {
  const id = cleanRef(ref)
  const result = (await handle.contents.cdp.send("Runtime.evaluate", {
    expression: `globalThis.__novacodeRefs?.get(${JSON.stringify(id)}) ?? null`,
    returnByValue: false,
  })) as { result?: { objectId?: string } }
  const objectId = result.result?.objectId
  if (!objectId)
    throw new Error(`Ref ${ref} is stale. Take a fresh browser.snapshot first.`)
  return objectId
}

async function callOnElement(handle: TabHandle, ref: string, functionDeclaration: string, args: unknown[] = []) {
  const objectId = await resolveObjectID(handle, ref)
  try {
    const result = (await handle.contents.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? "Element function failed")
    return result.result?.value
  } finally {
    await handle.contents.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {})
  }
}

async function elementCenter(handle: TabHandle, ref: string): Promise<{ x: number; y: number }> {
  const objectId = await resolveObjectID(handle, ref)
  try {
    await handle.contents.cdp.send("DOM.scrollIntoViewIfNeeded", { objectId }).catch(() => {})
    const quads = (await handle.contents.cdp.send("DOM.getContentQuads", { objectId })) as {
      quads?: number[][]
    }
    const quad = quads.quads?.[0]
    if (!quad || quad.length < 8) throw new Error(`Element ${ref} has no visible box. Take a fresh browser.snapshot first.`)
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!]
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
  } finally {
    await handle.contents.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {})
  }
}

async function mouseClick(
  handle: TabHandle,
  point: { x: number; y: number },
  options: { button?: string; count?: number; modifiers?: number } = {},
) {
  const cdp = handle.contents.cdp
  const base = {
    x: point.x,
    y: point.y,
    button: options.button ?? "left",
    modifiers: options.modifiers ?? 0,
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: options.count ?? 1 })
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: options.count ?? 1 })
}

async function evaluateScript(
  handle: TabHandle,
  script: string,
  ref?: string,
): Promise<unknown> {
  const cdp = handle.contents.cdp
  if (ref) {
    return callOnElement(
      handle,
      ref,
      `function() { const fn = (0, eval)("(" + ${JSON.stringify(script)} + ")"); return fn(this); }`,
    )
  }
  const trimmed = script.trim()
  const isFunction = /^\s*(async\s+)?function\b|^\s*\(.*?\)\s*=>|^\s*[a-zA-Z_$][\w$]*\s*=>/.test(trimmed)
  const result = (await cdp.send("Runtime.evaluate", {
    expression: isFunction ? `(${trimmed})()` : trimmed,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed")
  return result.result?.value ?? null
}

async function navigate(handle: TabHandle, rawUrl: string): Promise<Browser.Tab> {
  const action = Browser.normalizeAction({ type: "navigate", tabID: handle.id as Browser.TabID, url: rawUrl })
  if (action.type !== "navigate") throw new Error("URL normalization failed")
  handle.loadError = undefined
  try {
    await handle.contents.loadURL(action.url)
  } catch (error) {
    // Mirrors the Playwright driver: a failed load is reported on the tab,
    // not thrown, unless nothing loaded at all.
    handle.loadError = (error instanceof Error ? error.message : String(error)).slice(0, 2048)
  }
  handle.generation += 1
  return tabOf(handle)
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

export async function executeDesktopAction(
  inventory: TabInventory,
  scope: string,
  action: DesktopAction,
): Promise<unknown> {
  switch (action.type) {
    case "tabs.list":
      return stateOf(inventory, scope)
    case "tabs.open": {
      const normalized = Browser.normalizeAction(action)
      const url = normalized.type === "tabs.open" ? normalized.url : undefined
      const handle = await inventory.open(scope, url, action.focus ?? true)
      return tabOf(handle)
    }
    case "tabs.focus": {
      const handle = inventory.focus(scope, action.tabID)
      if (!handle) throw new Error(`Unknown tab ${action.tabID}. List tabs with browser.tabs.list first.`)
      return tabOf(handle)
    }
    case "tabs.close": {
      await inventory.close(scope, action.tabID)
      return stateOf(inventory, scope)
    }
    case "navigate":
      return navigate(requireTab(inventory, scope, action.tabID), action.url)
    case "back": {
      const handle = requireTab(inventory, scope, action.tabID)
      handle.contents.goBack()
      await handle.contents.onceLoaded(30_000).catch(() => {})
      handle.generation += 1
      return tabOf(handle)
    }
    case "forward": {
      const handle = requireTab(inventory, scope, action.tabID)
      handle.contents.goForward()
      await handle.contents.onceLoaded(30_000).catch(() => {})
      handle.generation += 1
      return tabOf(handle)
    }
    case "reload": {
      const handle = requireTab(inventory, scope, action.tabID)
      handle.contents.reload()
      await handle.contents.onceLoaded(30_000).catch(() => {})
      handle.generation += 1
      return tabOf(handle)
    }
    case "stop": {
      const handle = requireTab(inventory, scope, action.tabID)
      handle.contents.stop()
      return tabOf(handle)
    }
    case "frames": {
      const handle = requireTab(inventory, scope, action.tabID)
      // Phase 1 reports the main frame only; cross-frame snapshots are deferred.
      return { tab: tabOf(handle), frames: [{ id: "main", url: handle.contents.getURL(), name: "" }] }
    }
    case "snapshot": {
      const handle = requireTab(inventory, scope, action.tabID)
      const cdp = handle.contents.cdp
      const maxDepth = action.depth ?? 20
      const tree = (await cdp.send("Accessibility.getFullAXTree", { depth: action.depth })) as { nodes?: AXNodeLike[] }
      const nodes = tree.nodes ?? []
      const { lines, refs } = formatSnapshot(nodes, maxDepth)
      handle.boxes.clear()
      const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {}
      for (const [ref, backendNodeId] of refs) {
        try {
          const resolved = (await cdp.send("DOM.resolveNode", { backendNodeId })) as { object: { objectId: string } }
          await cdp.send("Runtime.callFunctionOn", {
            objectId: resolved.object.objectId,
            functionDeclaration: `function(ref) { (globalThis.__novacodeRefs = globalThis.__novacodeRefs || new Map()).set(ref, this) }`,
            arguments: [{ value: ref }],
          })
          if (action.boxes) {
            const box = (await cdp
              .send("DOM.getBoxModel", { backendNodeId })
              .catch(() => undefined)) as { model: { content: number[] } } | undefined
            const content = box?.model.content
            if (content && content.length >= 8) {
              const xs = [content[0]!, content[2]!, content[4]!, content[6]!]
              const ys = [content[1]!, content[3]!, content[5]!, content[7]!]
              const x = Math.min(...xs)
              const y = Math.min(...ys)
              const entry = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
              handle.boxes.set(ref, entry)
              boxes[ref] = entry
            }
          }
          await cdp.send("Runtime.releaseObject", { objectId: resolved.object.objectId })
        } catch {
          // Node vanished mid-snapshot; skip it.
        }
      }
      handle.generation += 1
      const content = lines.join("\n")
      const truncated = content.length > Browser.MAX_TEXT
      const result: BrowserDesktop.DesktopSnapshotResult = {
        tab: tabOf(handle),
        content: truncated ? content.slice(0, Browser.MAX_TEXT) : content,
        truncated,
        ...(action.boxes ? { boxes } : {}),
      }
      return result
    }
    case "evaluate": {
      const handle = requireTab(inventory, scope, action.tabID)
      const value = await evaluateScript(handle, action.script, action.ref)
      return { tab: tabOf(handle), value }
    }
    case "click": {
      const handle = requireTab(inventory, scope, action.tabID)
      const center = await elementCenter(handle, action.ref)
      await mouseClick(handle, center, {
        button: action.button ?? "left",
        count: action.count ?? 1,
        modifiers: modifierMask(action.modifiers),
      })
      if (handle.contents.isLoading()) await handle.contents.onceLoaded(5_000).catch(() => {})
      return tabOf(handle)
    }
    case "clickAtPoint": {
      const handle = requireTab(inventory, scope, action.tabID)
      await mouseClick(handle, { x: action.x, y: action.y })
      if (handle.contents.isLoading()) await handle.contents.onceLoaded(5_000).catch(() => {})
      return tabOf(handle)
    }
    case "hover": {
      const handle = requireTab(inventory, scope, action.tabID)
      const center = await elementCenter(handle, action.ref)
      await handle.contents.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y })
      return tabOf(handle)
    }
    case "fill": {
      const handle = requireTab(inventory, scope, action.tabID)
      await fillElement(handle, action.ref, action.text)
      return tabOf(handle)
    }
    case "fill_form": {
      const handle = requireTab(inventory, scope, action.tabID)
      for (const field of action.fields) {
        if (field.type === "text") await fillElement(handle, field.ref, field.value)
        else if (field.type === "select") await selectElement(handle, field.ref, field.values)
        else await checkElement(handle, field.ref, field.checked)
      }
      return tabOf(handle)
    }
    case "select": {
      const handle = requireTab(inventory, scope, action.tabID)
      await selectElement(handle, action.ref, action.values)
      return tabOf(handle)
    }
    case "check": {
      const handle = requireTab(inventory, scope, action.tabID)
      await checkElement(handle, action.ref, action.checked)
      return tabOf(handle)
    }
    case "press": {
      const handle = requireTab(inventory, scope, action.tabID)
      const spec = keyEventFor(action.key)
      const cdp = handle.contents.cdp
      const base = {
        key: spec.key,
        code: spec.code,
        windowsVirtualKeyCode: spec.virtualKeyCode,
        nativeVirtualKeyCode: spec.virtualKeyCode,
        modifiers: spec.modifiers,
      }
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(spec.text ? { text: spec.text } : {}) })
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
      return tabOf(handle)
    }
    case "scroll": {
      const handle = requireTab(inventory, scope, action.tabID)
      const size = handle.contents.getViewportSize()
      await handle.contents.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.floor(size.width / 2),
        y: Math.floor(size.height / 2),
        deltaX: action.deltaX ?? 0,
        deltaY: action.deltaY,
      })
      return tabOf(handle)
    }
    case "wait": {
      const handle = requireTab(inventory, scope, action.tabID)
      const timeout = action.timeoutMs ?? 10_000
      if (action.condition === "load") {
        await handle.contents.onceLoaded(timeout)
        return tabOf(handle)
      }
      if (!action.text) throw new Error(`wait condition "${action.condition}" requires text`)
      const needle = action.text.toLowerCase()
      const deadline = Date.now() + timeout
      for (;;) {
        const found = await evaluateScript(
          handle,
          `document.body ? document.body.innerText.toLowerCase().includes(${JSON.stringify(needle)}) : false`,
        ).catch(() => false)
        const satisfied = action.condition === "textGone" ? !found : Boolean(found)
        if (satisfied) return tabOf(handle)
        if (Date.now() > deadline) throw new Error("Wait timed out")
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    case "screenshot": {
      const handle = requireTab(inventory, scope, action.tabID)
      const format = action.format ?? "png"
      let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined
      if (action.ref) {
        const objectId = await resolveObjectID(handle, action.ref)
        try {
          const quads = (await handle.contents.cdp.send("DOM.getContentQuads", { objectId })) as { quads?: number[][] }
          const quad = quads.quads?.[0]
          if (!quad || quad.length < 8) throw new Error(`Element ${action.ref} has no visible box.`)
          const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!]
          const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
          clip = {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
            scale: 1,
          }
        } finally {
          await handle.contents.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {})
        }
      } else if (action.fullPage) {
        const metrics = (await handle.contents.cdp.send("Page.getLayoutMetrics", {})) as {
          cssContentSize?: { width: number; height: number }
          contentSize?: { width: number; height: number }
        }
        const size = metrics.cssContentSize ?? metrics.contentSize
        if (size) clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 }
      }
      const shot = (await handle.contents.cdp.send("Page.captureScreenshot", {
        format,
        ...(format !== "png" && action.quality !== undefined ? { quality: action.quality } : {}),
        ...(clip ? { clip } : {}),
        captureBeyondViewport: Boolean(action.fullPage),
      })) as { data: string }
      const result: BrowserDesktop.DesktopScreenshotResult = {
        tab: tabOf(handle),
        mime: `image/${format}`,
        data: shot.data,
      }
      return result
    }
    case "panelStill": {
      const handle = requireTab(inventory, scope, action.tabID)
      const result: BrowserDesktop.DesktopStillResult = { mime: "image/png", data: await captureStill(handle.contents) }
      return result
    }
    default:
      throw new DesktopUnsupportedError(action.type)
  }
}

const PANEL_STILL_CAPTURE_TIMEOUT_MS = 5_000

/**
 * Panel stills go through webContents.capturePage, never CDP
 * Page.captureScreenshot: a CDP capture waits for a compositor frame, and
 * a view that has never been presented never produces one — the call can
 * hang forever, and the panel cannot present the view until the server
 * returns state built from this still (deadlock). The race bound keeps a
 * wedged capture from stalling the host loop; the server treats a failed
 * still as "no screenshot".
 */
async function captureStill(contents: PageContents): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const image = await Promise.race([
      contents.capturePage(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Panel still capture timed out.")), PANEL_STILL_CAPTURE_TIMEOUT_MS)
      }),
    ])
    return Buffer.from(image.toPNG()).toString("base64")
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fillElement(handle: TabHandle, ref: string, text: string) {
  await callOnElement(
    handle,
    ref,
    `function() { this.focus(); if (typeof this.select === "function") this.select(); else { const selection = getSelection(); const range = document.createRange(); range.selectNodeContents(this); selection?.removeAllRanges(); selection?.addRange(range); } }`,
  )
  await handle.contents.cdp.send("Input.insertText", { text })
}

async function selectElement(handle: TabHandle, ref: string, values: ReadonlyArray<string>) {
  await callOnElement(
    handle,
    ref,
    `function(values) { const wanted = new Set(values); for (const option of this.options ?? []) option.selected = wanted.has(option.value); this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); }`,
    [[...values]],
  )
}

async function checkElement(handle: TabHandle, ref: string, checked: boolean) {
  await callOnElement(handle, ref, `function(wanted) { if (this.checked !== wanted) this.click(); }`, [checked])
}
