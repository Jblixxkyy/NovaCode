import { mkdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import type { BrowserContext, CDPSession, Dialog, Download, ElementHandle, Frame, Page } from "playwright"
import { Browser } from "./rpc"
import { BrowserFiles } from "./files"
import { BrowserPermissions } from "./permissions"

export class BrowserError extends Schema.TaggedErrorClass<BrowserError>()("Browser.BrowserError", {
  message: Schema.String,
}) {
  static from(error: unknown, prefix: string): BrowserError {
    const detail = error instanceof Error ? error.message : String(error)
    return new BrowserError({ message: `${prefix}: ${detail}` })
  }
}

export interface DriverOptions {
  /** Persistent profile directory, e.g. <data>/browser-profile */
  readonly profileDir: string
  /** Directory for captures and downloads */
  readonly captureDir: string
  /** NovaCode config dir, for browser-acl.json */
  readonly configDir: string
  readonly headless?: boolean
}

interface TabRecord {
  readonly id: Browser.TabID
  readonly page: Page
  readonly context: BrowserContext
  generation: number
  title: string
  url: string
  loading: boolean
  loadError?: string
  focused: boolean
  console: Browser.ConsoleEntry[]
  consoleDropped: number
  network: NetworkRecord[]
  networkDropped: number
  cdp: CDPSession | undefined
  downloads: Browser.FileInfo[]
  captures: Browser.FileInfo[]
  trace: { chunks: unknown[]; startedAt: number; durationMs?: number } | undefined
  cpu: { startedAt: number } | undefined
  lastScreenshot: { mime: string; data: Uint8Array } | undefined
  dialog: { type: string; message: string; defaultValue: string } | undefined
  pendingDialog: Dialog | undefined
  /** Element ref -> CSS-pixel bounding box from the latest snapshot with boxes: true. */
  boxes: Map<string, { x: number; y: number; width: number; height: number }>
}

interface NetworkRecord {
  readonly request: Browser.NetworkRequest
  readonly requestHeaders: ReadonlyArray<{ name: string; value: string }>
  readonly responseHeaders: ReadonlyArray<{ name: string; value: string }>
  readonly requestBody: Browser.Body
  readonly responseBody: Browser.Body
  readonly postData?: string
}

const MAX_LOG_ENTRIES = 500
const DEFAULT_NAV_TIMEOUT = 30_000

/** Server-side Playwright driver implementing the 44 browser operations. */
export class Driver {
  private context: BrowserContext | undefined
  private tabs = new Map<Browser.TabID, TabRecord>()
  private focusedTabID: Browser.TabID | undefined
  private acl: BrowserPermissions.DomainACL = { allow: [], deny: [] }
  private recent: string[] = []
  private readonly options: Required<DriverOptions>

  constructor(options: DriverOptions) {
    this.options = { headless: true, ...options }
  }

  get launched(): boolean {
    return this.context !== undefined
  }

  async ready(): Promise<void> {
    if (!this.launched) await this.launch()
  }

  async launch(): Promise<void> {
    if (this.context) return
    this.acl = await BrowserPermissions.loadACL(this.options.configDir)
    const { chromium } = await import("playwright")
    await mkdir(this.options.profileDir, { recursive: true })
    await mkdir(this.options.captureDir, { recursive: true })
    try {
      this.context = await chromium.launchPersistentContext(this.options.profileDir, {
        headless: this.options.headless,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
      })
    } catch (error) {
      throw BrowserError.from(error, "Cannot launch Chromium (is the Playwright browser installed?)")
    }
    this.context.on("page", (page) => void this.watchPage(page).catch(() => {}))
    // Start from a clean slate: drop any pages the persistent profile restored.
    for (const page of this.context.pages()) await page.close().catch(() => {})
  }

  async dispose(): Promise<void> {
    for (const tab of this.tabs.values()) await tab.cdp?.detach().catch(() => {})
    this.tabs.clear()
    await this.context?.close().catch(() => {})
    this.context = undefined
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new BrowserError({ message: "Browser is not launched." })
    return this.context
  }

  private requireTab(tabID: string): TabRecord {
    const tab = this.tabs.get(tabID as Browser.TabID)
    if (!tab) throw new BrowserError({ message: `Unknown tab ${tabID}. List tabs with browser.tabs.list first.` })
    return tab
  }

  private async watchPage(page: Page): Promise<void> {
    // Attach console/network listeners to pages opened outside openTab (e.g. popups).
    const existing = [...this.tabs.values()].find((tab) => tab.page === page)
    if (existing) return
    const id = Browser.TabID.make(`tab_${crypto.randomUUID()}`)
    const tab = this.makeTab(id, page)
    this.tabs.set(id, tab)
    if (!this.focusedTabID) {
      this.focusedTabID = id
      tab.focused = true
    }
  }

  private makeTab(id: Browser.TabID, page: Page): TabRecord {
    const tab: TabRecord = {
      id,
      page,
      context: this.requireContext(),
      generation: 0,
      title: "",
      url: "about:blank",
      loading: false,
      focused: false,
      console: [],
      consoleDropped: 0,
      network: [],
      networkDropped: 0,
      cdp: undefined,
      downloads: [],
      captures: [],
      trace: undefined,
      cpu: undefined,
      lastScreenshot: undefined,
      dialog: undefined,
      pendingDialog: undefined,
      boxes: new Map(),
    }
    page.on("console", (message) => {
      const entry: Browser.ConsoleEntry = {
        id: `console_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        timestampMs: Date.now(),
        level: (["debug", "info", "warning", "error"] as const).includes(message.type() as never)
          ? (message.type() as Browser.ConsoleEntry["level"])
          : "info",
        text: message.text().slice(0, Browser.MAX_TEXT),
        textTruncated: message.text().length > Browser.MAX_TEXT,
        source: undefined,
      }
      const location = message.location()
      if (location.url)
        (entry as { source: unknown }).source = {
          url: location.url,
          line: location.lineNumber ?? 0,
          column: location.columnNumber ?? 0,
        }
      pushBounded(tab.console, entry, MAX_LOG_ENTRIES, () => (tab.consoleDropped += 1))
    })
    page.on("pageerror", (error) => {
      pushBounded(
        tab.console,
        {
          id: `pageerror_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
          timestampMs: Date.now(),
          level: "error",
          text: String(error?.stack ?? error).slice(0, Browser.MAX_TEXT),
          textTruncated: false,
          source: undefined,
        },
        MAX_LOG_ENTRIES,
        () => (tab.consoleDropped += 1),
      )
    })
    page.on("dialog", (dialog) => {
      tab.pendingDialog = dialog
      tab.dialog = { type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() }
    })
    page.on("download", (download) => this.registerDownload(page, download))
    page.on("load", () => {
      tab.loading = false
      tab.loadError = undefined
    })
    return tab
  }

  private async cdp(tab: TabRecord): Promise<CDPSession> {
    if (!tab.cdp) {
      tab.cdp = await tab.context.newCDPSession(tab.page)
      await tab.cdp.send("Network.enable")
      wireNetwork(tab, tab.cdp)
    }
    return tab.cdp
  }

  private toTab(tab: TabRecord): Browser.Tab {
    return {
      id: tab.id,
      url: tab.page.url(),
      title: tab.title || tab.page.url(),
      loading: tab.loading,
      loadError: tab.loadError,
      canGoBack: false,
      canGoForward: false,
      generation: tab.generation,
    }
  }

  private async refreshNavState(tab: TabRecord): Promise<Browser.Tab> {
    return this.toTab(tab)
  }

  state(): Browser.State {
    return {
      tabs: [...this.tabs.values()].map((tab) => this.toTab(tab)),
      focusedTabID: this.focusedTabID ?? null,
    }
  }

  async openTab(url: string | undefined, focus: boolean | undefined): Promise<Browser.Tab> {
    const context = this.requireContext()
    const page = await context.newPage().catch((error) => {
      throw BrowserError.from(error, "Cannot open tab")
    })
    // The context "page" event usually registers the tab via watchPage first; fall back to manual registration.
    let tab = [...this.tabs.values()].find((candidate) => candidate.page === page)
    if (!tab) {
      const id = Browser.TabID.make(`tab_${crypto.randomUUID()}`)
      tab = this.makeTab(id, page)
      this.tabs.set(id, tab)
    }
    // Attach CDP early so the first navigation's network traffic is captured.
    await this.cdp(tab).catch(() => {})
    if (focus ?? true) {
      if (this.focusedTabID) {
        const previous = this.tabs.get(this.focusedTabID)
        if (previous) previous.focused = false
      }
      this.focusedTabID = tab.id
      tab.focused = true
      await page.bringToFront().catch(() => {})
    }
    const target = url?.trim() || "about:blank"
    if (target !== "about:blank") {
      const action = Browser.normalizeAction({ type: "tabs.open", url: target })
      if (action.type === "tabs.open" && action.url) await this.navigate(tab.id, action.url)
    } else {
      await this.navigate(tab.id, "about:blank")
    }
    return this.toTab(tab)
  }

  async focusTab(tabID: string): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    if (this.focusedTabID && this.focusedTabID !== tab.id) {
      const previous = this.tabs.get(this.focusedTabID)
      if (previous) previous.focused = false
    }
    this.focusedTabID = tab.id
    tab.focused = true
    await tab.page.bringToFront().catch((error) => {
      throw BrowserError.from(error, "Cannot focus tab")
    })
    return this.toTab(tab)
  }

  async closeTab(tabID: string): Promise<Browser.State> {
    const tab = this.requireTab(tabID)
    await tab.cdp?.detach().catch(() => {})
    await tab.page.close().catch(() => {})
    this.tabs.delete(tab.id)
    if (this.focusedTabID === tab.id) {
      const next = [...this.tabs.values()].pop()
      this.focusedTabID = next?.id
      if (next) next.focused = true
    }
    return this.state()
  }

  async navigate(tabID: string, rawUrl: string): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const action = Browser.normalizeAction({ type: "navigate", tabID: tab.id, url: rawUrl })
    if (action.type !== "navigate") throw new BrowserError({ message: "URL normalization failed" })
    BrowserPermissions.checkDomain(action.url, this.acl)
    if (/^https?:/.test(action.url)) {
      this.recent = [action.url, ...this.recent.filter((url) => url !== action.url)].slice(0, 5)
    }
    tab.loading = true
    tab.loadError = undefined
    tab.generation += 1
    try {
      await tab.page.goto(action.url, { waitUntil: "load", timeout: DEFAULT_NAV_TIMEOUT })
      tab.loading = false
    } catch (error) {
      tab.loading = false
      tab.loadError = error instanceof Error ? error.message.slice(0, 2048) : String(error).slice(0, 2048)
    }
    try {
      tab.title = await tab.page.title()
    } catch {
      // ignore
    }
    return this.refreshNavState(tab)
  }

  async back(tabID: string): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    await tab.page.goBack({ waitUntil: "load", timeout: DEFAULT_NAV_TIMEOUT }).catch((error) => {
      throw BrowserError.from(error, "Cannot go back")
    })
    tab.generation += 1
    return this.refreshNavState(tab)
  }

  async forward(tabID: string): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    await tab.page.goForward({ waitUntil: "load", timeout: DEFAULT_NAV_TIMEOUT }).catch((error) => {
      throw BrowserError.from(error, "Cannot go forward")
    })
    tab.generation += 1
    return this.refreshNavState(tab)
  }

  async reload(tabID: string): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    await tab.page.reload({ waitUntil: "load", timeout: DEFAULT_NAV_TIMEOUT }).catch((error) => {
      throw BrowserError.from(error, "Cannot reload")
    })
    tab.generation += 1
    return this.refreshNavState(tab)
  }

  async stop(tabID: string): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    await tab.page.evaluate("window.stop()").catch(() => {})
    tab.loading = false
    return this.refreshNavState(tab)
  }

  async frames(tabID: string): Promise<{ tab: Browser.Tab; frames: Array<{ id: string; parentID?: string; url: string; name: string }> }> {
    const tab = this.requireTab(tabID)
    const frames = tab.page.frames().map((frame) => ({
      id: frameIdOf(frame),
      parentID: frame.parentFrame() ? frameIdOf(frame.parentFrame()!) : undefined,
      url: frame.url().slice(0, Browser.MAX_TEXT),
      name: frame.name().slice(0, 2048),
    }))
    return { tab: this.toTab(tab), frames }
  }

  private async frameFor(tab: TabRecord, frameID?: string): Promise<Frame> {
    if (!frameID) return tab.page.mainFrame()
    const frame = tab.page.frames().find((candidate) => frameIdOf(candidate) === frameID)
    if (!frame) throw new BrowserError({ message: `Unknown frame ${frameID}. List frames with browser.frames first.` })
    return frame
  }

  private cleanRef(ref: string): string {
    return ref.startsWith("@") ? ref.slice(1) : ref
  }

  private async resolveElement(frame: Frame, ref: string): Promise<ElementHandle> {
    const handle = await frame
      .evaluateHandle(
        (id) => (globalThis as unknown as { __novacodeRefs?: Map<string, Element> }).__novacodeRefs?.get(id) ?? null,
        this.cleanRef(ref),
      )
      .catch((error) => {
        throw BrowserError.from(error, `Cannot resolve ref ${ref}`)
      })
    const element = handle.asElement()
    if (!element) {
      await handle.dispose().catch(() => {})
      throw new BrowserError({ message: `Ref ${ref} is stale. Take a fresh browser.snapshot first.` })
    }
    return element
  }

  /** Render the accessibility tree and register element refs for later actions. */
  async snapshot(
    tabID: string,
    options?: { frameID?: string; ref?: string; depth?: number; boxes?: boolean },
  ): Promise<{ tab: Browser.Tab; content: string; truncated: boolean }> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab, options?.frameID)
    const session = await this.cdp(tab)
    const frameId = await cdpFrameId(session, frame).catch(() => undefined)
    const tree = await session
      .send("Accessibility.getFullAXTree", { ...(frameId ? { frameId } : {}), depth: options?.depth })
      .catch((error) => {
        throw BrowserError.from(error, "Cannot read accessibility tree")
      })
    const nodes = (tree.nodes ?? []) as AXNode[]
    const maxDepth = options?.depth ?? 20
    const lines: string[] = []
    let counter = 0
    const refs = new Map<string, number>()
    for (const node of nodes) {
      const depth = nodeDepth(nodes, node)
      if (depth > maxDepth) continue
      if (!node.backendDOMNodeId) continue
      counter += 1
      const ref = `e${counter}`
      refs.set(ref, node.backendDOMNodeId)
      const parts = [`- ${node.role?.value ?? "unknown"}`]
      if (node.name?.value) parts.push(`"${truncate(node.name.value, 120)}"`)
      if (node.value?.value !== undefined && node.value.value !== "") parts.push(`[value="${truncate(String(node.value.value), 80)}"]`)
      for (const prop of node.properties ?? []) {
        if ((prop.name === "checked" || prop.name === "expanded" || prop.name === "selected" || prop.name === "disabled") && prop.value?.value === true)
          parts.push(`[${prop.name}]`)
      }
      parts.push(`[ref=${ref}]`)
      lines.push(`${"  ".repeat(depth)}${parts.join(" ")}`)
    }
    // Register refs in the frame's window for later element resolution.
    tab.boxes.clear()
    for (const [ref, backendNodeId] of refs) {
      try {
        const resolved = (await session.send("DOM.resolveNode", { backendNodeId: backendNodeId })) as {
          object: { objectId: string }
        }
        await session.send("Runtime.callFunctionOn", {
          objectId: resolved.object.objectId,
          functionDeclaration: `function(ref) { (globalThis.__novacodeRefs = globalThis.__novacodeRefs || new Map()).set(ref, this) }`,
          arguments: [{ value: ref }],
        })
        if (options?.boxes) {
          const box = (await session.send("DOM.getBoxModel", { backendNodeId: backendNodeId }).catch(() => undefined)) as
            | { model: { content: number[] } }
            | undefined
          const content = box?.model.content
          if (content && content.length >= 8) {
            const xs = [content[0]!, content[2]!, content[4]!, content[6]!]
            const ys = [content[1]!, content[3]!, content[5]!, content[7]!]
            const x = Math.min(...xs)
            const y = Math.min(...ys)
            tab.boxes.set(ref, { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y })
          }
        }
        await session.send("Runtime.releaseObject", { objectId: resolved.object.objectId })
      } catch {
        // Node vanished mid-snapshot; skip it.
      }
    }
    tab.generation += 1
    const content = lines.join("\n")
    const truncated = content.length > Browser.MAX_TEXT
    return { tab: this.toTab(tab), content: truncated ? content.slice(0, Browser.MAX_TEXT) : content, truncated }
  }

  async find(
    tabID: string,
    options: { frameID?: string; text: string },
  ): Promise<{ tab: Browser.Tab; content: string; truncated: boolean }> {
    const result = await this.snapshot(tabID, { frameID: options.frameID })
    const needle = options.text.toLowerCase()
    const matching = result.content.split("\n").filter((line) => line.toLowerCase().includes(needle))
    const content = matching.join("\n")
    const truncated = content.length > Browser.MAX_TEXT
    return { tab: result.tab, content: truncated ? content.slice(0, Browser.MAX_TEXT) : content, truncated }
  }

  async evaluate(
    tabID: string,
    options: { frameID?: string; ref?: string; script: string },
  ): Promise<{ tab: Browser.Tab; value: unknown }> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab, options.frameID)
    let value: unknown
    try {
      if (options.ref) {
        const ref = this.cleanRef(options.ref)
        value = await frame.evaluate(
          `((id, script) => { const el = globalThis.__novacodeRefs?.get(id) ?? null; if (!el) throw new Error("Ref " + id + " is stale. Take a fresh browser.snapshot first."); return (0, eval)("(" + script + ")")(el); })(${JSON.stringify(ref)}, ${JSON.stringify(options.script)})`,
        )
      } else {
        const script = options.script.trim()
        const isFunction = /^\s*(async\s+)?function\b|^\s*\(.*?\)\s*=>|^\s*[a-zA-Z_$][\w$]*\s*=>/.test(script)
        value = await frame.evaluate(isFunction ? `(${script})()` : script)
      }
    } catch (error) {
      throw BrowserError.from(error, "Evaluate failed")
    }
    return { tab: this.toTab(tab), value: value ?? null }
  }

  async click(
    tabID: string,
    options: { ref: string; button?: "left" | "right" | "middle"; count?: 1 | 2; modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift"> },
  ): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab)
    const element = await this.resolveElement(frame, options.ref)
    try {
      await element.click({ button: options.button ?? "left", clickCount: options.count ?? 1, modifiers: options.modifiers })
    } catch (error) {
      throw BrowserError.from(error, `Click failed for ref ${options.ref}`)
    } finally {
      await element.dispose().catch(() => {})
    }
    return this.toTab(tab)
  }

  async hover(tabID: string, options: { ref: string }): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab)
    const element = await this.resolveElement(frame, options.ref)
    try {
      await element.hover()
    } catch (error) {
      throw BrowserError.from(error, `Hover failed for ref ${options.ref}`)
    } finally {
      await element.dispose().catch(() => {})
    }
    return this.toTab(tab)
  }

  async drag(tabID: string, options: { from: string; to: string }): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab)
    const from = await this.resolveElement(frame, options.from)
    const to = await this.resolveElement(frame, options.to)
    try {
      const fromBox = await from.boundingBox()
      const toBox = await to.boundingBox()
      if (!fromBox || !toBox) throw new Error("Could not measure drag endpoints")
      await tab.page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2)
      await tab.page.mouse.down()
      await tab.page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 12 })
      await tab.page.mouse.up()
    } catch (error) {
      throw BrowserError.from(error, "Drag failed")
    } finally {
      await from.dispose().catch(() => {})
      await to.dispose().catch(() => {})
    }
    return this.toTab(tab)
  }

  async fill(tabID: string, options: { ref: string; text: string }): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab)
    const element = await this.resolveElement(frame, options.ref)
    try {
      await element.fill(options.text)
    } catch (error) {
      throw BrowserError.from(error, `Fill failed for ref ${options.ref}`)
    } finally {
      await element.dispose().catch(() => {})
    }
    return this.toTab(tab)
  }

  async fillForm(
    tabID: string,
    options: {
      fields: ReadonlyArray<
        | { ref: string; type: "text"; value: string }
        | { ref: string; type: "select"; values: ReadonlyArray<string> }
        | { ref: string; type: "check"; checked: boolean }
      >
    },
  ): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab)
    for (const field of options.fields) {
      const element = await this.resolveElement(frame, field.ref)
      try {
        if (field.type === "text") await element.fill(field.value)
        else if (field.type === "select") await element.selectOption([...field.values])
        else await element.setChecked(field.checked)
      } catch (error) {
        throw BrowserError.from(error, `Fill form failed at ref ${field.ref}`)
      } finally {
        await element.dispose().catch(() => {})
      }
    }
    return this.toTab(tab)
  }

  async select(tabID: string, options: { ref: string; values: ReadonlyArray<string> }): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab)
    const element = await this.resolveElement(frame, options.ref)
    try {
      await element.selectOption([...options.values])
    } catch (error) {
      throw BrowserError.from(error, `Select failed for ref ${options.ref}`)
    } finally {
      await element.dispose().catch(() => {})
    }
    return this.toTab(tab)
  }

  async check(tabID: string, options: { ref: string; checked: boolean }): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab)
    const element = await this.resolveElement(frame, options.ref)
    try {
      await element.setChecked(options.checked)
    } catch (error) {
      throw BrowserError.from(error, `Check failed for ref ${options.ref}`)
    } finally {
      await element.dispose().catch(() => {})
    }
    return this.toTab(tab)
  }

  async press(tabID: string, options: { ref?: string; key: string }): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab)
    try {
      if (options.ref) {
        const element = await this.resolveElement(frame, options.ref)
        try {
          await element.press(options.key)
        } finally {
          await element.dispose().catch(() => {})
        }
      } else {
        await frame.evaluate(`((key) => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key })); })(${JSON.stringify(options.key)})`)
        await tab.page.keyboard.press(options.key).catch(() => {})
      }
    } catch (error) {
      throw BrowserError.from(error, "Press failed")
    }
    return this.toTab(tab)
  }

  async scroll(tabID: string, options: { deltaX?: number; deltaY: number }): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    await tab.page.mouse.wheel(options.deltaX ?? 0, options.deltaY).catch((error) => {
      throw BrowserError.from(error, "Scroll failed")
    })
    return this.toTab(tab)
  }

  async wait(
    tabID: string,
    options: { frameID?: string; condition: "load" | "text" | "textGone"; text?: string; timeoutMs?: number },
  ): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab, options.frameID)
    const timeout = options.timeoutMs ?? 10_000
    try {
      if (options.condition === "load") {
        await tab.page.waitForLoadState("load", { timeout })
      } else {
        if (!options.text) throw new Error(`wait condition "${options.condition}" requires text`)
        const needle = JSON.stringify(options.text)
        await frame.waitForFunction(
          `((needle, gone) => { const hay = document.body ? document.body.innerText : ""; const found = hay.toLowerCase().includes(needle.toLowerCase()); return gone ? !found : found; })(${needle}, ${options.condition === "textGone"})`,
          { timeout, polling: 250 },
        )
      }
    } catch (error) {
      throw BrowserError.from(error, "Wait timed out")
    }
    return this.toTab(tab)
  }

  async screenshot(
    tabID: string,
    options?: { ref?: string; fullPage?: boolean; format?: "png" | "jpeg" | "webp"; quality?: number; maxWidth?: number },
  ): Promise<{ tab: Browser.Tab; files: Browser.FileInfo[]; mime: string; data: Uint8Array }> {
    const tab = this.requireTab(tabID)
    const format = options?.format ?? "png"
    const mime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp"
    let restoreViewport: { width: number; height: number } | undefined
    try {
      if (options?.maxWidth) {
        const viewport = tab.page.viewportSize()
        if (viewport && viewport.width > options.maxWidth) {
          restoreViewport = viewport
          await tab.page.setViewportSize({ width: options.maxWidth, height: viewport.height })
        }
      }
      let data: Buffer
      if (options?.ref) {
        const element = await this.resolveElement(tab.page.mainFrame(), options.ref)
        try {
          data = await element.screenshot({
            type: format === "webp" ? "png" : format,
            quality: options?.quality,
            timeout: 15_000,
          })
        } finally {
          await element.dispose().catch(() => {})
        }
      } else if (format === "webp") {
        // Playwright screenshots only support png/jpeg; webp goes through CDP.
        const session = await this.cdp(tab)
        const captured = (await session.send("Page.captureScreenshot", {
          format: "webp",
          quality: options?.quality ?? 80,
          captureBeyondViewport: options?.fullPage ?? false,
        })) as { data: string }
        data = Buffer.from(captured.data, "base64")
      } else {
        data = await tab.page.screenshot({
          fullPage: options?.fullPage ?? false,
          type: format,
          quality: options?.quality,
          timeout: 15_000,
        })
      }
      const bytes = new Uint8Array(data)
      const saved = await BrowserFiles.save(
        [
          {
            id: Browser.FileID.make(`file_${crypto.randomUUID()}`),
            name: `screenshot-${Date.now()}.${format}`,
            mime,
            data: bytes,
          },
        ],
        this.options.captureDir,
      )
      tab.captures.push(...saved)
      tab.lastScreenshot = { mime, data: bytes }
      return { tab: this.toTab(tab), files: saved, mime, data: bytes }
    } catch (error) {
      throw BrowserError.from(error, "Screenshot failed")
    } finally {
      if (restoreViewport) await tab.page.setViewportSize(restoreViewport).catch(() => {})
    }
  }

  async dialog(
    tabID: string,
    options: { action: "get" | "accept" | "dismiss"; promptText?: string },
  ): Promise<{ tab: Browser.Tab; dialog: { type: string; message: string; defaultValue: string } | null }> {
    const tab = this.requireTab(tabID)
    if (options.action === "get") return { tab: this.toTab(tab), dialog: tab.dialog ?? null }
    const pending = tab.pendingDialog
    if (!pending) throw new BrowserError({ message: "No dialog is open in this tab." })
    try {
      if (options.action === "accept") await pending.accept(options.promptText ?? "")
      else await pending.dismiss()
    } catch (error) {
      throw BrowserError.from(error, "Dialog handling failed")
    } finally {
      tab.pendingDialog = undefined
      tab.dialog = undefined
    }
    return { tab: this.toTab(tab), dialog: null }
  }

  async filesUpload(tabID: string, options: { ref: string; files: ReadonlyArray<Browser.File> }): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab)
    const element = await this.resolveElement(frame, options.ref)
    try {
      await element.setInputFiles(
        options.files.map((file) => ({ name: file.name, mimeType: file.mime, buffer: Buffer.from(file.data) })),
      )
    } catch (error) {
      throw BrowserError.from(error, "File upload failed")
    } finally {
      await element.dispose().catch(() => {})
    }
    return this.toTab(tab)
  }

  async filesDrop(tabID: string, options: { ref: string; files: ReadonlyArray<Browser.File> }): Promise<Browser.Tab> {
    const tab = this.requireTab(tabID)
    const frame = await this.frameFor(tab)
    try {
      await frame.evaluate(
        `((ref, files) => {
          const el = globalThis.__novacodeRefs?.get(ref) ?? null
          if (!el) throw new Error("Ref " + ref + " is stale. Take a fresh browser.snapshot first.")
          const dt = new DataTransfer()
          for (const f of files) {
            const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))
            dt.items.add(new File([bytes], f.name, { type: f.mime }))
          }
          for (const type of ["dragenter", "dragover", "drop"])
            el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
        })(${JSON.stringify(this.cleanRef(options.ref))}, ${JSON.stringify(options.files.map((file) => ({ name: file.name, mime: file.mime, data: Buffer.from(file.data).toString("base64") })))})`,
      )
    } catch (error) {
      throw BrowserError.from(error, "File drop failed")
    }
    return this.toTab(tab)
  }

  private registerDownload(page: Page, download: Download): void {
    const tab = [...this.tabs.values()].find((candidate) => candidate.page === page)
    if (!tab) return
    const name = BrowserFiles.captureName(download.suggestedFilename())
    const filePath = path.join(this.options.captureDir, "downloads", `${Date.now()}-${name}`)
    void download
      .saveAs(filePath)
      .then(async () => {
        const info = await stat(filePath)
        tab.downloads.push({
          id: Browser.FileID.make(`file_${crypto.randomUUID()}`),
          name,
          mime: BrowserFiles.mimeFor(filePath),
          bytes: info.size,
          path: filePath,
        })
      })
      .catch(() => {})
  }

  filesList(tabID: string): { tab: Browser.Tab; files: Array<Browser.FileInfo & { state: "pending" | "completed" | "failed" }> } {
    const tab = this.requireTab(tabID)
    const files = [
      ...tab.downloads.map((info) => ({ ...info, state: "completed" as const })),
      ...tab.captures.map((info) => ({ ...info, state: "completed" as const })),
    ]
    return { tab: this.toTab(tab), files }
  }

  async filesGet(tabID: string, fileID: string): Promise<{ tab: Browser.Tab; files: Browser.FileInfo[] }> {
    const tab = this.requireTab(tabID)
    const found = [...tab.downloads, ...tab.captures].find((info) => info.id === fileID)
    if (!found) throw new BrowserError({ message: `Unknown file ${fileID}. List files with browser.files.list first.` })
    const data = new Uint8Array(await readFile(found.path))
    const saved = await BrowserFiles.save(
      [{ id: found.id, name: found.name, mime: found.mime, data }],
      this.options.captureDir,
    )
    return { tab: this.toTab(tab), files: saved }
  }

  console(
    tabID: string,
    options?: { level?: "debug" | "info" | "warning" | "error"; limit?: number },
  ): { tab: Browser.Tab; messages: Browser.ConsoleEntry[]; truncated: boolean; dropped: number } {
    const tab = this.requireTab(tabID)
    const minRank = severityRankOf(options?.level ?? "debug")
    const messages = tab.console.filter((entry) => severityRankOf(entry.level) >= minRank)
    const limit = options?.limit ?? 100
    const truncated = messages.length > limit
    return { tab: this.toTab(tab), messages: messages.slice(-limit), truncated, dropped: tab.consoleDropped }
  }

  networkList(
    tabID: string,
    options?: { urlContains?: string; resourceType?: Browser.ResourceType; limit?: number },
  ): { tab: Browser.Tab; requests: Browser.NetworkRequest[]; truncated: boolean; dropped: number } {
    const tab = this.requireTab(tabID)
    let requests = tab.network.map((record) => record.request)
    if (options?.urlContains) requests = requests.filter((request) => request.url.includes(options.urlContains!))
    if (options?.resourceType) requests = requests.filter((request) => request.resourceType === options.resourceType)
    const limit = options?.limit ?? 100
    const truncated = requests.length > limit
    return { tab: this.toTab(tab), requests: requests.slice(-limit), truncated, dropped: tab.networkDropped }
  }

  async networkGet(
    tabID: string,
    options: { id: string; includeBody?: boolean; maxBodyChars?: number },
  ): Promise<{
    tab: Browser.Tab
    request: Browser.NetworkRequest
    requestHeaders: Array<{ name: string; value: string }>
    responseHeaders: Array<{ name: string; value: string }>
    headersTruncated: boolean
    requestBody: Browser.Body
    responseBody: Browser.Body
  }> {
    const tab = this.requireTab(tabID)
    const record = tab.network.find((item) => item.request.id === options.id)
    if (!record) throw new BrowserError({ message: `Unknown request ${options.id}. List requests with browser.network.list first.` })
    const maxChars = options.maxBodyChars ?? 20_000
    const requestBody = bodyOf(record.postData, maxChars, options.includeBody ?? false)
    let responseBody: Browser.Body = { state: "notRequested" }
    if (options.includeBody && record.request.state === "completed") {
      try {
        const session = await this.cdp(tab)
        const body = (await session.send("Network.getResponseBody", { requestId: options.id })) as {
          body: string
          base64Encoded: boolean
        }
        const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf-8") : body.body
        responseBody = bodyOf(text, maxChars, true)
      } catch {
        responseBody = { state: "unavailable", reason: "notCaptured" }
      }
    }
    return {
      tab: this.toTab(tab),
      request: record.request,
      requestHeaders: [...record.requestHeaders],
      responseHeaders: [...record.responseHeaders],
      headersTruncated: record.requestHeaders.length >= 200 || record.responseHeaders.length >= 200,
      requestBody,
      responseBody,
    }
  }

  async traceStart(tabID: string, durationMs?: number): Promise<{ tab: Browser.Tab; recording: boolean }> {
    const tab = this.requireTab(tabID)
    if (tab.trace) throw new BrowserError({ message: "A trace recording is already running for this tab." })
    const session = await this.cdp(tab)
    const chunks: unknown[] = []
    const onData = (params: { value: unknown[] }) => chunks.push(...params.value)
    session.on("Tracing.dataCollected", onData)
    const bound = Math.min(durationMs ?? 30_000, 30_000)
    await session.send("Tracing.start", {
      categories: "devtools.timeline,v8.execute,blink.console,loading",
      options: "sampling-frequency=10000",
    }).catch((error) => {
      throw BrowserError.from(error, "Cannot start trace")
    })
    const startedAt = Date.now()
    tab.trace = { chunks, startedAt, durationMs: bound }
    setTimeout(() => void this.traceStop(tab.id).catch(() => {}), bound).unref?.()
    return { tab: this.toTab(tab), recording: true }
  }

  async traceStop(tabID: string): Promise<{ tab: Browser.Tab; files: Browser.FileInfo[]; durationMs: number; incomplete: boolean }> {
    const tab = this.requireTab(tabID)
    const trace = tab.trace
    if (!trace) throw new BrowserError({ message: "No trace recording is running for this tab." })
    tab.trace = undefined
    const session = await this.cdp(tab)
    let incomplete = false
    const done = new Promise<void>((resolve) => {
      const onComplete = () => {
        session.off("Tracing.tracingComplete", onComplete)
        resolve()
      }
      session.on("Tracing.tracingComplete", onComplete)
      setTimeout(() => resolve(), 10_000).unref?.()
    })
    await session.send("Tracing.end").catch(() => {
      incomplete = true
    })
    await done
    const durationMs = Date.now() - trace.startedAt
    const data = new TextEncoder().encode(JSON.stringify({ traceEvents: trace.chunks }))
    if (data.byteLength > Browser.MAX_FILE_BYTES) {
      incomplete = true
      throw new BrowserError({ message: "Trace exceeds the 5 MiB transfer limit. Record for a shorter duration." })
    }
    const saved = await BrowserFiles.save(
      [{ id: Browser.FileID.make(`file_${crypto.randomUUID()}`), name: `trace-${Date.now()}.json`, mime: "application/json", data }],
      this.options.captureDir,
    )
    tab.captures.push(...saved)
    return { tab: this.toTab(tab), files: saved, durationMs, incomplete }
  }

  async traceAnalyze(
    tabID: string,
    options: { fileID: string; limit?: number },
  ): Promise<{
    tab: Browser.Tab
    metrics: Array<{ name: string; value: number; unit: string }>
    events: Array<{ name: string; count: number; totalMs: number; maxMs: number }>
    insights: string[]
  }> {
    const tab = this.requireTab(tabID)
    const events = await this.readTraceEvents(tab, options.fileID)
    const byName = new Map<string, { count: number; totalMs: number; maxMs: number }>()
    for (const event of events) {
      if (typeof event.dur !== "number") continue
      const ms = event.dur / 1000
      const entry = byName.get(event.name) ?? { count: 0, totalMs: 0, maxMs: 0 }
      entry.count += 1
      entry.totalMs += ms
      entry.maxMs = Math.max(entry.maxMs, ms)
      byName.set(event.name, entry)
    }
    const sorted = [...byName.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)
    const limit = options.limit ?? 100
    const longTasks = events.filter((event) => typeof event.dur === "number" && event.dur / 1000 > 50).length
    const insights: string[] = []
    if (longTasks > 0) insights.push(`${longTasks} long tasks (>50ms) observed.`)
    const top = sorted[0]
    if (top) insights.push(`Heaviest event: ${top[0]} (${top[1].totalMs.toFixed(1)}ms total, ${top[1].count} occurrences).`)
    if (insights.length === 0) insights.push("No significant bottlenecks observed in this trace.")
    return {
      tab: this.toTab(tab),
      metrics: [
        { name: "events", value: events.length, unit: "count" },
        { name: "longTasks", value: longTasks, unit: "count" },
      ],
      events: sorted.slice(0, limit).map(([name, entry]) => ({ name, ...entry })),
      insights,
    }
  }

  private async readTraceEvents(tab: TabRecord, fileID: string): Promise<Array<{ name: string; dur?: number }>> {
    const found = tab.captures.find((info) => info.id === fileID)
    if (!found) throw new BrowserError({ message: `Unknown file ${fileID}.` })
    const parsed = JSON.parse(await readFile(found.path, "utf8")) as { traceEvents?: Array<{ name: string; dur?: number }> }
    return parsed.traceEvents ?? []
  }

  async cpuStart(tabID: string): Promise<{ tab: Browser.Tab; recording: boolean }> {
    const tab = this.requireTab(tabID)
    if (tab.cpu) throw new BrowserError({ message: "CPU sampling is already running for this tab." })
    const session = await this.cdp(tab)
    await session.send("Profiler.enable").catch((error) => {
      throw BrowserError.from(error, "Cannot enable profiler")
    })
    await session.send("Profiler.setSamplingInterval", { interval: 100 }).catch(() => {})
    await session.send("Profiler.start").catch((error) => {
      throw BrowserError.from(error, "Cannot start CPU sampling")
    })
    tab.cpu = { startedAt: Date.now() }
    setTimeout(() => void this.cpuStop(tab.id).catch(() => {}), 30_000).unref?.()
    return { tab: this.toTab(tab), recording: true }
  }

  async cpuStop(tabID: string): Promise<{ tab: Browser.Tab; files: Browser.FileInfo[]; durationMs: number }> {
    const tab = this.requireTab(tabID)
    const cpu = tab.cpu
    if (!cpu) throw new BrowserError({ message: "CPU sampling is not running for this tab." })
    tab.cpu = undefined
    const session = await this.cdp(tab)
    const result = (await session.send("Profiler.stop").catch((error) => {
      throw BrowserError.from(error, "Cannot stop CPU sampling")
    })) as { profile: unknown }
    const durationMs = Date.now() - cpu.startedAt
    const data = new TextEncoder().encode(JSON.stringify(result.profile))
    const saved = await BrowserFiles.save(
      [{ id: Browser.FileID.make(`file_${crypto.randomUUID()}`), name: `cpu-${Date.now()}.cpuprofile`, mime: "application/json", data }],
      this.options.captureDir,
    )
    tab.captures.push(...saved)
    return { tab: this.toTab(tab), files: saved, durationMs }
  }

  async cpuAnalyze(
    tabID: string,
    options: { fileID: string; limit?: number },
  ): Promise<{
    tab: Browser.Tab
    durationMs: number
    functions: Array<{ name: string; url: string; line: number; selfMs: number }>
  }> {
    const tab = this.requireTab(tabID)
    const found = tab.captures.find((info) => info.id === options.fileID)
    if (!found) throw new BrowserError({ message: `Unknown file ${options.fileID}.` })
    const profile = JSON.parse(await readFile(found.path, "utf8")) as {
      nodes: Array<{ id: number; hitCount?: number; callFrame: { functionName: string; url: string; lineNumber: number } }>
      samples?: number[]
      timeDeltas?: number[]
      startTime?: number
      endTime?: number
    }
    const byId = new Map(profile.nodes.map((node) => [node.id, node]))
    const selfMs = new Map<number, number>()
    const avgDelta =
      profile.timeDeltas && profile.timeDeltas.length > 0
        ? profile.timeDeltas.reduce((a, b) => a + b, 0) / profile.timeDeltas.length / 1000
        : 0.1
    if (profile.samples && profile.timeDeltas) {
      profile.samples.forEach((id, index) => {
        selfMs.set(id, (selfMs.get(id) ?? 0) + (profile.timeDeltas?.[index] ?? 100) / 1000)
      })
    } else {
      for (const node of profile.nodes) selfMs.set(node.id, (node.hitCount ?? 0) * avgDelta)
    }
    const functions = [...selfMs.entries()]
      .map(([id, ms]) => {
        const node = byId.get(id)
        return {
          name: node?.callFrame.functionName || "(anonymous)",
          url: (node?.callFrame.url ?? "").slice(0, Browser.MAX_TEXT),
          line: node?.callFrame.lineNumber ?? 0,
          selfMs: ms,
        }
      })
      .filter((fn) => fn.selfMs > 0)
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, options.limit ?? 100)
    const durationMs = profile.startTime && profile.endTime ? (profile.endTime - profile.startTime) / 1000 : 0
    return { tab: this.toTab(tab), durationMs, functions }
  }

  async heapSnapshot(tabID: string): Promise<{ tab: Browser.Tab; files: Browser.FileInfo[] }> {
    const tab = this.requireTab(tabID)
    const session = await this.cdp(tab)
    await session.send("HeapProfiler.enable").catch((error) => {
      throw BrowserError.from(error, "Cannot enable heap profiler")
    })
    const chunks: string[] = []
    const onChunk = (params: { chunk: string }) => chunks.push(params.chunk)
    session.on("HeapProfiler.addHeapSnapshotChunk", onChunk)
    try {
      await session.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
    } catch (error) {
      throw BrowserError.from(error, "Heap snapshot failed")
    } finally {
      session.off("HeapProfiler.addHeapSnapshotChunk", onChunk)
    }
    const data = new TextEncoder().encode(chunks.join(""))
    if (data.byteLength > Browser.MAX_FILE_BYTES)
      throw new BrowserError({ message: "Heap snapshot exceeds the 5 MiB transfer limit." })
    const saved = await BrowserFiles.save(
      [{ id: Browser.FileID.make(`file_${crypto.randomUUID()}`), name: `heap-${Date.now()}.heapsnapshot`, mime: "application/json", data }],
      this.options.captureDir,
    )
    tab.captures.push(...saved)
    return { tab: this.toTab(tab), files: saved }
  }

  private async readHeap(tab: TabRecord, fileID: string): Promise<ParsedHeap> {
    const found = tab.captures.find((info) => info.id === fileID)
    if (!found) throw new BrowserError({ message: `Unknown file ${fileID}.` })
    return parseHeapSnapshot(await readFile(found.path, "utf8"))
  }

  async heapSummary(
    tabID: string,
    options: { fileID: string; limit?: number },
  ): Promise<{ tab: Browser.Tab; nodes: number; edges: number; selfBytes: number; classes: Array<{ name: string; count: number; bytes: number }> }> {
    const tab = this.requireTab(tabID)
    const heap = await this.readHeap(tab, options.fileID)
    const byClass = new Map<string, { count: number; bytes: number }>()
    let selfBytes = 0
    for (const node of heap.nodes) {
      selfBytes += node.selfSize
      const entry = byClass.get(node.className) ?? { count: 0, bytes: 0 }
      entry.count += 1
      entry.bytes += node.selfSize
      byClass.set(node.className, entry)
    }
    const classes = [...byClass.entries()]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, options.limit ?? 100)
    return { tab: this.toTab(tab), nodes: heap.nodes.length, edges: heap.edges.length, selfBytes, classes }
  }

  async heapQuery(
    tabID: string,
    options: { fileID: string; name?: string; limit?: number },
  ): Promise<{ tab: Browser.Tab; nodes: Array<{ id: number; name: string; type: string; selfBytes: number; edgeCount: number }>; truncated: boolean }> {
    const tab = this.requireTab(tabID)
    const heap = await this.readHeap(tab, options.fileID)
    const needle = (options.name ?? "").toLowerCase()
    const matching = heap.nodes
      .filter((node) => node.className.toLowerCase().includes(needle))
      .sort((a, b) => b.selfSize - a.selfSize)
    const limit = options.limit ?? 100
    return {
      tab: this.toTab(tab),
      nodes: matching.slice(0, limit).map((node) => ({
        id: node.id,
        name: node.className,
        type: node.type,
        selfBytes: node.selfSize,
        edgeCount: node.edgeCount,
      })),
      truncated: matching.length > limit,
    }
  }

  async heapObject(
    tabID: string,
    options: { fileID: string; id: number; limit?: number },
  ): Promise<{
    tab: Browser.Tab
    node: { id: number; name: string; type: string; selfBytes: number; edgeCount: number }
    references: Array<{ name: string; node: { id: number; name: string; type: string; selfBytes: number; edgeCount: number } }>
    retainers: Array<{ name: string; node: { id: number; name: string; type: string; selfBytes: number; edgeCount: number } }>
    truncated: boolean
  }> {
    const tab = this.requireTab(tabID)
    const heap = await this.readHeap(tab, options.fileID)
    const index = heap.nodes.findIndex((node) => node.id === options.id)
    if (index < 0) throw new BrowserError({ message: `Unknown object id ${options.id} in this snapshot.` })
    const node = heap.nodes[index]!
    const limit = options.limit ?? 100
    const references = heap.edges
      .filter((edge) => edge.from === index)
      .slice(0, limit)
      .map((edge) => ({ name: edge.name, node: heapNodeView(heap.nodes[edge.to]!) }))
    const retainers = heap.edges
      .filter((edge) => edge.to === index)
      .slice(0, limit)
      .map((edge) => ({ name: edge.name, node: heapNodeView(heap.nodes[edge.from]!) }))
    return {
      tab: this.toTab(tab),
      node: heapNodeView(node),
      references,
      retainers,
      truncated: references.length >= limit || retainers.length >= limit,
    }
  }

  async heapCompare(
    tabID: string,
    options: { before: string; after: string; limit?: number },
  ): Promise<{ tab: Browser.Tab; classes: Array<{ name: string; countDelta: number; bytesDelta: number }> }> {
    const tab = this.requireTab(tabID)
    const before = await this.readHeap(tab, options.before)
    const after = await this.readHeap(tab, options.after)
    const aggregate = (heap: ParsedHeap) => {
      const map = new Map<string, { count: number; bytes: number }>()
      for (const node of heap.nodes) {
        const entry = map.get(node.className) ?? { count: 0, bytes: 0 }
        entry.count += 1
        entry.bytes += node.selfSize
        map.set(node.className, entry)
      }
      return map
    }
    const beforeMap = aggregate(before)
    const afterMap = aggregate(after)
    const names = new Set([...beforeMap.keys(), ...afterMap.keys()])
    const classes = [...names]
      .map((name) => ({
        name,
        countDelta: (afterMap.get(name)?.count ?? 0) - (beforeMap.get(name)?.count ?? 0),
        bytesDelta: (afterMap.get(name)?.bytes ?? 0) - (beforeMap.get(name)?.bytes ?? 0),
      }))
      .filter((entry) => entry.countDelta !== 0 || entry.bytesDelta !== 0)
      .sort((a, b) => Math.abs(b.bytesDelta) - Math.abs(a.bytesDelta))
      .slice(0, options.limit ?? 100)
    return { tab: this.toTab(tab), classes }
  }

  async lighthouse(tabID: string): Promise<{
    tab: Browser.Tab
    files: Browser.FileInfo[]
    scores: Array<{ id: string; title: string; score: number | null }>
    failures: Array<{ id: string; title: string; description: string }>
  }> {
    const tab = this.requireTab(tabID)
    const url = tab.page.url()
    if (!/^https?:/.test(url)) throw new BrowserError({ message: `Lighthouse needs an http(s) page, got ${url}` })
    const { chromium } = await import("playwright")
    const executablePath = chromium.executablePath()
    const previousChromePath = process.env.CHROME_PATH
    process.env.CHROME_PATH = executablePath
    try {
      const { default: lighthouse } = await import("lighthouse")
      const result = (await lighthouse(url, {
        onlyCategories: ["accessibility", "best-practices", "seo"],
        output: ["json", "html"],
      })) as unknown as {
        lhr: {
          categories: Record<string, { id: string; title: string; score: number | null }>
          audits: Record<string, { id: string; title: string; description: string; score: number | null; scoreDisplayMode: string }>
        }
        report: [string, string]
      }
      const scores = Object.values(result.lhr.categories).map((category) => ({
        id: category.id,
        title: category.title,
        score: category.score,
      }))
      const failures = Object.values(result.lhr.audits)
        .filter((audit) => audit.score !== null && audit.score < 0.9 && audit.scoreDisplayMode !== "notApplicable")
        .slice(0, 50)
        .map((audit) => ({ id: audit.id, title: audit.title, description: audit.description.slice(0, 2000) }))
      const saved = await BrowserFiles.save(
        [
          {
            id: Browser.FileID.make(`file_${crypto.randomUUID()}`),
            name: `lighthouse-${Date.now()}.json`,
            mime: "application/json",
            data: new TextEncoder().encode(result.report[0] ?? "{}"),
          },
          {
            id: Browser.FileID.make(`file_${crypto.randomUUID()}`),
            name: `lighthouse-${Date.now()}.html`,
            mime: "text/html",
            data: new TextEncoder().encode(result.report[1] ?? ""),
          },
        ],
        this.options.captureDir,
      )
      tab.captures.push(...saved)
      return { tab: this.toTab(tab), files: saved, scores, failures }
    } catch (error) {
      throw BrowserError.from(error, "Lighthouse audit failed")
    } finally {
      if (previousChromePath === undefined) delete process.env.CHROME_PATH
      else process.env.CHROME_PATH = previousChromePath
    }
  }

  async preview(path: string): Promise<{ path: string }> {
    if (!(await stat(path).catch(() => undefined))) throw new BrowserError({ message: `File not found: ${path}` })
    return { path }
  }

  async refAtPoint(tabID: string, x: number, y: number): Promise<string | undefined> {
    const tab = this.requireTab(tabID)
    let best: string | undefined
    let bestArea = Number.POSITIVE_INFINITY
    for (const [ref, box] of tab.boxes) {
      if (x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height) continue
      const area = box.width * box.height
      if (area < bestArea) {
        bestArea = area
        best = ref
      }
    }
    return best
  }

  /** Drop the panel's recent-pages history. */
  clearHistory(): void {
    this.recent = []
  }

  /** Fresh state for the web app's browser panel, including a live screenshot. */
  async panelSnapshot(): Promise<{
    tabs: ReadonlyArray<Browser.Tab>
    focusedTabID: Browser.TabID | null
    recent: string[]
    screenshot?: { mime: string; data: string }
  }> {
    const state = this.state()
    const focused = this.focusedTabID ? this.tabs.get(this.focusedTabID) : undefined
    if (!focused) return { ...state, recent: this.recent, screenshot: undefined }
    try {
      const data = await focused.page.screenshot({ type: "png", timeout: 10_000 })
      return { ...state, recent: this.recent, screenshot: { mime: "image/png", data: Buffer.from(data).toString("base64") } }
    } catch {
      return { ...state, recent: this.recent, screenshot: undefined }
    }
  }
}

