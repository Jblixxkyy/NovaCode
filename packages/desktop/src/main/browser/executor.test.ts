import { describe, expect, test } from "bun:test"
import type { CdpSession } from "./cdp"
import {
  DesktopUnsupportedError,
  ensureCapture,
  executeDesktopAction,
  formatSnapshot,
  keyEventFor,
  stateOf,
  type AXNodeLike,
  type PageContents,
  type TabHandle,
  type TabInventory,
} from "./executor"

class FakeCdp implements CdpSession {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  evaluateResult: unknown = null
  private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()

  constructor(private nodes: AXNodeLike[]) {}

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    switch (method) {
      case "Accessibility.getFullAXTree":
        return { nodes: this.nodes }
      case "DOM.resolveNode":
        return { object: { objectId: `obj_${String(params?.backendNodeId)}` } }
      case "Runtime.evaluate": {
        const expression = String(params?.expression ?? "")
        if (expression.includes("__novacodeRefs")) return { result: { objectId: "obj_ref" } }
        return { result: { value: this.evaluateResult } }
      }
      case "DOM.getBoxModel":
        return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      case "DOM.getContentQuads":
        return { quads: [[0, 0, 100, 0, 100, 20, 0, 20]] }
      case "Page.captureScreenshot":
        return { data: "aGVsbG8=" }
      case "Page.getLayoutMetrics":
        return { cssContentSize: { width: 800, height: 2000 } }
      case "Network.getResponseBody":
        return { body: `{"ok":true}`, base64Encoded: false }
      default:
        return {}
    }
  }

  on(method: string, listener: (params: Record<string, unknown>) => void) {
    const set = this.listeners.get(method) ?? new Set()
    set.add(listener)
    this.listeners.set(method, set)
  }

  off(method: string, listener: (params: Record<string, unknown>) => void) {
    this.listeners.get(method)?.delete(listener)
  }

  emit(method: string, params: Record<string, unknown>) {
    for (const listener of [...(this.listeners.get(method) ?? [])]) listener(params)
  }

  isAttached() {
    return true
  }

  detach() {}
}

class FakeContents implements PageContents {
  url = "about:blank"
  title = ""
  loading = false
  back = false
  forward = false
  loaded: string[] = []

  constructor(readonly cdp: FakeCdp) {}

  getURL() {
    return this.url
  }
  getTitle() {
    return this.title
  }
  isLoading() {
    return this.loading
  }
  canGoBack() {
    return this.back
  }
  canGoForward() {
    return this.forward
  }
  goBack() {}
  goForward() {}
  reload() {}
  stop() {}
  async loadURL(url: string) {
    this.loaded.push(url)
    this.url = url
    this.title = "Loaded"
  }
  async onceLoaded() {}
  getViewportSize() {
    return { width: 1280, height: 800 }
  }
  stillCaptures = 0
  async capturePage() {
    this.stillCaptures += 1
    return { toPNG: () => Buffer.from("hello") }
  }
}

class FakeInventory implements TabInventory {
  tabs = new Map<string, TabHandle>()
  focused: string | null = null
  opened: Array<{ url: string | undefined; focus: boolean }> = []
  private counter = 0

  constructor(private cdp: FakeCdp) {}

  list() {
    return [...this.tabs.values()]
  }
  focusedID() {
    return this.focused
  }
  get(_scope: string, tabID: string) {
    return this.tabs.get(tabID)
  }
  async open(_scope: string, url: string | undefined, focus: boolean) {
    this.opened.push({ url, focus })
    this.counter += 1
    const contents = new FakeContents(this.cdp)
    const handle: TabHandle = {
      id: `tab_00000000-0000-4000-8000-00000000000${this.counter}`,
      contents,
      generation: 0,
      boxes: new Map(),
    }
    this.tabs.set(handle.id, handle)
    if (focus || !this.focused) this.focused = handle.id
    if (url) await contents.loadURL(url)
    return handle
  }
  focus(_scope: string, tabID: string) {
    const handle = this.tabs.get(tabID)
    if (handle) this.focused = tabID
    return handle
  }
  async close(_scope: string, tabID: string) {
    this.tabs.delete(tabID)
    if (this.focused === tabID) this.focused = [...this.tabs.keys()].pop() ?? null
  }
}

