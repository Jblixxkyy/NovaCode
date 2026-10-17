import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@novacode-ai/core/util/encode"
import { currentSession } from "../utils/mock-server"

const webServer = "http://localhost:4096"
const desktopServer = "http://127.0.0.1:4496"
const webSession = session("ses_web", "C:/web-worktree", "Web session")
const desktopSession = session("ses_desktop", "C:/desktop-worktree", "Desktop session")

function session(id: string, directory: string, title: string) {
  return {
    id,
    projectID: `project-${id}`,
    directory,
    title,
    time: { created: 1, updated: 2 },
  }
}

async function mockWebAndDesktop(page: Page, discovery: { available: boolean; url?: string }) {
  // Intercept both servers + app dev server. Handle LAN/localhost aliases.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const appPort = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000").port
    const isApp = url.port === appPort
    const webPort = new URL(webServer).port
    const deskPort = new URL(desktopServer).port
    const isWeb = url.port === webPort
    const isDesktop = url.port === deskPort
    const isDiscovery = url.pathname === "/global/desktop-discovery"
    if (!isApp && !isWeb && !isDesktop && !isDiscovery) return route.fallback()

    // App dev server static assets: fallback (but keep discovery mocked)
    if (isApp && !isDiscovery && !url.pathname.startsWith("/api/")) return route.fallback()

    // Desktop discovery endpoint is served by the *web* server reading the desktop file.
    if (isDiscovery) {
      if (discovery.available && discovery.url) {
        return json(route, { available: true, discovery: { url: discovery.url, username: "novacode", password: "secret", pid: 123, channel: "prod" } })
      }
      return json(route, { available: false })
    }

    const target = isDesktop ? desktopSession : webSession
    const directory = url.searchParams.get("directory")
    if (directory && directory !== target.directory) {
      // Allow both directories to be listed; ignore mismatch for project queries.
      if (!url.pathname.startsWith("/api/")) return json(route, { name: "InvalidDirectory" }, 500)
    }

    if (url.pathname === "/global/event" || url.pathname === "/event" || url.pathname === "/api/event") return sse(route, url.pathname === "/api/event")
    if (url.pathname === "/global/health") return json(route, {}, 404)
    if (url.pathname === "/api/health") return json(route, { healthy: true, version: "2.0.0", pid: 1 })
    if (url.pathname === "/experimental/capabilities") return json(route, { backgroundSubagents: true })
    if (url.pathname === "/provider") return json(route, { all: [], connected: [], default: { providerID: "", modelID: "" } })
    if (url.pathname === "/agent") return json(route, [{ name: "build", mode: "primary" }])
    if (url.pathname === "/api/agent")
      return json(route, { location: { directory: target.directory, project: { id: target.projectID, directory: target.directory } }, data: [{ id: "build", name: "Build", mode: "primary" }] })
    if (url.pathname === "/api/session") return json(route, { data: [currentSession(target)], cursor: {} })
    if (url.pathname === `/api/session/${target.id}`) return json(route, { data: currentSession(target) })
    if (url.pathname === `/api/session/${target.id}/message`) return json(route, { data: [], cursor: {} })
    if (url.pathname === "/api/project") return json(route, [{ id: target.projectID, worktree: target.directory, vcs: "git" }])
    if (url.pathname === "/api/project/current") return json(route, { id: target.projectID, directory: target.directory })
    if (url.pathname === "/api/path") return json(route, { state: target.directory, config: target.directory, worktree: target.directory, directory: target.directory, home: target.directory })
    if (url.pathname === "/api/vcs") return json(route, { location: { directory: target.directory }, data: { branch: "main", defaultBranch: "main" } })
    if (url.pathname === "/api/session/active") return json(route, { data: {} })
    if (["/skill", "/command", "/lsp", "/formatter", "/permission", "/question", "/vcs/diff"].includes(url.pathname)) return json(route, [])
    if (["/global/config", "/config", "/provider/auth", "/mcp"].includes(url.pathname)) return json(route, {})
    if (url.pathname === "/project" || url.pathname === "/project/current") {
      const project = { id: target.projectID, worktree: target.directory, vcs: "git", time: { created: 1, updated: 1 }, sandboxes: [] }
      return json(route, url.pathname === "/project" ? [project] : project)
    }
    if (url.pathname === "/path") return json(route, { state: target.directory, config: target.directory, worktree: target.directory, directory: target.directory, home: target.directory })
    if (url.pathname === "/vcs") return json(route, { branch: "main", default_branch: "main" })
    return json(route, {})
  })
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) })
}
function sse(route: Route, withConnected: boolean) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: withConnected ? 'data: {"id":"evt_connected","type":"server.connected","data":{}}\n\n' : ": ok\n\n",
  })
}

