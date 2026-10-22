import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, type Browser as PwBrowser, type BrowserContext, type CDPSession, type Page } from "playwright"
import { Browser } from "../src/rpc"
import { BrowserCapture } from "../src/capture"
import { BrowserDesktop } from "../src/desktop"
import { BrowserSession } from "../src/session"

/**
 * Protocol-level substitute for the Electron desktop (which cannot run on
 * this VM): a fake desktop client attaches to the real tunnel host and
 * executes wire actions against a real headless Chromium page through CDP,
 * the same commands the desktop executor implements. The routed Driver
 * must behave exactly as if a desktop were driving — and must never launch
 * its own Playwright browser while attached.
 */

const SCOPE = "/fake-scope"

interface FakeTab {
  id: Browser.TabID
  page: Page
  session: CDPSession
  title: string
  generation: number
  boxes: Map<string, { x: number; y: number; width: number; height: number }>
  capture: BrowserCapture.TabCapture
  captureSession: BrowserCapture.CaptureSession
}

/** Adapt a Playwright CDPSession to the shared capture session shape. */
function captureSessionOf(session: CDPSession): BrowserCapture.CaptureSession {
  return {
    send: (method, params) => session.send(method as never, params as never) as Promise<unknown>,
    on: (method, listener) => session.on(method as never, listener as never),
  }
}

/**
 * Read the document title directly: Playwright's page.title() goes stale
 * (returns "") once a JS dialog has been handled through a second CDP
 * session, while document.title stays correct.
 */
async function documentTitle(page: Page): Promise<string> {
  return page.evaluate(() => document.title).catch(() => "")
}

interface AXNode {
  nodeId: string
  role?: { value: string }
  name?: { value: string }
  value?: { value: unknown }
  properties?: Array<{ name: string; value?: { value: unknown } }>
  childIds?: string[]
  backendDOMNodeId?: number
}