function heapNodeView(node: ParsedHeapNode): { id: number; name: string; type: string; selfBytes: number; edgeCount: number } {
  return { id: node.id, name: node.className, type: node.type, selfBytes: node.selfSize, edgeCount: node.edgeCount }
}

function severityRankOf(level: string): number {
  return level === "error" ? 3 : level === "warning" ? 2 : level === "info" ? 1 : 0
}

function bodyOf(text: string | undefined, maxChars: number, include: boolean): Browser.Body {
  if (!include) return { state: "notRequested" }
  if (text === undefined) return { state: "empty" }
  return text.length > maxChars ? { state: "text", text: text.slice(0, maxChars), truncated: true } : { state: "text", text, truncated: false }
}

interface ParsedHeapNode {
  readonly id: number
  readonly className: string
  readonly type: string
  readonly selfSize: number
  readonly edgeCount: number
}

interface ParsedHeapEdge {
  from: number
  to: number
  readonly name: string
}

interface ParsedHeap {
  readonly nodes: ParsedHeapNode[]
  readonly edges: ParsedHeapEdge[]
}

function parseHeapSnapshot(text: string): ParsedHeap {
  const raw = JSON.parse(text) as {
    snapshot: { meta: { node_fields: string[]; node_types: Array<Array<string>>; edge_fields: string[]; edge_types: Array<Array<string>> } }
    nodes: number[]
    edges: number[]
    strings: string[]
  }
  const meta = raw.snapshot.meta
  const nodeFields = meta.node_fields
  const nodeTypes = meta.node_types[0] ?? []
  const edgeFields = meta.edge_fields
  const edgeTypes = meta.edge_types[0] ?? []
  const typeIdx = nodeFields.indexOf("type")
  const nameIdx = nodeFields.indexOf("name")
  const idIdx = nodeFields.indexOf("id")
  const sizeIdx = nodeFields.indexOf("self_size")
  const edgeCountIdx = nodeFields.indexOf("edge_count")
  const fieldCount = nodeFields.length
  const nodes: ParsedHeapNode[] = []
  for (let i = 0; i < raw.nodes.length; i += fieldCount) {
    nodes.push({
      id: raw.nodes[i + idIdx] ?? 0,
      className: raw.strings[raw.nodes[i + nameIdx] ?? 0] ?? "",
      type: nodeTypes[raw.nodes[i + typeIdx] ?? 0] ?? "",
      selfSize: raw.nodes[i + sizeIdx] ?? 0,
      edgeCount: raw.nodes[i + edgeCountIdx] ?? 0,
    })
  }
  const edgeTypeIdx = edgeFields.indexOf("type")
  const edgeNameIdx = edgeFields.indexOf("name_or_index")
  const edgeToIdx = edgeFields.indexOf("to_node")
  const edgeFieldCount = edgeFields.length
  const edges: ParsedHeapEdge[] = []
  for (let i = 0; i < raw.edges.length; i += edgeFieldCount) {
    const type = edgeTypes[raw.edges[i + edgeTypeIdx] ?? 0] ?? ""
    const nameOrIndex = raw.edges[i + edgeNameIdx] ?? 0
    edges.push({
      from: 0,
      to: Math.floor((raw.edges[i + edgeToIdx] ?? 0) / fieldCount),
      name: type === "element" || type === "hidden" ? `[${nameOrIndex}]` : (raw.strings[nameOrIndex] ?? String(nameOrIndex)),
    })
  }
  // Assign `from` by walking edges in node order.
  let edgeCursor = 0
  nodes.forEach((node, nodeIndex) => {
    for (let e = 0; e < node.edgeCount && edgeCursor < edges.length; e += 1) {
      edges[edgeCursor]!.from = nodeIndex
      edgeCursor += 1
    }
  })
  return { nodes, edges }
}


