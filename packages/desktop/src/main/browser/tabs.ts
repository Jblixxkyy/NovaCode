import { app, WebContentsView, type BrowserWindow, type Rectangle, type WebContents } from "electron"
import { BrowserPermissions } from "@novacode-ai/browser/permissions"
import type { BrowserDesktop } from "@novacode-ai/browser/desktop"
import type { Browser } from "@novacode-ai/browser/rpc"
import { attachCdp, type CdpSession } from "./cdp"
import { ensureCapture, partitionFor, type PageContents, type TabHandle, type TabInventory } from "./executor"

/**
 * Owns the desktop's browser tabs: one sandboxed WebContentsView per tab,
 * grouped by location scope, with a single persistent session partition
 * (phase 1; per-scope partitions are deferred). The focused tab of the
 * scope the panel is showing gets attached to that window at the bounds
 * the renderer reports; everything else stays detached and hidden.
 */

export interface BrowserEmbedRequest {
  scope: string
  tabID: string | null
  rect: { x: number; y: number; width: number; height: number }
  visible: boolean
}

/** Persisted tab layout (per scope) for restore across desktop restarts. */
export type BrowserTabsRestoreState = Record<string, { tabs: Array<{ url: string }>; focusedIndex: number }>

interface EmbeddedTab extends TabHandle {
  view: WebContentsView
  contents: PageContents
}

interface ScopeTabs {
  tabs: Map<string, EmbeddedTab>
  focusedID: string | null
}

const BLANK = "about:blank"

class ElectronPageContents implements PageContents {
  readonly cdp: CdpSession

  constructor(
    private readonly view: WebContentsView,
    private readonly webContents: WebContents,
  ) {
    this.cdp = attachCdp(webContents)
  }

  getURL() {
    return this.webContents.getURL()
  }

  getTitle() {
    return this.webContents.getTitle()
  }

  isLoading() {
    return this.webContents.isLoading()
  }

  canGoBack() {
    return this.webContents.navigationHistory.canGoBack()
  }

  canGoForward() {
    return this.webContents.navigationHistory.canGoForward()
  }

  goBack() {
    if (this.canGoBack()) this.webContents.navigationHistory.goBack()
  }

  goForward() {
    if (this.canGoForward()) this.webContents.navigationHistory.goForward()
  }

  reload() {
    this.webContents.reload()
  }

  stop() {
    this.webContents.stop()
  }

  loadURL(url: string) {
    // webContents.loadURL rejects for aborted/superseded loads; navigation
    // failures are reported through did-fail-load onto the tab instead.
    return this.webContents.loadURL(url).then(
      () => undefined,
      () => undefined,
    )
  }

  onceLoaded(timeoutMs: number) {
    if (!this.webContents.isLoading()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        if (timer) clearTimeout(timer)
        this.webContents.removeListener("did-stop-loading", done)
        this.webContents.removeListener("did-fail-load", done)
        resolve()
      }
      timer = setTimeout(done, timeoutMs)
      this.webContents.once("did-stop-loading", done)
      this.webContents.once("did-fail-load", done)
    })
  }

  getViewportSize() {
    const bounds = this.view.getBounds()
    return bounds.width > 0 && bounds.height > 0
      ? { width: bounds.width, height: bounds.height }
      : { width: 1280, height: 800 }
  }

  capturePage() {
    return this.webContents.capturePage()
  }
}

function isAllowedURL(url: string): boolean {
  if (url === BLANK) return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    if (parsed.username || parsed.password) return false
    return true
  } catch {
    return false
  }
}

export class BrowserTabManager implements TabInventory {
  private scopes = new Map<string, ScopeTabs>()
  private owned = new Set<WebContentsView>()
  private embeds = new Map<number, { window: BrowserWindow; request: BrowserEmbedRequest }>()
  private listeners = new Set<(scope: string) => void>()
  /**
   * The server's domain ACL (browser-acl.json), delivered with the tunnel
   * attachment and refreshed on every re-attach. Enforced on tab opens and
   * executor navigations with the same semantics as the Playwright driver.
   */
  private acl: BrowserPermissions.DomainACL = { allow: [], deny: [] }
  private persister: (() => void) | undefined
  private persistTimer: ReturnType<typeof setTimeout> | undefined

  setACL(acl: BrowserPermissions.DomainACL): void {
    this.acl = acl
  }

  /** Register the tab-layout persistence callback (main wires it to the store). */
  setPersister(persister: () => void): void {
    this.persister = persister
  }