const NODES: AXNodeLike[] = [
  { nodeId: "1", role: { value: "WebArea" }, name: { value: "Page" }, backendDOMNodeId: 1, childIds: ["2", "3"] },
  { nodeId: "2", role: { value: "textbox" }, name: { value: "Search" }, backendDOMNodeId: 2 },
  {
    nodeId: "3",
    role: { value: "checkbox" },
    name: { value: "Agree" },
    backendDOMNodeId: 3,
    properties: [{ name: "checked", value: { value: true } }],
  },
  { nodeId: "4", role: { value: "generic" }, name: { value: "NoBackend" } },
]

const setup = () => {
  const cdp = new FakeCdp(NODES)
  const inventory = new FakeInventory(cdp)
  return { cdp, inventory }
}

describe("formatSnapshot", () => {
  test("mirrors the Playwright driver's line format", () => {
    const { lines, refs } = formatSnapshot(NODES, 20)
    expect(lines).toEqual([
      `- WebArea "Page" [ref=e1]`,
      `  - textbox "Search" [ref=e2]`,
      `  - checkbox "Agree" [checked] [ref=e3]`,
    ])
    expect([...refs.entries()]).toEqual([
      ["e1", 1],
      ["e2", 2],
      ["e3", 3],
    ])
  })

  test("respects the depth cap", () => {
    const { lines } = formatSnapshot(NODES, 0)
    expect(lines).toEqual([`- WebArea "Page" [ref=e1]`])
  })
})

describe("keyEventFor", () => {
  test("named keys, chords, and printable characters", () => {
    expect(keyEventFor("Enter")).toMatchObject({ key: "Enter", code: "Enter", modifiers: 0 })
    const chord = keyEventFor("Control+A")
    expect(chord).toMatchObject({ key: "A", code: "KeyA", modifiers: 2 })
    expect("text" in chord).toBe(false)
    expect(keyEventFor("Shift+Tab")).toMatchObject({ key: "Tab", modifiers: 8 })
    expect(keyEventFor("a")).toMatchObject({ key: "a", code: "KeyA", text: "a" })
    expect(keyEventFor("F5")).toMatchObject({ key: "F5", virtualKeyCode: 116 })
  })

  test("unknown keys and modifiers throw", () => {
    expect(() => keyEventFor("Hyper+A")).toThrow(/Unknown key modifier/)
    expect(() => keyEventFor("NotAKey")).toThrow(/Unknown key/)
  })
})