function nodeDepth(nodes: AXNode[], node: AXNode): number {
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

class FakeDesktop {
  private tabs = new Map<Browser.TabID, FakeTab>()
  private focused: Browser.TabID | null = null
  stopped = false
  loop: Promise<void> | undefined
  /** When set, panelStill never answers — the unpresented-view capture hang. */
  hangPanelStill = false
  private releaseStill: (() => void) | undefined

  constructor(
    private host: BrowserDesktop.DesktopHost,
    private attachment: string,
    private context: BrowserContext,
  ) {}

  start() {
    this.loop = (async () => {
      while (!this.stopped) {
        const polled = await this.host.poll(this.attachment, 2_000)
        if (polled.status === "detached") return
        if (polled.status === "timeout") continue
        // Mirror the real desktop host: commands execute concurrently, so
        // a page-blocking action (a JS dialog awaiting handling, a long
        // evaluate) never stalls the rest of the tunnel.
        void this.execute(polled.command.action).then(
          (result) => {
            try {
              this.host.complete(this.attachment, polled.command.requestID, { type: "success", result })
            } catch {}
          },
          (error) => {
            try {
              this.host.complete(this.attachment, polled.command.requestID, {
                type: "failure",
                code: "error",
                message: error instanceof Error ? error.message : String(error),
              })
            } catch {}
          },
        )
      }
    })()
  }

  async stop() {
    this.stopped = true
    this.releaseStill?.()
    for (const tab of this.tabs.values()) await tab.page.close().catch(() => {})
    await this.loop?.catch(() => {})
  }

  private tab(tab: FakeTab): Browser.Tab {
    return {
      id: tab.id,
      url: tab.page.url(),
      title: tab.title || tab.page.url(),
      loading: false,
      canGoBack: false,
      canGoForward: false,
      generation: tab.generation,
    }
  }

  private state(): Browser.State {
    return { tabs: [...this.tabs.values()].map((tab) => this.tab(tab)), focusedTabID: this.focused }
  }

  private publish() {
    this.host.publish(this.attachment, SCOPE, this.state(), { width: 1280, height: 800 })
  }

  private require(tabID: string): FakeTab {
    const tab = this.tabs.get(tabID as Browser.TabID)
    if (!tab) throw new Error(`Unknown tab ${tabID}`)
    return tab
  }

  private async navigate(tab: FakeTab, rawUrl: string): Promise<Browser.Tab> {
    const action = Browser.normalizeAction({ type: "navigate", tabID: tab.id, url: rawUrl })
    if (action.type !== "navigate") throw new Error("URL normalization failed")
    await tab.page.goto(action.url, { waitUntil: "load" })
    tab.generation += 1
    tab.title = await documentTitle(tab.page)
    this.publish()
    return this.tab(tab)
  }

  private async snapshot(tab: FakeTab, boxes: boolean) {
    const tree = (await tab.session.send("Accessibility.getFullAXTree", {})) as { nodes: AXNode[] }
    const lines: string[] = []
    const refs = new Map<string, number>()
    let counter = 0
    for (const node of tree.nodes) {
      if (!node.backendDOMNodeId) continue
      counter += 1
      const ref = `e${counter}`
      refs.set(ref, node.backendDOMNodeId)
      const parts = [`- ${node.role?.value ?? "unknown"}`]
      if (node.name?.value) parts.push(`"${node.name.value}"`)
      if (node.value?.value !== undefined && node.value.value !== "") parts.push(`[value="${String(node.value.value)}"]`)
      parts.push(`[ref=${ref}]`)
      lines.push(`${"  ".repeat(nodeDepth(tree.nodes, node))}${parts.join(" ")}`)
    }
    tab.boxes.clear()
    for (const [ref, backendNodeId] of refs) {
      const resolved = (await tab.session.send("DOM.resolveNode", { backendNodeId })) as { object: { objectId: string } }
      await tab.session.send("Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: `function(ref) { (globalThis.__novacodeRefs = globalThis.__novacodeRefs || new Map()).set(ref, this) }`,
        arguments: [{ value: ref }],
      })
      if (boxes) {
        const box = (await tab.session
          .send("DOM.getBoxModel", { backendNodeId })
          .catch(() => undefined)) as { model: { content: number[] } } | undefined
        const content = box?.model.content
        if (content && content.length >= 8) {
          const xs = [content[0]!, content[2]!, content[4]!, content[6]!]
          const ys = [content[1]!, content[3]!, content[5]!, content[7]!]
          tab.boxes.set(ref, {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
          })
        }
      }
      await tab.session.send("Runtime.releaseObject", { objectId: resolved.object.objectId })
    }
    tab.generation += 1
    const content = lines.join("\n")
    return {
      tab: this.tab(tab),
      content,
      truncated: false,
      ...(boxes ? { boxes: Object.fromEntries(tab.boxes) } : {}),
    }
  }

  private async resolve(tab: FakeTab, ref: string) {
    const handle = await tab.page.evaluateHandle(
      (id) => (globalThis as unknown as { __novacodeRefs?: Map<string, Element> }).__novacodeRefs?.get(id) ?? null,
      ref.replace(/^@/, ""),
    )
    const element = handle.asElement()
    if (!element) throw new Error(`Ref ${ref} is stale`)
    return element
  }

  async execute(action: BrowserDesktop.DesktopAction): Promise<unknown> {
    switch (action.type) {
      case "tabs.list":
        return this.state()
      case "tabs.open": {
        const page = await this.context.newPage()
        // A registered (no-op) dialog listener stops Playwright from
        // auto-dismissing dialogs, so the CDP pending-dialog flow under
        // test is what actually resolves them.
        page.on("dialog", () => {})
        const session = await this.context.newCDPSession(page)
        const tab: FakeTab = {
          id: Browser.TabID.make(`tab_${crypto.randomUUID()}`),
          page,
          session,
          title: "",
          generation: 0,
          boxes: new Map(),
          capture: BrowserCapture.createCapture(),
          captureSession: captureSessionOf(session),
        }
        // Wire console/network/dialog capture before the first navigation,
        // the same order the real desktop executor uses.
        await BrowserCapture.wireCapture(tab.captureSession, tab.capture)
        this.tabs.set(tab.id, tab)
        if (action.focus ?? true) this.focused = tab.id
        const navigated = await this.navigate(tab, action.url ?? "about:blank")
        this.publish()
        return navigated
      }
      case "tabs.focus": {
        const tab = this.require(action.tabID)
        this.focused = tab.id
        this.publish()
        return this.tab(tab)
      }
      case "tabs.close": {
        const tab = this.require(action.tabID)
        await tab.page.close()
        this.tabs.delete(tab.id)
        if (this.focused === tab.id) this.focused = [...this.tabs.keys()].pop() ?? null
        const state = this.state()
        this.publish()
        return state
      }
      case "navigate":
        return this.navigate(this.require(action.tabID), action.url)
      case "back": {
        const tab = this.require(action.tabID)
        await tab.page.goBack({ waitUntil: "load" })
        tab.generation += 1
        tab.title = await documentTitle(tab.page)
        return this.tab(tab)
      }
      case "forward": {
        const tab = this.require(action.tabID)
        await tab.page.goForward({ waitUntil: "load" })
        tab.generation += 1
        return this.tab(tab)
      }
      case "reload": {
        const tab = this.require(action.tabID)
        await tab.page.reload({ waitUntil: "load" })
        tab.generation += 1
        return this.tab(tab)
      }
      case "stop":
        return this.tab(this.require(action.tabID))
      case "snapshot":
        return this.snapshot(this.require(action.tabID), action.boxes ?? false)
      case "click": {
        const tab = this.require(action.tabID)
        const element = await this.resolve(tab, action.ref)
        await element.click()
        // A click may navigate; poll until the new document's title lands.
        for (let attempt = 0; attempt < 60; attempt++) {
          const title = await documentTitle(tab.page)
          if (title) {
            tab.title = title
            break
          }
          await Bun.sleep(50)
        }
        this.publish()
        return this.tab(tab)
      }
      case "fill": {
        const tab = this.require(action.tabID)
        const element = await this.resolve(tab, action.ref)
        await element.fill(action.text)
        return this.tab(tab)
      }
      case "evaluate": {
        const tab = this.require(action.tabID)
        const value = await tab.page.evaluate(action.script)
        return { tab: this.tab(tab), value: value ?? null }
      }
      case "clickAtPoint": {
        const tab = this.require(action.tabID)
        await tab.page.mouse.click(action.x, action.y)
        tab.title = await documentTitle(tab.page)
        this.publish()
        return this.tab(tab)
      }
      case "screenshot": {
        const tab = this.require(action.tabID)
        const data = await tab.page.screenshot({ type: "png" })
        return { tab: this.tab(tab), mime: "image/png", data: Buffer.from(data).toString("base64") }
      }
      case "panelStill": {
        const tab = this.require(action.tabID)
        if (this.hangPanelStill) {
          await new Promise<void>((resolve) => {
            this.releaseStill = resolve
          })
        }
        const data = await tab.page.screenshot({ type: "png" })
        return { mime: "image/png", data: Buffer.from(data).toString("base64") }
      }
      case "dialog": {
        const tab = this.require(action.tabID)
        if (action.action === "get") return { tab: this.tab(tab), dialog: tab.capture.dialog ?? null }
        if (!tab.capture.dialogPending) throw new Error("No dialog is open in this tab.")
        await tab.session.send("Page.handleJavaScriptDialog", {
          accept: action.action === "accept",
          ...(action.promptText !== undefined ? { promptText: action.promptText } : {}),
        })
        tab.capture.dialogPending = false
        tab.capture.dialog = undefined
        return { tab: this.tab(tab), dialog: null }
      }
      case "console": {
        const tab = this.require(action.tabID)
        const minRank = BrowserCapture.severityRankOf(action.level ?? "debug")
        const messages = tab.capture.console.filter(
          (entry) => BrowserCapture.severityRankOf(entry.level) >= minRank,
        )
        const limit = action.limit ?? 100
        return {
          tab: this.tab(tab),
          messages: messages.slice(-limit),
          truncated: messages.length > limit,
          dropped: tab.capture.consoleDropped,
        }
      }
      case "network.list": {
        const tab = this.require(action.tabID)
        let requests = tab.capture.network.map((record) => record.request)
        if (action.urlContains) requests = requests.filter((request) => request.url.includes(action.urlContains!))
        if (action.resourceType) requests = requests.filter((request) => request.resourceType === action.resourceType)
        const limit = action.limit ?? 100
        return {
          tab: this.tab(tab),
          requests: requests.slice(-limit),
          truncated: requests.length > limit,
          dropped: tab.capture.networkDropped,
        }
      }
      case "network.get": {
        const tab = this.require(action.tabID)
        const record = tab.capture.network.find((item) => item.request.id === action.id)
        if (!record) throw new Error(`Unknown request ${action.id}. List requests with browser.network.list first.`)
        const maxChars = action.maxBodyChars ?? 20_000
        return {
          tab: this.tab(tab),
          request: record.request,
          requestHeaders: [...record.requestHeaders],
          responseHeaders: [...record.responseHeaders],
          headersTruncated: record.requestHeaders.length >= 200 || record.responseHeaders.length >= 200,
          requestBody: BrowserCapture.bodyOf(record.postData, maxChars, action.includeBody ?? false),
          responseBody: await BrowserCapture.responseBodyOf(
            tab.captureSession,
            record,
            action.includeBody ?? false,
            maxChars,
          ),
        }
      }
      default:
        throw new Error(`Fake desktop does not implement ${action.type}`)
    }
  }

  boxOf(tabID: string, ref: string) {
    return this.require(tabID).boxes.get(ref)
  }
}

