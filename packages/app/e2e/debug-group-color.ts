// Throwaway debug script (not a test): isolate why the "Group title color" setting doesn't recolor group titles.
import { chromium } from "@playwright/test"
import * as fx from "./performance/timeline-stability/fixture"

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Users\\jblix\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe",
})
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  baseURL: "http://localhost:4444",
})
page.on("pageerror", (error) => console.log("pageerror:", String(error).slice(0, 500)))
page.on("crash", () => console.log("PAGE CRASHED"))
page.on("console", (message) => {
  const origin = message.location().url ?? ""
  if (origin.startsWith("http://localhost:4444/node_modules")) return
  console.log(`console ${message.type()}:`, message.text().slice(0, 300))
})

await fx.setupTimeline(page, {
  messages: [fx.userMessage(), fx.assistantMessage([fx.shell("prt_sh1", "completed"), fx.shell("prt_sh2", "completed")])],
})

const titleColor = () =>
  page.evaluate(() => {
    const element = document.querySelector('[data-slot="used-tool-group-title"]')
    const status = element?.querySelector('[data-slot="tool-status-done"]')
    return {
      found: !!element,
      color: element ? getComputedStyle(element).color : null,
      textColor: status ? getComputedStyle(status).color : null,
      groupTriggers: document.querySelectorAll('[data-component="used-tool-group-trigger"]').length,
      rootVar: document.documentElement.style.getPropertyValue("--group-title-color"),
      settingsOnDisk: localStorage.getItem("settings.v3")?.slice(0, 400) ?? null,
    }
  })

const usedGroup = page.locator('[data-component="used-tool-group-trigger"]').first()
await usedGroup.waitFor({ timeout: 30_000 })
console.log("default          :", JSON.stringify(await titleColor()))

// Settings UI path: open the dialog with the keybind and drive the real color input.
await page.keyboard.press("Control+,")
const action = process.env.DEBUG_ACTION ?? "settings-group-title-color"
const dialog = page.locator(".settings-v2-dialog")
await dialog.waitFor({ timeout: 15_000 })
if (process.env.DEBUG_MODE === "switch") {
  await page
    .locator('[data-action="settings-feed-edit-tool-parts-expanded"]')
    .locator('[data-slot="switch-control"]')
    .click()
  console.log("toggled edit-tool-parts switch")
} else {
  const colorInput = page.locator(`[data-action="${action}"] input[type=color]`)
  await colorInput.waitFor({ timeout: 15_000 })
  await colorInput.evaluate((element) => {
    const input = element as HTMLInputElement
    input.value = "#e00000"
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
console.log("immediately after :", JSON.stringify(await titleColor()))
console.log("error banner      :", await page.evaluate(() => {
  const elements = Array.from(document.querySelectorAll("div,p,span"))
  return elements
    .map((element) => element.textContent ?? "")
    .filter((text) => text.includes("report this error") || text.includes("Discord"))
    .slice(0, 2)
    .join(" | ")
    .slice(0, 300)
}))
try {
  await page.getByText("Error Details", { exact: false }).first().click({ timeout: 3_000 })
} catch {
  console.log("error details     : expander not found")
}
try {
  await page.waitForTimeout(300)
  const text = await page.evaluate(() => {
    const field = document.querySelector("[class*='max-h-96']")
    return field?.textContent ?? document.body.innerText
  })
  console.log("crash error text  :", text?.replace(/\s+/g, " ").slice(0, 2500))
} catch {
  console.log("page closed before crash text")
}
console.log("page url          :", page.url())
try {
  await page.screenshot({ path: "C:/Users/jblix/AppData/Local/Temp/opencode/debug-group-color-crash.png", timeout: 5_000 })
} catch {
  console.log("page closed before screenshot")
}
await browser.close()
console.log("done")
