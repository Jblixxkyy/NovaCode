// Throwaway: drive the real settings color input and verify the group title follows, reporting crash details.
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
page.on("pageerror", (error) => console.log("pageerror:", String(error).slice(0, 800)))
page.on("console", (message) => {
  if (message.type() === "error") console.log("console error:", message.text().slice(0, 400))
})

await fx.setupTimeline(page, {
  messages: [fx.userMessage(), fx.assistantMessage([fx.shell("prt_sh1", "completed"), fx.shell("prt_sh2", "completed")])],
})
await page.locator('[data-component="used-tool-group-trigger"]').first().waitFor({ timeout: 30_000 })

await page.keyboard.press("Control+,")
const colorInput = page.locator('[data-action="settings-group-title-color"] input[type=color]')
await colorInput.waitFor({ timeout: 15_000 })
await colorInput.evaluate((element) => {
  const input = element as HTMLInputElement
  input.value = "#e00000"
  input.dispatchEvent(new Event("input", { bubbles: true }))
})

try {
  const crashed = page.getByText("Something went wrong", { exact: false }).first()
  await crashed.waitFor({ state: "attached", timeout: 3_000 })
  await page.getByText("Error Details", { exact: false }).first().click()
  await page.waitForTimeout(300)
  const text = await page.evaluate(() => {
    const pre = document.querySelector("pre")
    return pre?.textContent ?? ""
  })
  console.log("CRASH details:", (text ?? "").slice(0, 3000))
} catch {
  const textColor = await page.waitForFunction(
    () => {
      const element = document.querySelector('[data-slot="used-tool-group-title"]')
      return element?.querySelector('[data-slot="tool-status-done"]')
        ? getComputedStyle(element.querySelector('[data-slot="tool-status-done"]')!).color
        : null
    },
    { timeout: 5_000 },
  )
  const rootVar = await page.evaluate(() => document.documentElement.style.getPropertyValue("--group-title-color"))
  console.log("title color     :", await textColor.jsonValue())
  console.log("root var        :", rootVar)
  console.log(rootVar === "#e00000" && (await textColor.jsonValue()) === "rgb(224, 0, 0)" ? "PASS" : "FAIL")
}
await page.screenshot({ path: "C:/Users/jblix/AppData/Local/Temp/opencode/debug-group-crash.png" })
await browser.close()