  private schedulePersist(): void {
    if (!this.persister) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.persister?.()
    }, 250)
    this.persistTimer.unref?.()
  }

  checkNavigation(url: string): void {
    BrowserPermissions.checkDomain(url, this.acl)
  }

  private inspectListeners = new Set<(scope: string, event: BrowserDesktop.InspectEvent) => void>()

  /** Subscribe to live-inspect events (picks, cancellations, in-page shortcut). */
  onInspectEvent(listener: (scope: string, event: BrowserDesktop.InspectEvent) => void): () => void {
    this.inspectListeners.add(listener)
    return () => {
      this.inspectListeners.delete(listener)
    }
  }

  inspectEvent(scope: string, event: BrowserDesktop.InspectEvent): void {
    for (const listener of this.inspectListeners) listener(scope, event)
  }

  onChange(listener: (scope: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private changed(scope: string) {
    this.refreshEmbeds()
    this.schedulePersist()
    for (const listener of this.listeners) listener(scope)
  }

  private scopeTabs(scope: string): ScopeTabs {
    const existing = this.scopes.get(scope)
    if (existing) return existing
    const created: ScopeTabs = { tabs: new Map(), focusedID: null }
    this.scopes.set(scope, created)
    return created
  }

  /** All scopes the manager has seen, including ones with zero tabs. */
  knownScopes(): string[] {
    return [...this.scopes.keys()]
  }

  list(scope: string): TabHandle[] {
    return [...(this.scopes.get(scope)?.tabs.values() ?? [])]
  }

  focusedID(scope: string): string | null {
    return this.scopes.get(scope)?.focusedID ?? null
  }

  get(scope: string, tabID: string): TabHandle | undefined {
    return this.scopes.get(scope)?.tabs.get(tabID)
  }

  /** The last embed viewport reported for a scope (CSS pixels), if any. */
  viewportFor(scope: string): { width: number; height: number } | undefined {
    for (const embed of this.embeds.values()) {
      if (embed.request.scope !== scope) continue
      const { width, height } = embed.request.rect
      if (width > 0 && height > 0) return { width, height }
    }
    return undefined
  }

  async open(scope: string, url: string | undefined, focus: boolean): Promise<TabHandle> {
    // ACL parity with the Playwright driver: tab opens (including page
    // popups, which funnel through here) obey browser-acl.json.
    if (url && url !== BLANK) this.checkNavigation(url)
    const handle = this.createTab(scope, url, focus)
    const target = url ?? BLANK
    if (isAllowedURL(target)) {
      handle.loadError = undefined
      await handle.view.webContents.loadURL(target).catch((error: unknown) => {
        handle.loadError = (error instanceof Error ? error.message : String(error)).slice(0, 2048)
      })
      handle.generation += 1
    }
    this.changed(scope)
    return handle
  }

  /** Create a tab's view and wire its events. Deferred tabs load nothing until activated. */
  private createTab(scope: string, url: string | undefined, focus: boolean, deferred = false): EmbeddedTab {
    // WebContentsView cannot be created before app.whenReady(). Doing so
    // crashed Windows launches natively (exit -36861) when saved tabs were
    // restored at module load time. Fail loudly in JS instead of crashing
    // natively, so the caller can log and continue without tabs.
    if (!app.isReady()) {
      throw new Error("BrowserTabManager: cannot create a tab before app is ready")
    }
    const group = this.scopeTabs(scope)
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        backgroundThrottling: false,
        focusOnNavigation: false,
        partition: partitionFor(scope),
      },
    })
    const contents = view.webContents
    const handle: EmbeddedTab = {
      id: `tab_${crypto.randomUUID()}`,
      view,
      contents: new ElectronPageContents(view, contents),
      generation: 0,
      boxes: new Map(),
    }
    if (deferred) handle.pendingURL = url ?? BLANK
    group.tabs.set(handle.id, handle)
    this.owned.add(view)
    if (focus || !group.focusedID) group.focusedID = handle.id
    // Capture console/network/dialog from the tab's first navigation on.
    void ensureCapture(handle).catch(() => {})

    contents.setWindowOpenHandler(({ url: popupUrl }) => {
      // Popups become regular tabs in the same scope instead of windows.
      void this.open(scope, popupUrl, true).catch(() => {})
      return { action: "deny" }
    })
    contents.on("before-input-event", (event, input) => {
      // Ctrl+Shift+C (Cmd+Shift+C on macOS) inside the page asks the panel
      // to enter live inspect for this tab, mirroring browser devtools.
      if (input.type !== "keyDown") return
      if (!(input.control || input.meta) || !input.shift) return
      if (input.code !== "KeyC" && input.key.toLowerCase() !== "c") return
      event.preventDefault()
      this.inspectEvent(scope, { type: "inspectKey", tabID: handle.id as Browser.TabID })
    })
    contents.on("will-navigate", (event, target) => {
      if (!isAllowedURL(target)) event.preventDefault()
    })
    contents.on("did-navigate", () => this.changed(scope))
    contents.on("did-navigate-in-page", () => this.changed(scope))
    contents.on("page-title-updated", () => this.changed(scope))
    contents.on("page-favicon-updated", (_event, favicons) => {
      const favicon = favicons[0]?.slice(0, 2048)
      if (favicon && handle.favicon !== favicon) {
        handle.favicon = favicon
        this.changed(scope)
      }
    })
    contents.on("did-start-loading", () => this.changed(scope))
    contents.on("did-stop-loading", () => this.changed(scope))
    contents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      // -3 is ERR_ABORTED (a superseded navigation), not a load failure.
      if (isMainFrame && errorCode !== -3) handle.loadError = errorDescription.slice(0, 2048)
      this.changed(scope)
    })
    contents.on("destroyed", () => {
      this.owned.delete(view)
      if (!group.tabs.delete(handle.id)) return
      if (group.focusedID === handle.id) group.focusedID = [...group.tabs.keys()].pop() ?? null
      this.changed(scope)
    })
    return handle
  }

  /** Load a restored tab's deferred URL the first time it is focused or shown. */
  private activate(scope: string, handle: EmbeddedTab): void {
    const pending = handle.pendingURL
    if (!pending) return
    handle.pendingURL = undefined
    if (!isAllowedURL(pending)) return
    handle.loadError = undefined
    handle.generation += 1
    void handle.view.webContents.loadURL(pending).catch((error: unknown) => {
      handle.loadError = (error instanceof Error ? error.message : String(error)).slice(0, 2048)
      this.changed(scope)
    })
  }

  /** The restorable tab layout: per scope, tab URLs in order + the focused tab's index. */
  snapshotRestoreState(): BrowserTabsRestoreState {
    const state: BrowserTabsRestoreState = {}
    for (const [scope, group] of this.scopes) {
      if (group.tabs.size === 0) continue
      const tabs = [...group.tabs.values()].map((handle) => ({
        url: handle.contents.getURL() || handle.pendingURL || BLANK,
      }))
      const focusedIndex = Math.max(
        0,
        [...group.tabs.keys()].indexOf(group.focusedID ?? ""),
      )
      state[scope] = { tabs, focusedIndex }
    }
    return state
  }

  /**
   * Recreate a persisted tab layout without loading anything: restored
   * views stay unattached and their URLs deferred until the panel embeds
   * or focuses them, so a restart never spawns windows or steals focus.
   */
  restoreScopes(state: BrowserTabsRestoreState): void {
    for (const [scope, saved] of Object.entries(state)) {
      if (this.scopes.get(scope)?.tabs.size) continue
      saved.tabs.forEach((tab, index) => {
        this.createTab(scope, tab.url, index === saved.focusedIndex, true)
      })
      const group = this.scopes.get(scope)
      if (group) {
        const ids = [...group.tabs.keys()]
        group.focusedID = ids[Math.min(saved.focusedIndex, ids.length - 1)] ?? null
      }
      this.changed(scope)
    }
  }

  focus(scope: string, tabID: string): TabHandle | undefined {
    const group = this.scopes.get(scope)
    const handle = group?.tabs.get(tabID)
    if (!group || !handle) return undefined
    group.focusedID = tabID
    this.activate(scope, handle)
    this.changed(scope)
    return handle
  }

  async close(scope: string, tabID: string): Promise<void> {
    const group = this.scopes.get(scope)
    const handle = group?.tabs.get(tabID)
    if (!group || !handle) return
    group.tabs.delete(tabID)
    this.owned.delete(handle.view)
    if (group.focusedID === tabID) group.focusedID = [...group.tabs.keys()].pop() ?? null
    for (const embed of this.embeds.values()) {
      if (!embed.window.isDestroyed() && embed.window.contentView.children.includes(handle.view))
        embed.window.contentView.removeChildView(handle.view)
    }
    handle.view.setVisible(false)
    handle.view.webContents.close()
    this.changed(scope)
  }

  /** Show/hide the embedded view for one window. Called from IPC. */
  setEmbed(window: BrowserWindow, request: BrowserEmbedRequest | null) {
    if (!request) this.embeds.delete(window.id)
    else this.embeds.set(window.id, { window, request })
    this.refreshEmbeds()
  }

  private refreshEmbeds() {
    for (const [windowID, embed] of this.embeds) {
      const { window, request } = embed
      if (window.isDestroyed()) {
        this.embeds.delete(windowID)
        continue
      }
      const group = this.scopes.get(request.scope)
      const wantedID = request.visible ? (request.tabID ?? group?.focusedID ?? null) : null
      const zoom = window.webContents.getZoomFactor()
      const rect: Rectangle = {
        x: Math.round(request.rect.x * zoom),
        y: Math.round(request.rect.y * zoom),
        width: Math.round(request.rect.width * zoom),
        height: Math.round(request.rect.height * zoom),
      }
      let wantedView: WebContentsView | undefined
      for (const scopeGroup of this.scopes.values()) {
        for (const handle of scopeGroup.tabs.values()) {
          const attached = window.contentView.children.includes(handle.view)
          if (handle.id !== wantedID || scopeGroup !== group) {
            if (attached) window.contentView.removeChildView(handle.view)
            handle.view.setVisible(false)
            continue
          }
          wantedView = handle.view
          this.activate(request.scope, handle)
          if (!attached) window.contentView.addChildView(handle.view)
          handle.view.setBounds(rect)
          handle.view.setVisible(true)
        }
      }
      // Remove any stale browser view left over from a closed scope/tab.
      // Only views this manager created are ever touched: the window's own
      // contents view is also a child of contentView and must stay.
      for (const child of [...window.contentView.children]) {
        if (child instanceof WebContentsView && child !== wantedView && this.owned.has(child))
          window.contentView.removeChildView(child)
      }
    }
  }
}

/** Shared manager for the whole main process. */
export const browserTabs = new BrowserTabManager()
