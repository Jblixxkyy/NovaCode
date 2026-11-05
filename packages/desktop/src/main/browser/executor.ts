import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Browser } from "@novacode-ai/browser/rpc"
import { BrowserCapture } from "@novacode-ai/browser/capture"
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
  /** Console/network/dialog capture buffers, wired lazily by ensureCapture. */
  capture?: BrowserCapture.TabCapture
  captureReady?: Promise<void>
  /** In-flight trace recording (Tracing.dataCollected chunks accumulate here). */
  trace?: {
    chunks: unknown[]
    startedAt: number
    onData: (params: Record<string, unknown>) => void
    timer: ReturnType<typeof setTimeout>
  }
  /** A trace that hit its duration bound and waits for trace.stop to collect it. */
  traceResult?: { chunks: unknown[]; durationMs: number; incomplete: boolean }
  cpu?: { startedAt: number; timer: ReturnType<typeof setTimeout> }
  cpuResult?: { profile: unknown; durationMs: number }
  /** CDP Overlay inspect mode is engaged on this tab. */
  inspecting?: boolean
  inspectWired?: boolean
  /** Backend node id per snapshot ref, so actions can resolve refs on demand. */
  refBackendIds?: Map<string, number>
  boxes: Map<string, { x: number; y: number; width: number; height: number }>
}

/** End a running trace and stash its chunks for trace.stop (also the auto-stop path). */
async function finishTrace(handle: TabHandle): Promise<void> {
  const trace = handle.trace
  if (!trace) return
  handle.trace = undefined
  clearTimeout(trace.timer)
  const cdp = handle.contents.cdp
  let incomplete = false
  const done = new Promise<void>((resolve) => {
    const onComplete = () => {
      cdp.off("Tracing.tracingComplete", onComplete)
      resolve()
    }
    cdp.on("Tracing.tracingComplete", onComplete)
    setTimeout(resolve, 10_000).unref?.()
  })
  await cdp.send("Tracing.end").catch(() => {
    incomplete = true
  })
  await done
  cdp.off("Tracing.dataCollected", trace.onData)
  handle.traceResult = { chunks: trace.chunks, durationMs: Date.now() - trace.startedAt, incomplete }
}

/** Stop CPU sampling and stash the profile for cpu.stop (also the auto-stop path). */
async function finishCpu(handle: TabHandle): Promise<void> {
  const cpu = handle.cpu
  if (!cpu) return
  handle.cpu = undefined
  clearTimeout(cpu.timer)
  const result = (await handle.contents.cdp.send("Profiler.stop")) as { profile: unknown }
  handle.cpuResult = { profile: result.profile, durationMs: Date.now() - cpu.startedAt }
}

/**
 * One persistent Electron session partition per Location scope, so cookies
 * and site storage stay isolated per project. The pre-phase-2 shared
 * partition's data does not migrate: scopes start with fresh jars.
 */
export function partitionFor(scope: string): string {
  if (!scope) return "persist:novacode-browser"
  return `persist:novacode-browser-${createHash("sha256").update(scope).digest("hex").slice(0, 16)}`
}

/**
 * Wire CDP console/network/dialog capture for a tab (idempotent). Called
 * when a tab is created and again defensively before capture-backed
 * actions, so popup tabs created outside the executor are covered too.
 */
export async function ensureCapture(handle: TabHandle): Promise<BrowserCapture.TabCapture> {
  if (!handle.capture) handle.capture = BrowserCapture.createCapture()
  if (!handle.captureReady) handle.captureReady = BrowserCapture.wireCapture(handle.contents.cdp, handle.capture)
  await handle.captureReady
  return handle.capture
}