describe("executeDesktopAction", () => {
  test("tabs.open normalizes the URL and tabs.list reports the inventory", async () => {
    const { inventory } = setup()
    const tab = (await executeDesktopAction(inventory, "/work", { type: "tabs.open", url: "example.com" })) as {
      id: string
      url: string
    }
    expect(inventory.opened).toEqual([{ url: "https://example.com/", focus: true }])
    expect(tab.url).toBe("https://example.com/")
    const state = stateOf(inventory, "/work")
    expect(state.tabs).toHaveLength(1)
    expect(state.focusedTabID).toBe(tab.id)
  })

  test("unknown tabs are a clear error", async () => {
    const { inventory } = setup()
    await expect(
      executeDesktopAction(inventory, "/work", {
        type: "navigate",
        tabID: "tab_00000000-0000-4000-8000-000000000000" as never,
        url: "https://example.com",
      }),
    ).rejects.toThrow(/Unknown tab/)
  })

  test("snapshot formats content, registers refs, and returns boxes", async () => {
    const { cdp, inventory } = setup()
    const handle = await inventory.open("/work", "https://example.com", true)
    const result = (await executeDesktopAction(inventory, "/work", {
      type: "snapshot",
      tabID: handle.id as never,
      boxes: true,
    })) as { content: string; truncated: boolean; boxes: Record<string, unknown> }
    expect(result.content).toContain(`- textbox "Search" [ref=e2]`)
    expect(result.truncated).toBe(false)
    expect(Object.keys(result.boxes)).toEqual(["e1", "e2", "e3"])
    expect(result.boxes.e1).toEqual({ x: 0, y: 0, width: 10, height: 10 })
    expect(cdp.calls.filter((call) => call.method === "Runtime.callFunctionOn")).toHaveLength(3)
    expect(handle.generation).toBe(1)
  })

  test("click dispatches CDP mouse events at the element center", async () => {
    const { cdp, inventory } = setup()
    const handle = await inventory.open("/work", "https://example.com", true)
    await executeDesktopAction(inventory, "/work", { type: "click", tabID: handle.id as never, ref: "e2" as never })
    const mouse = cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent")
    expect(mouse.map((call) => call.params?.type)).toEqual(["mousePressed", "mouseReleased"])
    expect(mouse[0]?.params).toMatchObject({ x: 50, y: 10, button: "left" })
  })

  test("fill focuses the element and inserts text", async () => {
    const { cdp, inventory } = setup()
    const handle = await inventory.open("/work", "https://example.com", true)
    await executeDesktopAction(inventory, "/work", {
      type: "fill",
      tabID: handle.id as never,
      ref: "e2" as never,
      text: "hello",
    })
    expect(cdp.calls.some((call) => call.method === "Runtime.callFunctionOn")).toBe(true)
    const insert = cdp.calls.find((call) => call.method === "Input.insertText")
    expect(insert?.params).toEqual({ text: "hello" })
  })

  test("press dispatches a key chord with modifiers", async () => {
    const { cdp, inventory } = setup()
    const handle = await inventory.open("/work", "https://example.com", true)
    await executeDesktopAction(inventory, "/work", { type: "press", tabID: handle.id as never, key: "Control+A" })
    const keys = cdp.calls.filter((call) => call.method === "Input.dispatchKeyEvent")
    expect(keys.map((call) => call.params?.type)).toEqual(["keyDown", "keyUp"])
    expect(keys[0]?.params).toMatchObject({ key: "A", modifiers: 2 })
  })

  test("wait text resolves against page text", async () => {
    const { cdp, inventory } = setup()
    cdp.evaluateResult = true
    const handle = await inventory.open("/work", "https://example.com", true)
    const tab = (await executeDesktopAction(inventory, "/work", {
      type: "wait",
      tabID: handle.id as never,
      condition: "text",
      text: "hello",
    })) as { id: string }
    expect(tab.id).toBe(handle.id)
  })

  test("screenshot and panelStill return base64 captures", async () => {
    const { cdp, inventory } = setup()
    const handle = await inventory.open("/work", "https://example.com", true)
    const shot = (await executeDesktopAction(inventory, "/work", {
      type: "screenshot",
      tabID: handle.id as never,
    })) as { mime: string; data: string }
    expect(shot).toMatchObject({ mime: "image/png", data: "aGVsbG8=" })
    const still = (await executeDesktopAction(inventory, "/work", {
      type: "panelStill",
      tabID: handle.id as never,
    })) as { mime: string; data: string }
    expect(still).toEqual({ mime: "image/png", data: "aGVsbG8=" })
    // The still must come from capturePage: a CDP capture waits on a
    // compositor frame that an unpresented view never produces. Only the
    // screenshot action above may use CDP Page.captureScreenshot.
    expect((handle.contents as FakeContents).stillCaptures).toBe(1)
    expect(cdp.calls.filter((call) => call.method === "Page.captureScreenshot")).toHaveLength(1)
  })

  test("console reads CDP console events with driver-shaped entries and level filtering", async () => {
    const { cdp, inventory } = setup()
    const handle = await inventory.open("/work", "https://example.com", true)
    await ensureCapture(handle)
    cdp.emit("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "hello world" }],
      stackTrace: { callFrames: [{ url: "https://example.com/app.js", lineNumber: 3, columnNumber: 5 }] },
    })
    cdp.emit("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "it broke" }] })
    cdp.emit("Runtime.exceptionThrown", {
      exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: nope is not defined" } },
    })
    const all = (await executeDesktopAction(inventory, "/work", {
      type: "console",
      tabID: handle.id as never,
    })) as { messages: Array<{ level: string; text: string; source?: { url: string; line: number } }>; dropped: number }
    expect(all.messages.map((message) => message.text)).toEqual([
      "hello world",
      "it broke",
      "ReferenceError: nope is not defined",
    ])
    expect(all.messages[0]?.level).toBe("info")
    expect(all.messages[0]?.source).toEqual({ url: "https://example.com/app.js", line: 3, column: 5 })
    expect(all.dropped).toBe(0)
    const errors = (await executeDesktopAction(inventory, "/work", {
      type: "console",
      tabID: handle.id as never,
      level: "error",
    })) as { messages: Array<{ text: string }> }
    expect(errors.messages.map((message) => message.text)).toEqual(["it broke", "ReferenceError: nope is not defined"])
  })

  test("network lists finished requests and network.get returns headers and bodies", async () => {
    const { cdp, inventory } = setup()
    const handle = await inventory.open("/work", "https://example.com", true)
    await ensureCapture(handle)
    cdp.emit("Network.requestWillBeSent", {
      requestId: "r1",
      type: "Fetch",
      request: { url: "https://example.com/api", method: "POST", headers: { "X-A": "1" }, postData: "payload" },
    })
    cdp.emit("Network.responseReceived", {
      requestId: "r1",
      response: { status: 201, headers: { "Content-Type": "application/json" } },
    })
    cdp.emit("Network.loadingFinished", { requestId: "r1" })
    const list = (await executeDesktopAction(inventory, "/work", {
      type: "network.list",
      tabID: handle.id as never,
    })) as { requests: Array<{ id: string; state: string; statusCode?: number; resourceType: string }> }
    expect(list.requests).toHaveLength(1)
    expect(list.requests[0]).toMatchObject({ id: "r1", state: "completed", statusCode: 201, resourceType: "fetch" })
    const got = (await executeDesktopAction(inventory, "/work", {
      type: "network.get",
      tabID: handle.id as never,
      id: "r1",
      includeBody: true,
    })) as {
      requestHeaders: Array<{ name: string; value: string }>
      requestBody: { state: string; text?: string }
      responseBody: { state: string; text?: string }
    }
    expect(got.requestHeaders).toEqual([{ name: "X-A", value: "1" }])
    expect(got.requestBody).toEqual({ state: "text", text: "payload", truncated: false })
    expect(got.responseBody).toEqual({ state: "text", text: `{"ok":true}`, truncated: false })
    await expect(
      executeDesktopAction(inventory, "/work", { type: "network.get", tabID: handle.id as never, id: "nope" }),
    ).rejects.toThrow(/Unknown request nope/)
  })

  test("drag dispatches a pressed mouse path between element centers", async () => {
    const { cdp, inventory } = setup()
    const handle = await inventory.open("/work", "https://example.com", true)
    await executeDesktopAction(inventory, "/work", { type: "snapshot", tabID: handle.id as never })
    await executeDesktopAction(inventory, "/work", {
      type: "drag",
      tabID: handle.id as never,
      from: "e1" as never,
      to: "e2" as never,
    })
    const mouse = cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent")
    // move + press + 12 interpolated moves + release
    expect(mouse).toHaveLength(15)
    expect(mouse[0]?.params).toMatchObject({ type: "mouseMoved" })
    expect(mouse[1]?.params).toMatchObject({ type: "mousePressed", button: "left", buttons: 1 })
    expect(mouse[13]?.params).toMatchObject({ type: "mouseMoved", buttons: 1 })
    expect(mouse[14]?.params).toMatchObject({ type: "mouseReleased", button: "left", buttons: 0 })
  })

  test("dialog routes through the CDP pending-dialog model", async () => {
    const { cdp, inventory } = setup()
    const handle = await inventory.open("/work", "https://example.com", true)
    await ensureCapture(handle)
    const none = (await executeDesktopAction(inventory, "/work", {
      type: "dialog",
      tabID: handle.id as never,
      action: "get",
    })) as { dialog: unknown }
    expect(none.dialog).toBeNull()
    await expect(
      executeDesktopAction(inventory, "/work", { type: "dialog", tabID: handle.id as never, action: "accept" }),
    ).rejects.toThrow(/No dialog is open in this tab/)
    cdp.emit("Page.javascriptDialogOpening", { type: "prompt", message: "Name?", defaultPrompt: "anon" })
    const open = (await executeDesktopAction(inventory, "/work", {
      type: "dialog",
      tabID: handle.id as never,
      action: "get",
    })) as { dialog: { type: string; message: string; defaultValue: string } | null }
    expect(open.dialog).toEqual({ type: "prompt", message: "Name?", defaultValue: "anon" })
    await executeDesktopAction(inventory, "/work", {
      type: "dialog",
      tabID: handle.id as never,
      action: "accept",
      promptText: "josh",
    })
    expect(cdp.calls).toContainEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: true, promptText: "josh" },
    })
    const closed = (await executeDesktopAction(inventory, "/work", {
      type: "dialog",
      tabID: handle.id as never,
      action: "get",
    })) as { dialog: unknown }
    expect(closed.dialog).toBeNull()
  })

  test("unsupported actions raise DesktopUnsupportedError", async () => {
    const { inventory } = setup()
    const handle = await inventory.open("/work", "https://example.com", true)
    // Heap analysis runs server-side in the Driver and is never forwarded.
    await expect(
      executeDesktopAction(inventory, "/work", {
        type: "heap.summary",
        tabID: handle.id as never,
        fileID: "file_unknown",
      } as never),
    ).rejects.toBeInstanceOf(DesktopUnsupportedError)
  })
})
