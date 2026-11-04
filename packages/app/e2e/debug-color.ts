import { chromium } from "@playwright/test"

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Users\\jblix\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe",
})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("console error:", msg.text().slice(0, 200))
})
await page.goto("http://localhost:4444", { waitUntil: "domcontentloaded", timeout: 120000 })
await page.waitForTimeout(4000)
await page.screenshot({ path: "../.out-debug/step1-initial.png" })
// dump interactive summary
const texts = await page.evaluate(() => {
  return Array.from(document.querySelectorAll("a,button,[role=button]"))
    .slice(0, 40)
    .map((el) => (el.textContent || "").trim().slice(0, 40))
    .filter(Boolean)
})
console.log(JSON.stringify(texts, null, 1))
await browser.close()
