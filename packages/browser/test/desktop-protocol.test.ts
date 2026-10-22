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
  trace?: { chunks: unknown[]; startedAt: number; onData: (params: { value: unknown[] }) => void }
  cpu?: { startedAt: number }
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
      case "files.deliver": {
        const tab = this.require(action.tabID)
        const element = await this.resolve(tab, action.ref)
        const kind = await element.evaluate((el) => ({ tag: el.tagName, type: el.getAttribute("type") }))
        const isFileInput = kind.tag === "INPUT" && kind.type === "file"
        if (action.mode === "upload" && !isFileInput)
          throw new Error(`browser.files.upload needs an <input type="file"> element; ${action.ref} is not one.`)
        if (isFileInput) {
          // Playwright's buffer form of setInputFiles mirrors DOM.setFileInputFiles.
          await element.setInputFiles(
            action.files.map((file) => ({
              name: file.name,
              mimeType: file.mime,
              buffer: Buffer.from(file.data, "base64"),
            })),
          )
          return this.tab(tab)
        }
        await element.evaluate((el, files) => {
          const dt = new DataTransfer()
          for (const f of files) {
            const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))
            dt.items.add(new File([bytes], f.name, { type: f.mime }))
          }
          for (const type of ["dragenter", "dragover", "drop"])
            el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
        }, action.files)
        return this.tab(tab)
      }
      case "drag": {
        const tab = this.require(action.tabID)
        const fromElement = await this.resolve(tab, action.from)
        const toElement = await this.resolve(tab, action.to)
        const fromBox = await fromElement.boundingBox()
        const toBox = await toElement.boundingBox()
        if (!fromBox || !toBox) throw new Error("Could not measure drag endpoints")
        await tab.page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2)
        await tab.page.mouse.down()
        await tab.page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 12 })
        await tab.page.mouse.up()
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
      case "trace.start": {
        const tab = this.require(action.tabID)
        if (tab.trace) throw new Error("A trace recording is already running for this tab.")
        const chunks: unknown[] = []
        const onData = (params: { value: unknown[] }) => chunks.push(...params.value)
        tab.session.on("Tracing.dataCollected", onData)
        await tab.session.send("Tracing.start", {
          categories: "devtools.timeline,v8.execute,blink.console,loading",
          options: "sampling-frequency=10000",
        })
        tab.trace = { chunks, startedAt: Date.now(), onData }
        return { tab: this.tab(tab), recording: true }
      }
      case "trace.stop": {
        const tab = this.require(action.tabID)
        const trace = tab.trace
        if (!trace) throw new Error("No trace recording is running for this tab.")
        tab.trace = undefined
        const done = new Promise<void>((resolve) => {
          const onComplete = () => {
            tab.session.off("Tracing.tracingComplete", onComplete)
            resolve()
          }
          tab.session.on("Tracing.tracingComplete", onComplete)
          setTimeout(resolve, 10_000)
        })
        await tab.session.send("Tracing.end")
        await done
        tab.session.off("Tracing.dataCollected", trace.onData)
        return {
          tab: this.tab(tab),
          file: {
            name: `trace-${Date.now()}.json`,
            mime: "application/json",
            data: Buffer.from(JSON.stringify({ traceEvents: trace.chunks }), "utf8").toString("base64"),
          },
          durationMs: Date.now() - trace.startedAt,
          incomplete: false,
        }
      }
      case "cpu.start": {
        const tab = this.require(action.tabID)
        if (tab.cpu) throw new Error("CPU sampling is already running for this tab.")
        await tab.session.send("Profiler.enable")
        await tab.session.send("Profiler.setSamplingInterval", { interval: 100 }).catch(() => {})
        await tab.session.send("Profiler.start")
        tab.cpu = { startedAt: Date.now() }
        return { tab: this.tab(tab), recording: true }
      }
      case "cpu.stop": {
        const tab = this.require(action.tabID)
        const cpu = tab.cpu
        if (!cpu) throw new Error("CPU sampling is not running for this tab.")
        tab.cpu = undefined
        const result = (await tab.session.send("Profiler.stop")) as { profile: unknown }
        return {
          tab: this.tab(tab),
          file: {
            name: `cpu-${Date.now()}.cpuprofile`,
            mime: "application/json",
            data: Buffer.from(JSON.stringify(result.profile), "utf8").toString("base64"),
          },
          durationMs: Date.now() - cpu.startedAt,
        }
      }
      case "heap.snapshot": {
        const tab = this.require(action.tabID)
        await tab.session.send("HeapProfiler.enable")
        const chunks: string[] = []
        const onChunk = (params: { chunk: string }) => chunks.push(params.chunk)
        tab.session.on("HeapProfiler.addHeapSnapshotChunk", onChunk)
        try {
          await tab.session.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
        } finally {
          tab.session.off("HeapProfiler.addHeapSnapshotChunk", onChunk)
        }
        return {
          tab: this.tab(tab),
          file: {
            name: `heap-${Date.now()}.heapsnapshot`,
            mime: "application/json",
            data: Buffer.from(chunks.join(""), "utf8").toString("base64"),
          },
        }
      }
      case "lighthouse": {
        const tab = this.require(action.tabID)
        const url = tab.page.url()
        if (!/^https?:/.test(url)) throw new Error(`Lighthouse needs an http(s) page, got ${url}`)
        // Mirror the real executor: no standalone Chrome configured in tests.
        if (!process.env.NOVACODE_DESKTOP_LIGHTHOUSE_CHROME)
          throw new Error(
            "Lighthouse is not available on desktop tabs in this build: an Electron webview exposes no remote-debugging port for Lighthouse to attach to. Set NOVACODE_DESKTOP_LIGHTHOUSE_CHROME to a Chrome/Chromium executable to run audits from the desktop, or run browser.lighthouse when no desktop is attached.",
          )
        throw new Error("Fake desktop never runs lighthouse")
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
          `<title>Fake One</title><input id="q" aria-label="Search"><a href="/two">Go two</a><button id="d1">DragSource</button><button id="d2">DragTarget</button><input type="file" id="up" aria-label="Upload"><script>console.log("fake page ready"); fetch("/two").catch(() => {}); window.__dragLog = { down: null, moves: 0, up: null }; document.addEventListener("mousedown", (e) => { window.__dragLog.down = [e.clientX, e.clientY] }); document.addEventListener("mousemove", (e) => { if (e.buttons === 1) window.__dragLog.moves += 1 }); document.addEventListener("mouseup", (e) => { window.__dragLog.up = [e.clientX, e.clientY] }); document.getElementById("d2").addEventListener("drop", (e) => { window.__dropped = [...e.dataTransfer.files].map((f) => f.name + ":" + f.size) })</script>`,
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

    // Drag routes as a pressed mouse path between the two elements.
    const dragSnap = await driver.snapshot(tab.id, { boxes: true })
    const sourceRef = dragSnap.content.match(/button "DragSource" \[ref=(e\d+)\]/)?.[1]
    const targetRef = dragSnap.content.match(/button "DragTarget" \[ref=(e\d+)\]/)?.[1]
    expect(sourceRef).toBeTruthy()
    expect(targetRef).toBeTruthy()
    await driver.drag(tab.id, { from: sourceRef!, to: targetRef! })
    const dragLog = (await driver.evaluate(tab.id, { script: "window.__dragLog" })).value as {
      down: [number, number]
      moves: number
      up: [number, number]
    }
    const sourceBox = fake.boxOf(tab.id, sourceRef!)!
    const targetBox = fake.boxOf(tab.id, targetRef!)!
    expect(Math.abs(dragLog.down[0] - (sourceBox.x + sourceBox.width / 2))).toBeLessThan(2)
    expect(dragLog.moves).toBeGreaterThanOrEqual(5)
    expect(Math.abs(dragLog.up[0] - (targetBox.x + targetBox.width / 2))).toBeLessThan(2)

    // File upload delivers bytes through the tunnel to the file input.
    const uploadRef = dragSnap.content.match(/button "Upload"[^\n]*\[ref=(e\d+)\]/)?.[1]
    expect(uploadRef).toBeTruthy()
    const uploadFile = {
      id: Browser.FileID.make(`file_${crypto.randomUUID()}`),
      name: "note.txt",
      mime: "text/plain",
      data: new TextEncoder().encode("hello upload"),
    }
    await driver.filesUpload(tab.id, { ref: uploadRef!, files: [uploadFile] })
    const chosen = (await driver.evaluate(tab.id, {
      script: "document.getElementById('up').files[0].name + ':' + document.getElementById('up').files[0].size",
    })).value
    expect(chosen).toBe("note.txt:12")

    // Drop onto a plain element dispatches the synthetic DragEvent sequence.
    await driver.filesDrop(tab.id, { ref: targetRef!, files: [uploadFile] })
    const dropped = (await driver.evaluate(tab.id, { script: "window.__dropped" })).value
    expect(dropped).toEqual(["note.txt:12"])

    // Diagnostics produce captures the Driver materializes server-side,
    // and the server-side analyzers read them back unchanged.
    await driver.traceStart(tab.id, 5_000)
    await driver.evaluate(tab.id, { script: "document.title" })
    const trace = await driver.traceStop(tab.id)
    expect(trace.files).toHaveLength(1)
    const traceAnalysis = await driver.traceAnalyze(tab.id, { fileID: trace.files[0]!.id })
    expect(traceAnalysis.metrics[0]?.name).toBe("events")

    await driver.cpuStart(tab.id)
    await driver.evaluate(tab.id, {
      script: "(() => { let x = 0; for (let i = 0; i < 1000000; i++) x += i; return x })()",
    })
    const cpu = await driver.cpuStop(tab.id)
    expect(cpu.files).toHaveLength(1)
    const cpuAnalysis = await driver.cpuAnalyze(tab.id, { fileID: cpu.files[0]!.id })
    expect(Array.isArray(cpuAnalysis.functions)).toBe(true)

    const heap = await driver.heapSnapshot(tab.id)
    expect(heap.files).toHaveLength(1)
    const heapSummary = await driver.heapSummary(tab.id, { fileID: heap.files[0]!.id })
    expect(heapSummary.nodes).toBeGreaterThan(0)
    const heapQuery = await driver.heapQuery(tab.id, { fileID: heap.files[0]!.id, name: "Object" })
    expect(Array.isArray(heapQuery.nodes)).toBe(true)

    // Lighthouse reports its missing prerequisite instead of a fake audit.
    await expect(driver.lighthouse(tab.id)).rejects.toThrow(/NOVACODE_DESKTOP_LIGHTHOUSE_CHROME/)

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
    // Screenshot + trace + cpu + heap captures, all materialized server-side.
    expect(driver.filesList(tab.id).files).toHaveLength(4)
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
