import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { BrowserSession } from "../src/session"

const hasChromium = await Bun.file(`${process.env.HOME}/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`)
  .exists()
  .catch(() => false)

const describeChromium = hasChromium ? describe : describe.skip

let server: ReturnType<typeof Bun.serve> | undefined
let baseURL = ""

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        `<!doctype html><html><head><title>Browser Test</title></head><body>` +
          `<h1>Hello</h1>` +
          `<button id="go">Click me</button>` +
          `<input id="name" type="text" />` +
          `<script>console.log("page ready");document.getElementById("go").addEventListener("click",()=>{document.title="clicked"})</script>` +
          `</body></html>`,
        { headers: { "content-type": "text/html" } },
      ),
  })
  baseURL = `http://127.0.0.1:${server.port}`
})

afterAll(() => server?.stop(true))

describeChromium("BrowserSession.Driver", () => {
  const dir = `${import.meta.dir}/driver-${Date.now()}`

  test("launch, tabs, and close lifecycle", async () => {
    const driver = new BrowserSession.Driver({ profileDir: `${dir}/profile`, captureDir: `${dir}/captures`, configDir: dir })
    await driver.launch()
    expect(driver.launched).toBe(true)

    const tab = await driver.openTab(undefined, true)
    expect(tab.id).toMatch(/^tab_/)
    expect(tab.url).toBe("about:blank")

    const state = driver.state()
    expect(state.tabs).toHaveLength(1)
    expect(state.focusedTabID).toBe(tab.id)

    const closed = await driver.closeTab(tab.id)
    expect(closed.tabs).toHaveLength(0)

    await driver.dispose()
    expect(driver.launched).toBe(false)
    await Bun.$`rm -rf ${dir}`.quiet()
  }, 60_000)

  test("navigate, snapshot refs, evaluate, click, fill", async () => {
    const driver = new BrowserSession.Driver({ profileDir: `${dir}/p2`, captureDir: `${dir}/c2`, configDir: dir })
    await driver.launch()
    const tab = await driver.openTab(baseURL, true)
    expect(tab.title).toBe("Browser Test")

    const snapshot = await driver.snapshot(tab.id, {})
    expect(snapshot.content).toContain("[ref=e")
    expect(snapshot.content).toContain("button")
    const buttonRef = snapshot.content.match(/button[^\[]*\[ref=(e\d+)\]/)?.[1]
    expect(buttonRef).toBeDefined()

    const evaluated = await driver.evaluate(tab.id, { script: "document.title" })
    expect(evaluated.value).toBe("Browser Test")

    await driver.click(tab.id, { ref: buttonRef! })
    await driver.wait(tab.id, { condition: "text", text: "Hello", timeoutMs: 5000 }).catch(() => {})
    const after = await driver.evaluate(tab.id, { script: "document.title" })
    expect(after.value).toBe("clicked")

    const snap2 = await driver.snapshot(tab.id, {})
    const inputRef = snap2.content.match(/textbox[^\[]*\[ref=(e\d+)\]/)?.[1]
    expect(inputRef).toBeDefined()
    await driver.fill(tab.id, { ref: inputRef!, text: "novacode" })
    const value = await driver.evaluate(tab.id, {
      ref: inputRef!,
      script: "(element) => element.value",
    })
    expect(value.value).toBe("novacode")

    await driver.dispose()
    await Bun.$`rm -rf ${dir}`.quiet()
  }, 90_000)

  test("screenshot, console, network, panel snapshot", async () => {
    const driver = new BrowserSession.Driver({ profileDir: `${dir}/p3`, captureDir: `${dir}/c3`, configDir: dir })
    await driver.launch()
    const tab = await driver.openTab(baseURL, true)

    const shot = await driver.screenshot(tab.id, {})
    expect(shot.files).toHaveLength(1)
    expect(shot.mime).toBe("image/png")
    // PNG magic bytes
    expect(shot.data[0]).toBe(0x89)
    expect(shot.data[1]).toBe(0x50)
    expect(await Bun.file(shot.files[0]!.path).exists()).toBe(true)

    const logs = await driver.console(tab.id, {})
    expect(logs.messages.some((message) => message.text.includes("page ready"))).toBe(true)

    const network = await driver.networkList(tab.id, {})
    expect(network.requests.some((request) => request.url.includes("127.0.0.1"))).toBe(true)

    const panel = await driver.panelSnapshot()
    expect(panel.focusedTabID).toBe(tab.id)
    expect(panel.screenshot?.mime).toBe("image/png")
    expect(panel.screenshot!.data.length).toBeGreaterThan(1000)
    expect(panel.recent).toContain(baseURL + "/")

    const listed = driver.filesList(tab.id)
    expect(listed.files.length).toBeGreaterThanOrEqual(1)

    await driver.dispose()
    await Bun.$`rm -rf ${dir}`.quiet()
  }, 90_000)

  test("unknown tab and stale ref produce clear errors", async () => {
    const driver = new BrowserSession.Driver({ profileDir: `${dir}/p4`, captureDir: `${dir}/c4`, configDir: dir })
    await driver.launch()
    const tab = await driver.openTab(baseURL, true)
    await expect(driver.snapshot("tab_00000000-0000-0000-0000-000000000000", {})).rejects.toThrow("Unknown tab")
    await expect(driver.click(tab.id, { ref: "e999" })).rejects.toThrow("stale")
    await driver.dispose()
    await Bun.$`rm -rf ${dir}`.quiet()
  }, 60_000)
})