describe("desktop tunnel protocol with a routed Driver", () => {
  const host = BrowserDesktop.host
  let browser: PwBrowser
  let server: ReturnType<typeof Bun.serve>
  let base: string
  let fake: FakeDesktop
  let driver: BrowserSession.Driver
  let attachmentID = ""
  let dirs: string[] = []

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/two")
          return new Response("<title>Fake Two</title><p>second page</p>", {
            headers: { "content-type": "text/html" },
          })
        return new Response(
          `<title>Fake One</title><input id="q" aria-label="Search"><a href="/two">Go two</a><script>console.log("fake page ready"); fetch("/two").catch(() => {})</script>`,
          { headers: { "content-type": "text/html" } },
        )
      },
    })
    base = `http://127.0.0.1:${server.port}`

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const { attachment } = host.attach("fake-desktop-test")
    attachmentID = attachment
    fake = new FakeDesktop(host, attachment, context)
    fake.start()

    const root = await mkdtemp(path.join(tmpdir(), "novacode-browser-desktop-"))
    dirs.push(root)
    driver = new BrowserSession.Driver({
      profileDir: path.join(root, "profile"),
      captureDir: path.join(root, "captures"),
      configDir: root,
      scope: SCOPE,
    })
  })

  afterAll(async () => {
    if (attachmentID) host.detach(attachmentID)
    await fake?.stop()
    await browser?.close()
    server?.stop(true)
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  test("tools and panel calls route to the attached desktop end to end", async () => {
    await driver.ready()
    expect(driver.launched).toBe(false)

    const tab = await driver.openTab(`${base}/`, true)
    expect(tab.id).toMatch(/^tab_/)
    expect(tab.title).toBe("Fake One")
    expect(driver.launched).toBe(false)

    const state = await driver.fetchState()
    expect(state.tabs).toHaveLength(1)
    expect(state.focusedTabID).toBe(tab.id)

    const snap = await driver.snapshot(tab.id, { boxes: true })
    const linkRef = snap.content.match(/link "Go two" \[ref=(e\d+)\]/)?.[1]
    const inputRef = snap.content.match(/textbox "Search" \[ref=(e\d+)\]/)?.[1]
    expect(linkRef).toBeTruthy()
    expect(inputRef).toBeTruthy()

    // Inspect picking resolves against the boxes the desktop snapshot returned.
    const box = fake.boxOf(tab.id, linkRef!)
    expect(box).toBeTruthy()
    const picked = await driver.pickAtPoint(tab.id, box!.x + box!.width / 2, box!.y + box!.height / 2)
    expect(picked.ref).toBe(linkRef)

    await driver.fill(tab.id, { ref: inputRef!, text: "hello" })
    const evaluated = await driver.evaluate(tab.id, { script: "document.getElementById('q').value" })
    expect(evaluated.value).toBe("hello")

    // Console and network route to the desktop's CDP capture buffers.
    const logs = await driver.console(tab.id, {})
    expect(logs.messages.some((message) => message.text.includes("fake page ready"))).toBe(true)

    // The page fetches /two on load; wait for the finished request to land.
    let listed = await driver.networkList(tab.id, {})
    for (let attempt = 0; attempt < 50 && !listed.requests.some((request) => request.url.endsWith("/two")); attempt++) {
      await Bun.sleep(100)
      listed = await driver.networkList(tab.id, {})
    }
    const fetchRequest = listed.requests.find((request) => request.url.endsWith("/two"))
    expect(fetchRequest).toBeTruthy()
    expect(fetchRequest?.state).toBe("completed")
    expect(fetchRequest?.resourceType).toBe("fetch")
    const documentRequest = listed.requests.find((request) => request.resourceType === "document")
    expect(documentRequest).toBeTruthy()
    const fetched = await driver.networkGet(tab.id, { id: fetchRequest!.id, includeBody: true })
    expect(fetched.responseBody.state).toBe("text")
    if (fetched.responseBody.state === "text") expect(fetched.responseBody.text).toContain("second page")

    // A page prompt surfaces through the same pending-dialog model.
    const answering = driver.evaluate(tab.id, { script: "prompt('Name?', 'anon')" })
    void answering.catch(() => undefined)
    let dialogState = await driver.dialog(tab.id, { action: "get" })
    for (let attempt = 0; attempt < 50 && !dialogState.dialog; attempt++) {
      await Bun.sleep(100)
      dialogState = await driver.dialog(tab.id, { action: "get" })
    }
    expect(dialogState.dialog).toEqual({ type: "prompt", message: "Name?", defaultValue: "anon" })
    await driver.dialog(tab.id, { action: "accept", promptText: "josh" })
    expect((await answering).value).toBe("josh")

    const after = await driver.click(tab.id, { ref: linkRef! })
    expect(after.url).toBe(`${base}/two`)
    expect(after.title).toBe("Fake Two")

    const panel = await driver.panelSnapshot()
    expect(panel.desktop).toBe(true)
    expect(panel.screenshot?.mime).toBe("image/png")
    expect(panel.screenshot?.data.length).toBeGreaterThan(100)
    expect(panel.viewport).toEqual({ width: 1280, height: 800 })

    const shot = await driver.screenshot(tab.id)
    expect(shot.files).toHaveLength(1)
    expect(shot.data.byteLength).toBeGreaterThan(100)
    expect(driver.filesList(tab.id).files).toHaveLength(1)
    const got = await driver.filesGet(tab.id, shot.files[0]!.id)
    expect(got.files[0]?.id).toBe(shot.files[0]?.id)

    expect(driver.launched).toBe(false)
  })

  test("panel state resolves promptly when the desktop never answers a panel still", async () => {
    fake.hangPanelStill = true
    const started = Date.now()
    const panel = await driver.panelSnapshot()
    const elapsed = Date.now() - started
    expect(panel.desktop).toBe(true)
    expect(panel.tabs).toHaveLength(1)
    expect(panel.screenshot).toBeUndefined()
    // Bounded by the panel's still timeout (4s), nowhere near the tunnel's 120s default.
    expect(elapsed).toBeLessThan(20_000)
    expect(driver.launched).toBe(false)
  })
})