export interface TabInventory {
  list(scope: string): TabHandle[]
  focusedID(scope: string): string | null
  get(scope: string, tabID: string): TabHandle | undefined
  open(scope: string, url: string | undefined, focus: boolean): Promise<TabHandle>
  focus(scope: string, tabID: string): TabHandle | undefined
  close(scope: string, tabID: string): Promise<void>
  /**
   * Optional domain-ACL gate (browser-acl.json, delivered with the tunnel
   * attachment): throws when a navigation target is denied. The real tab
   * manager implements it; test inventories may omit it.
   */
  checkNavigation?(url: string): void
  /** Optional sink for live-inspect events (picks, cancellations) bound for the server. */
  inspectEvent?(scope: string, event: BrowserDesktop.InspectEvent): void
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

function parentMap(nodes: AXNodeLike[]): Map<string, string> {
  const parents = new Map<string, string>()
  for (const candidate of nodes) for (const child of candidate.childIds ?? []) parents.set(child, candidate.nodeId)
  return parents
}

function depthOf(parents: Map<string, string>, nodeId: string): number {
  let depth = 0
  let current = parents.get(nodeId)
  while (current !== undefined && depth < 100) {
    depth += 1
    current = parents.get(current)
  }
  return depth
}

export function nodeDepth(nodes: AXNodeLike[], node: AXNodeLike): number {
  return depthOf(parentMap(nodes), node.nodeId)
}

/** Pure snapshot line formatting; refs are assigned in tree order. */
export function formatSnapshot(nodes: AXNodeLike[], maxDepth: number): { lines: string[]; refs: Map<string, number> } {
  const lines: string[] = []
  const refs = new Map<string, number>()
  // Build the parent map once: resolving depth per node would rebuild it
  // every time, turning a snapshot into quadratic work on dense pages.
  const parents = parentMap(nodes)
  let counter = 0
  for (const node of nodes) {
    const depth = depthOf(parents, node.nodeId)
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
  if (objectId) return objectId
  // Not registered in the page yet: snapshots no longer register every ref
  // up front (3 CDP round trips per node on every snapshot), so resolve
  // this one on demand from the last snapshot's backend node id.
  const backendNodeId = handle.refBackendIds?.get(id)
  if (backendNodeId === undefined)
    throw new Error(`Ref ${ref} is stale. Take a fresh browser.snapshot first.`)
  const resolved = (await handle.contents.cdp.send("DOM.resolveNode", { backendNodeId })) as {
    object: { objectId: string }
  }
  const resolvedId = resolved.object.objectId
  await handle.contents.cdp.send("Runtime.callFunctionOn", {
    objectId: resolvedId,
    functionDeclaration: `function(ref) { (globalThis.__novacodeRefs = globalThis.__novacodeRefs || new Map()).set(ref, this) }`,
    arguments: [{ value: id }],
  })
  return resolvedId
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

async function elementKind(
  handle: TabHandle,
  ref: string,
): Promise<{ tag: string; type: string | null }> {
  const value = (await callOnElement(
    handle,
    ref,
    `function() { return { tag: this.tagName ?? "", type: typeof this.getAttribute === "function" ? this.getAttribute("type") : null } }`,
  )) as { tag?: string; type?: string | null } | undefined
  return { tag: value?.tag ?? "", type: value?.type ?? null }
}

/**
 * Hand files to an <input type="file"> through the debugger. CDP's
 * DOM.setFileInputFiles needs real filesystem paths, so the delivered
 * bytes are staged in a temp dir on this machine (the desktop app and
 * its sidecar share the machine) and removed right after the call.
 */
async function setFileInputFiles(
  handle: TabHandle,
  ref: string,
  files: ReadonlyArray<{ name: string; data: string }>,
): Promise<void> {
  const objectId = await resolveObjectID(handle, ref)
  const dir = await mkdtemp(path.join(tmpdir(), "novacode-upload-"))
  try {
    const staged: string[] = []
    for (const [index, file] of files.entries()) {
      const name = path.basename(file.name).replace(/[^\w.\- ]/g, "_") || `file-${index}`
      const target = path.join(dir, `${index}-${name}`)
      await writeFile(target, Buffer.from(file.data, "base64"))
      staged.push(target)
    }
    await handle.contents.cdp.send("DOM.setFileInputFiles", { objectId, files: staged })
  } finally {
    await handle.contents.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
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

async function navigate(inventory: TabInventory, handle: TabHandle, rawUrl: string): Promise<Browser.Tab> {
  const action = Browser.normalizeAction({ type: "navigate", tabID: handle.id as Browser.TabID, url: rawUrl })
  if (action.type !== "navigate") throw new Error("URL normalization failed")
  // Same gate, same messages as the Playwright driver's navigate().
  inventory.checkNavigation?.(action.url)
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

/** Take an accessibility snapshot, (re)registering refs and optionally measuring boxes. */
async function takeSnapshot(
  handle: TabHandle,
  options: { depth?: number; boxes?: boolean },
): Promise<{
  content: string
  truncated: boolean
  boxes: Record<string, { x: number; y: number; width: number; height: number }>
  refsByBackend: Map<number, string>
}> {
  const cdp = handle.contents.cdp
  const maxDepth = options.depth ?? 20
  const tree = (await cdp.send("Accessibility.getFullAXTree", { depth: options.depth })) as { nodes?: AXNodeLike[] }
  const nodes = tree.nodes ?? []
  const { lines, refs } = formatSnapshot(nodes, maxDepth)
  // Remember which backend node each ref points at so actions can resolve
  // refs on demand. Registering every ref up front used to cost 3 CDP
  // round trips per node on every snapshot; the Playwright driver still
  // registers eagerly, so its snapshots stay the slower path.
  handle.refBackendIds = refs
  handle.boxes.clear()
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {}
  if (options.boxes) {
    for (const [ref, backendNodeId] of refs) {
      try {
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
      } catch {
        // Node vanished mid-snapshot; skip it.
      }
    }
  }
  handle.generation += 1
  const content = lines.join("\n")
  const truncated = content.length > Browser.MAX_TEXT
  return {
    content: truncated ? content.slice(0, Browser.MAX_TEXT) : content,
    truncated,
    boxes,
    refsByBackend: new Map([...refs].map(([ref, backendNodeId]) => [backendNodeId, ref])),
  }
}

/** Overlay highlight shown while live inspect is engaged (accent-tinted box model). */
const INSPECT_HIGHLIGHT = {
  showInfo: true,
  showStyles: false,
  contentColor: { r: 76, g: 140, b: 246, a: 0.35 },
  paddingColor: { r: 76, g: 246, b: 140, a: 0.35 },
  borderColor: { r: 246, g: 200, b: 76, a: 0.6 },
  marginColor: { r: 246, g: 140, b: 76, a: 0.35 },
}

/**
 * Subscribe to Overlay inspect events for a tab (once). A pick resolves the
 * backend node to the same ref + box the snapshot machinery produces, so the
 * panel's comment flow cannot tell live picks from still-frame picks.
 * searchForNode exits inspect mode after one pick; the flag follows.
 */
function wireInspect(handle: TabHandle, emit: (event: BrowserDesktop.InspectEvent) => void): void {
  if (handle.inspectWired) return
  handle.inspectWired = true
  const cdp = handle.contents.cdp
  cdp.on("Overlay.inspectNodeRequested", (params) => {
    handle.inspecting = false
    const backendNodeId = params.backendNodeId
    if (typeof backendNodeId !== "number") return
    void (async () => {
      const snap = await takeSnapshot(handle, { boxes: true })
      const ref = snap.refsByBackend.get(backendNodeId)
      const box = ref ? snap.boxes[ref] : undefined
      if (ref && box) emit({ type: "picked", tabID: handle.id as Browser.TabID, ref, box })
    })().catch(() => {})
  })
  cdp.on("Overlay.inspectModeCanceled", () => {
    if (!handle.inspecting) return
    handle.inspecting = false
    emit({ type: "canceled", tabID: handle.id as Browser.TabID })
  })
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
      await ensureCapture(handle).catch(() => {})
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
      return navigate(inventory, requireTab(inventory, scope, action.tabID), action.url)
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
      const snap = await takeSnapshot(handle, { depth: action.depth, boxes: action.boxes })
      const result: BrowserDesktop.DesktopSnapshotResult = {
        tab: tabOf(handle),
        content: snap.content,
        truncated: snap.truncated,
        ...(action.boxes ? { boxes: snap.boxes } : {}),
      }
      return result
    }
    case "inspect.start": {
      const handle = requireTab(inventory, scope, action.tabID)
      const cdp = handle.contents.cdp
      await cdp.send("DOM.enable").catch(() => {})
      await cdp.send("Overlay.enable").catch(() => {})
      wireInspect(handle, (event) => inventory.inspectEvent?.(scope, event))
      await cdp.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: INSPECT_HIGHLIGHT,
      })
      handle.inspecting = true
      return tabOf(handle)
    }
    case "inspect.stop": {
      const handle = requireTab(inventory, scope, action.tabID)
      if (handle.inspecting) {
        handle.inspecting = false
        // CDP requires a highlight config even when disabling inspect mode.
        await handle.contents.cdp
          .send("Overlay.setInspectMode", { mode: "none", highlightConfig: INSPECT_HIGHLIGHT })
          .catch(() => {})
      }
      return tabOf(handle)
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
    case "drag": {
      const handle = requireTab(inventory, scope, action.tabID)
      const from = await elementCenter(handle, action.from)
      const to = await elementCenter(handle, action.to)
      const cdp = handle.contents.cdp
      // Mirror the Playwright driver's mouse path: move, press, 12
      // interpolated moves, release — enough steps for HTML5 drag sources
      // and range/slider inputs to track the gesture.
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y })
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: from.x,
        y: from.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      })
      const steps = 12
      for (let step = 1; step <= steps; step++) {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: from.x + ((to.x - from.x) * step) / steps,
          y: from.y + ((to.y - from.y) * step) / steps,
          button: "left",
          buttons: 1,
        })
      }
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: to.x,
        y: to.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      })
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
      if (action.maxWidth) {
        // The Playwright driver captures at a viewport resized to maxWidth;
        // the desktop equivalent scales the captured region instead, so the
        // user's live view is never resized. Either way the image comes
        // back at most maxWidth pixels wide.
        const baseWidth = clip ? clip.width : handle.contents.getViewportSize().width
        if (baseWidth > action.maxWidth) {
          const factor = action.maxWidth / baseWidth
          if (clip) clip = { ...clip, scale: clip.scale * factor }
          else {
            const size = handle.contents.getViewportSize()
            clip = { x: 0, y: 0, width: size.width, height: size.height, scale: factor }
          }
        }
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
    case "console": {
      const handle = requireTab(inventory, scope, action.tabID)
      const capture = await ensureCapture(handle)
      const minRank = BrowserCapture.severityRankOf(action.level ?? "debug")
      const messages = capture.console.filter((entry) => BrowserCapture.severityRankOf(entry.level) >= minRank)
      const limit = action.limit ?? 100
      return {
        tab: tabOf(handle),
        messages: messages.slice(-limit),
        truncated: messages.length > limit,
        dropped: capture.consoleDropped,
      }
    }
    case "network.list": {
      const handle = requireTab(inventory, scope, action.tabID)
      const capture = await ensureCapture(handle)
      let requests = capture.network.map((record) => record.request)
      if (action.urlContains) requests = requests.filter((request) => request.url.includes(action.urlContains!))
      if (action.resourceType) requests = requests.filter((request) => request.resourceType === action.resourceType)
      const limit = action.limit ?? 100
      return {
        tab: tabOf(handle),
        requests: requests.slice(-limit),
        truncated: requests.length > limit,
        dropped: capture.networkDropped,
      }
    }
    case "dialog": {
      const handle = requireTab(inventory, scope, action.tabID)
      const capture = await ensureCapture(handle)
      if (action.action === "get") return { tab: tabOf(handle), dialog: capture.dialog ?? null }
      if (!capture.dialogPending) throw new Error("No dialog is open in this tab.")
      await handle.contents.cdp.send("Page.handleJavaScriptDialog", {
        accept: action.action === "accept",
        ...(action.promptText !== undefined ? { promptText: action.promptText } : {}),
      })
      capture.dialogPending = false
      capture.dialog = undefined
      return { tab: tabOf(handle), dialog: null }
    }
    case "files.deliver": {
      const handle = requireTab(inventory, scope, action.tabID)
      const kind = await elementKind(handle, action.ref)
      const isFileInput = kind.tag === "INPUT" && kind.type === "file"
      if (action.mode === "upload") {
        if (!isFileInput)
          throw new Error(`browser.files.upload needs an <input type="file"> element; ${action.ref} is not one.`)
        await setFileInputFiles(handle, action.ref, action.files)
        return tabOf(handle)
      }
      // Drop: file inputs take the files directly (what a real OS drop on
      // them does); any other element gets the same synthetic DragEvent
      // sequence the Playwright driver dispatches in-page. CDP cannot
      // synthesize an OS-level file drag, so drop targets that only listen
      // for native drag data will not see these files.
      if (isFileInput) {
        await setFileInputFiles(handle, action.ref, action.files)
        return tabOf(handle)
      }
      await callOnElement(
        handle,
        action.ref,
        `function(files) {
          const dt = new DataTransfer()
          for (const f of files) {
            const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))
            dt.items.add(new File([bytes], f.name, { type: f.mime }))
          }
          for (const type of ["dragenter", "dragover", "drop"])
            this.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
        }`,
        [action.files],
      )
      return tabOf(handle)
    }
    case "trace.start": {
      const handle = requireTab(inventory, scope, action.tabID)
      if (handle.trace || handle.traceResult)
        throw new Error("A trace recording is already running for this tab.")
      const chunks: unknown[] = []
      const onData = (params: Record<string, unknown>) => {
        if (Array.isArray(params.value)) chunks.push(...params.value)
      }
      const cdp = handle.contents.cdp
      cdp.on("Tracing.dataCollected", onData)
      const bound = Math.min(action.durationMs ?? 30_000, 30_000)
      try {
        await cdp.send("Tracing.start", {
          categories: "devtools.timeline,v8.execute,blink.console,loading",
          options: "sampling-frequency=10000",
        })
      } catch (error) {
        cdp.off("Tracing.dataCollected", onData)
        throw new Error(`Cannot start trace: ${error instanceof Error ? error.message : String(error)}`)
      }
      const timer = setTimeout(() => void finishTrace(handle).catch(() => {}), bound)
      timer.unref?.()
      handle.trace = { chunks, startedAt: Date.now(), onData, timer }
      return { tab: tabOf(handle), recording: true }
    }
    case "trace.stop": {
      const handle = requireTab(inventory, scope, action.tabID)
      if (handle.trace) await finishTrace(handle)
      const result = handle.traceResult
      if (!result) throw new Error("No trace recording is running for this tab.")
      handle.traceResult = undefined
      const data = Buffer.from(JSON.stringify({ traceEvents: result.chunks }), "utf8")
      if (data.byteLength > Browser.MAX_FILE_BYTES)
        throw new Error("Trace exceeds the 5 MiB transfer limit. Record for a shorter duration.")
      return {
        tab: tabOf(handle),
        file: { name: `trace-${Date.now()}.json`, mime: "application/json", data: data.toString("base64") },
        durationMs: result.durationMs,
        incomplete: result.incomplete,
      }
    }
    case "cpu.start": {
      const handle = requireTab(inventory, scope, action.tabID)
      if (handle.cpu || handle.cpuResult) throw new Error("CPU sampling is already running for this tab.")
      const cdp = handle.contents.cdp
      await cdp.send("Profiler.enable").catch((error) => {
        throw new Error(`Cannot enable profiler: ${error instanceof Error ? error.message : String(error)}`)
      })
      await cdp.send("Profiler.setSamplingInterval", { interval: 100 }).catch(() => {})
      await cdp.send("Profiler.start").catch((error) => {
        throw new Error(`Cannot start CPU sampling: ${error instanceof Error ? error.message : String(error)}`)
      })
      const timer = setTimeout(() => void finishCpu(handle).catch(() => {}), 30_000)
      timer.unref?.()
      handle.cpu = { startedAt: Date.now(), timer }
      return { tab: tabOf(handle), recording: true }
    }
    case "cpu.stop": {
      const handle = requireTab(inventory, scope, action.tabID)
      if (handle.cpu) await finishCpu(handle).catch((error) => {
        throw new Error(`Cannot stop CPU sampling: ${error instanceof Error ? error.message : String(error)}`)
      })
      const result = handle.cpuResult
      if (!result) throw new Error("CPU sampling is not running for this tab.")
      handle.cpuResult = undefined
      return {
        tab: tabOf(handle),
        file: {
          name: `cpu-${Date.now()}.cpuprofile`,
          mime: "application/json",
          data: Buffer.from(JSON.stringify(result.profile), "utf8").toString("base64"),
        },
        durationMs: result.durationMs,
      }
    }
    case "heap.snapshot": {
      const handle = requireTab(inventory, scope, action.tabID)
      const cdp = handle.contents.cdp
      await cdp.send("HeapProfiler.enable").catch((error) => {
        throw new Error(`Cannot enable heap profiler: ${error instanceof Error ? error.message : String(error)}`)
      })
      const chunks: string[] = []
      const onChunk = (params: Record<string, unknown>) => chunks.push(String(params.chunk ?? ""))
      cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk)
      try {
        await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
      } catch (error) {
        throw new Error(`Heap snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk)
      }
      const data = Buffer.from(chunks.join(""), "utf8")
      if (data.byteLength > Browser.MAX_FILE_BYTES)
        throw new Error("Heap snapshot exceeds the 5 MiB transfer limit.")
      return {
        tab: tabOf(handle),
        file: { name: `heap-${Date.now()}.heapsnapshot`, mime: "application/json", data: data.toString("base64") },
      }
    }
    case "lighthouse": {
      const handle = requireTab(inventory, scope, action.tabID)
      const url = handle.contents.getURL()
      if (!/^https?:/.test(url)) throw new Error(`Lighthouse needs an http(s) page, got ${url}`)
      // Lighthouse needs a Chrome it can launch and drive over a debugging
      // port; an Electron WebContentsView exposes no such port, so the audit
      // runs against a standalone Chrome the user points the desktop at.
      const chromePath = process.env.NOVACODE_DESKTOP_LIGHTHOUSE_CHROME
      if (!chromePath)
        throw new Error(
          "Lighthouse is not available on desktop tabs in this build: an Electron webview exposes no remote-debugging port for Lighthouse to attach to. Set NOVACODE_DESKTOP_LIGHTHOUSE_CHROME to a Chrome/Chromium executable to run audits from the desktop, or run browser.lighthouse when no desktop is attached.",
        )
      const previousChromePath = process.env.CHROME_PATH
      process.env.CHROME_PATH = chromePath
      try {
        const { default: lighthouse } = await import("lighthouse")
        const result = (await lighthouse(url, {
          onlyCategories: ["accessibility", "best-practices", "seo"],
          output: ["json", "html"],
        })) as unknown as {
          lhr: {
            categories: Record<string, { id: string; title: string; score: number | null }>
            audits: Record<
              string,
              { id: string; title: string; description: string; score: number | null; scoreDisplayMode: string }
            >
          }
          report: [string, string]
        }
        return {
          tab: tabOf(handle),
          scores: Object.values(result.lhr.categories).map((category) => ({
            id: category.id,
            title: category.title,
            score: category.score,
          })),
          failures: Object.values(result.lhr.audits)
            .filter((audit) => audit.score !== null && audit.score < 0.9 && audit.scoreDisplayMode !== "notApplicable")
            .slice(0, 50)
            .map((audit) => ({ id: audit.id, title: audit.title, description: audit.description.slice(0, 2000) })),
          files: [
            {
              name: `lighthouse-${Date.now()}.json`,
              mime: "application/json",
              data: Buffer.from(result.report[0] ?? "{}", "utf8").toString("base64"),
            },
            {
              name: `lighthouse-${Date.now()}.html`,
              mime: "text/html",
              data: Buffer.from(result.report[1] ?? "", "utf8").toString("base64"),
            },
          ],
        }
      } catch (error) {
        throw new Error(`Lighthouse audit failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (previousChromePath === undefined) delete process.env.CHROME_PATH
        else process.env.CHROME_PATH = previousChromePath
      }
    }
    case "network.get": {
      const handle = requireTab(inventory, scope, action.tabID)
      const capture = await ensureCapture(handle)
      const record = capture.network.find((item) => item.request.id === action.id)
      if (!record) throw new Error(`Unknown request ${action.id}. List requests with browser.network.list first.`)
      const maxChars = action.maxBodyChars ?? 20_000
      return {
        tab: tabOf(handle),
        request: record.request,
        requestHeaders: [...record.requestHeaders],
        responseHeaders: [...record.responseHeaders],
        headersTruncated: record.requestHeaders.length >= 200 || record.responseHeaders.length >= 200,
        requestBody: BrowserCapture.bodyOf(record.postData, maxChars, action.includeBody ?? false),
        responseBody: await BrowserCapture.responseBodyOf(
          handle.contents.cdp,
          record,
          action.includeBody ?? false,
          maxChars,
        ),
      }
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