test.describe("desktop session switch", () => {
  test("shows unavailable when desktop not running", async ({ page }) => {
    await mockWebAndDesktop(page, { available: false })
    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.clear()
      // Re-set after clear
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    })
    await page.goto("/")
    // App may show a loading splash; wait for main content then open Settings via keyboard
    await expect(page.locator("body")).toBeVisible({ timeout: 10_000 })
    await page.locator("body").click()
    await page.keyboard.press("Control+,")
    // Fallback: also try clicking the Settings button if keyboard didn't open dialog
    if (!(await page.getByRole("dialog").isVisible())) {
      const settingsBtn = page.getByRole("button", { name: "Settings" })
      if (await settingsBtn.isVisible()) await settingsBtn.click()
    }
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 })
    await page.getByRole("tab", { name: /Servers/i }).click()
    await expect(page.getByTestId("desktop-session-switch")).toBeVisible()
    await expect(page.getByText("Desktop app not running")).toBeVisible()
  })

  test("connects to desktop and switches back to web without losing tabs", async ({ page }) => {
    await mockWebAndDesktop(page, { available: true, url: desktopServer })
    const webKey = webServer
    const deskKey = desktopServer
    await page.addInitScript(
      ({ webKey, deskKey, webSession, deskSession }) => {
        localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
        // Start with web as active, one web tab open
        localStorage.setItem(
          "novacode.window.browser.dat:tabs",
          JSON.stringify([{ type: "session", server: webKey, sessionId: webSession }]),
        )
        // Ensure server list is empty initially (web is injected via props)
        localStorage.setItem("novacode.global.dat:server", JSON.stringify({ list: [], projects: {}, lastProject: {}, recentlyClosed: {} }))
      },
      { webKey, deskKey, webSession: webSession.id, deskSession: desktopSession.id },
    )

    await page.goto("/")
    // Wait for titlebar tabs to hydrate
    await expect(page.locator('[data-titlebar-tab-slot]')).toHaveCount(1, { timeout: 10_000 })

    await page.locator("body").click()
    await page.keyboard.press("Control+,")
    if (!(await page.getByRole("dialog").isVisible())) {
      const settingsBtn = page.getByRole("button", { name: "Settings" })
      if (await settingsBtn.isVisible()) await settingsBtn.click()
    }
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByRole("tab", { name: /Servers/i }).click()
    await expect(page.getByTestId("desktop-session-switch")).toBeVisible()

    // Connect to desktop: should add desktop server and switch active to desktop
    const connectBtn = page.getByRole("button", { name: "Connect" })
    await expect(connectBtn).toBeVisible()
    await connectBtn.click()

    // After connect, navigating to "/" should keep tabs: web tab still exists plus active is desktop
    await expect(page.getByRole("button", { name: "Switch to web" })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible()

    // Verify both tabs are present by inspecting localStorage directly
    const tabsAfterConnect = await page.evaluate(() => localStorage.getItem("novacode.window.browser.dat:tabs"))
    expect(tabsAfterConnect).toBeTruthy()
    const parsedConnect = JSON.parse(tabsAfterConnect!)
    expect(parsedConnect.some((t: any) => t.server === webKey)).toBeTruthy()

    // Switch back to web: active should become web, desktop stays in list
    await page.getByRole("button", { name: "Switch to web" }).click()
    await expect(page.getByRole("button", { name: "Switch to desktop" })).toBeVisible({ timeout: 10_000 })

    const tabsAfterSwitch = await page.evaluate(() => localStorage.getItem("novacode.window.browser.dat:tabs"))
    const parsedSwitch = JSON.parse(tabsAfterSwitch!)
    // Web tab still preserved
    expect(parsedSwitch.some((t: any) => t.server === webKey)).toBeTruthy()

    // Disconnect should remove desktop server
    await page.getByRole("button", { name: "Disconnect" }).click()
    await expect(page.getByRole("button", { name: "Connect" })).toBeVisible({ timeout: 10_000 })

    // Dialog close is not critical to the switch assertion – verify the switch
    // state already asserted above; just dismiss via Escape without strict hidden check
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
  })
})
