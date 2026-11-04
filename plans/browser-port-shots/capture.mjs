// Browser panel screenshot capture for the NovaCode browser-port feature.
// Run with: node capture.mjs
// Requires: backend on :4096, app dev server on :4444 (both should already be running).
// Saves PNGs to this directory: novacode-panel-*.png
//
// NOTE: This script was written without live testing (author cannot operate a
// browser). It attempts the likely UI flow with generous waits and logs each
// step. If selectors miss, use the manual steps in the parent report.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = dirname(fileURLToPath(import.meta.url));
mkdirSync(outDir, { recursive: true });

const APP = "http://127.0.0.1:4444";
const shot = (page, name) => page.screenshot({ path: join(outDir, name) });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

console.log("== step 1: load app ==");
await page.goto(APP, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
await shot(page, "novacode-panel-00-app-loaded.png");
console.log("title:", await page.title());

// Dump interactive elements to help diagnose the flow.
const controls = await page.$$eval("button, a, input, [role=tab]", (els) =>
  els.slice(0, 40).map((el) => ({
    tag: el.tagName,
    text: (el.textContent || "").trim().slice(0, 40),
    testid: el.getAttribute("data-testid") || el.getAttribute("data-component") || "",
  })),
);
console.log("controls:", JSON.stringify(controls, null, 1).slice(0, 2000));

console.log("== step 2: look for a way to open/create a session ==");
// Try common "new session" affordances; adjust if the UI differs.
const newSessionCandidates = [
  "button:has-text('New session')",
  "button:has-text('New Session')",
  "a:has-text('New session')",
  "[data-testid='new-session']",
];
let opened = false;
for (const sel of newSessionCandidates) {
  if (await page.locator(sel).count()) {
    console.log("clicking:", sel);
    await page.locator(sel).first().click();
    opened = true;
    break;
  }
}
if (!opened) console.log("no new-session button found; dumping links");
await page.waitForTimeout(3000);
await shot(page, "novacode-panel-01-after-new-session.png");
console.log("url:", page.url());

console.log("== step 3: open the Browser tab in the right panel ==");
const browserTabCandidates = [
  "[role=tab]:has-text('Browser')",
  "button:has-text('Browser')",
  "[data-testid='tab-browser']",
];
for (const sel of browserTabCandidates) {
  if (await page.locator(sel).count()) {
    console.log("clicking browser tab:", sel);
    await page.locator(sel).first().click();
    break;
  }
}
await page.waitForTimeout(4000);
await shot(page, "novacode-panel-02-browser-empty.png");
console.log("url:", page.url());

console.log("== step 4: navigate via the address bar ==");
const addressCandidates = [
  "#browser-panel input",
  "[data-testid='browser-address'] input",
  "#browser-panel [contenteditable]",
];
for (const sel of addressCandidates) {
  if (await page.locator(sel).count()) {
    console.log("filling address:", sel);
    await page.locator(sel).first().click();
    await page.locator(sel).first().fill("https://example.com");
    await page.keyboard.press("Enter");
    break;
  }
}
await page.waitForTimeout(8000);
await shot(page, "novacode-panel-03-browser-loaded.png");

console.log("== step 5: top bar close-up ==");
const topbar = page.locator("#browser-panel");
if (await topbar.count()) {
  await topbar.screenshot({ path: join(outDir, "novacode-panel-04-topbar.png") });
} else {
  await shot(page, "novacode-panel-04-topbar.png");
}

console.log("done. files in", outDir);
await browser.close();