function frameIdOf(frame: Frame): string {
  // Stable-ish frame identifier for this session.
  return `${frame.name() || "main"}@${frame.url().slice(0, 64)}`
}

interface AXNode {
  readonly nodeId: string
  readonly role?: { value: string }
  readonly name?: { value: string }
  readonly value?: { value: unknown }
  readonly properties?: ReadonlyArray<{ name: string; value?: { value: unknown } }>
  readonly childIds?: ReadonlyArray<string>
  readonly backendDOMNodeId?: number
}

function nodeDepth(nodes: ReadonlyArray<AXNode>, node: AXNode): number {
  const parents = new Map<string, string>()
  for (const candidate of nodes)
    for (const child of candidate.childIds ?? []) parents.set(child, candidate.nodeId)
  let depth = 0
  let current = parents.get(node.nodeId)
  while (current !== undefined && depth < 100) {
    depth += 1
    current = parents.get(current)
  }
  return depth
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

async function cdpFrameId(session: CDPSession, frame: Frame): Promise<string | undefined> {
  const tree = (await session.send("Page.getFrameTree")) as {
    frameTree: { frame: { id: string; url: string; name?: string }; childFrames?: unknown[] }
  }
  const target = { url: frame.url(), name: frame.name() }
  const visit = (node: {
    frame: { id: string; url: string; name?: string }
    childFrames?: Array<{ frame: { id: string; url: string; name?: string }; childFrames?: never[] }>
  }): string | undefined => {
    if (node.frame.url === target.url && (node.frame.name ?? "") === target.name) return node.frame.id
    for (const child of node.childFrames ?? []) {
      const found = visit(child as never)
      if (found) return found
    }
    return undefined
  }
  return visit(tree.frameTree as never)
}

function pushBounded<T>(list: T[], item: T, max: number, onDrop: () => void): void {
  list.push(item)
  if (list.length > max) {
    list.splice(0, list.length - max)
    onDrop()
  }
}

function wireNetwork(tab: TabRecord, session: CDPSession): void {
  interface MutableRecord {
    request: Browser.NetworkRequest
    requestHeaders: Array<{ name: string; value: string }>
    responseHeaders: Array<{ name: string; value: string }>
    requestBody: Browser.Body
    responseBody: Browser.Body
    postData?: string
    startTime: number
  }
  const pending = new Map<string, MutableRecord>()
  session.on("Network.requestWillBeSent", (params: Record<string, unknown>) => {
    const request = params.request as Record<string, unknown>
    const record = {
      request: {
        id: String(params.requestId ?? ""),
        url: String(request.url ?? "").slice(0, Browser.MAX_TEXT),
        method: String(request.method ?? "").slice(0, 2048),
        resourceType: toResourceType(params.type),
        timestampMs: Date.now(),
        statusCode: undefined,
        state: "pending",
      } as Browser.NetworkRequest,
      requestHeaders: toHeaders(request.headers),
      responseHeaders: [],
      requestBody: { state: "notRequested" } as Browser.Body,
      responseBody: { state: "notRequested" } as Browser.Body,
      postData: typeof request.postData === "string" ? (request.postData as string).slice(0, 20_000) : undefined,
      startTime: Date.now(),
    }
    pending.set(String(params.requestId), record)
  })
  session.on("Network.responseReceived", (params: Record<string, unknown>) => {
    const record = pending.get(String(params.requestId))
    if (!record) return
    const response = params.response as Record<string, unknown>
    record.responseHeaders = toHeaders(response.headers)
    record.request = {
      ...record.request,
      statusCode: typeof response.status === "number" ? response.status : undefined,
    }
  })
  const finish = (requestId: string, failed: boolean, failure: string | undefined) => {
    const record = pending.get(requestId)
    if (!record) return
    pending.delete(requestId)
    const durationMs = Date.now() - record.startTime
    record.request = failed
      ? { ...record.request, state: "failed", durationMs, failure: (failure ?? "unknown").slice(0, 2048) }
      : { ...record.request, state: "completed", durationMs }
    pushBounded(tab.network, record, MAX_LOG_ENTRIES, () => (tab.networkDropped += 1))
  }
  session.on("Network.loadingFinished", (params: Record<string, unknown>) => finish(String(params.requestId), false, undefined))
  session.on("Network.loadingFailed", (params: Record<string, unknown>) =>
    finish(String(params.requestId), true, String((params as Record<string, unknown>).errorText ?? "failed")),
  )
}

function toResourceType(type: unknown): Browser.ResourceType {
  const known = [
    "document", "stylesheet", "image", "media", "font", "script",
    "xhr", "fetch", "eventsource", "websocket", "manifest", "other",
  ]
  return (known.includes(String(type)) ? String(type) : "other") as Browser.ResourceType
}

function toHeaders(headers: unknown): Array<{ name: string; value: string }> {
  if (!headers || typeof headers !== "object") return []
  return Object.entries(headers as Record<string, unknown>)
    .slice(0, 200)
    .map(([name, value]) => ({ name: name.slice(0, 2048), value: String(value).slice(0, Browser.MAX_TEXT) }))
}



export * as BrowserSession from "./session"
