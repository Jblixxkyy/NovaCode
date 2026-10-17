import { chromium } from "@playwright/test";
import { mockOpenCodeServer } from "./e2e/utils/mock-server.ts";
import { fixture, pageMessages } from "./e2e/smoke/session-timeline.fixture.ts";
import { base64Encode } from "@novacode-ai/core/util/encode";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport:{width:1440,height:900}, deviceScaleFactor:2 });
const page = await ctx.newPage();

await mockOpenCodeServer(page, {
  sessions: fixture.sessions,
  provider: fixture.provider,
  directory: fixture.directory,
  project: fixture.project,
  pageMessages,
});
await page.addInitScript((directory)=>{
  localStorage.setItem("settings.v3", JSON.stringify({general:{editToolPartsExpanded:true,shellToolPartsExpanded:true,showReasoningSummaries:true}}));
  localStorage.setItem("opencode.global.dat:server", JSON.stringify({projects:{local:[{worktree:directory,expanded:true}]}, lastProject:{local:directory}}));
}, fixture.directory);

await page.goto(`http://127.0.0.1:3000/${base64Encode(fixture.directory)}/session/${fixture.targetID}`, {waitUntil:"commit", timeout:60000});
await page.waitForLoadState("domcontentloaded", {timeout:60000});
await page.getByRole("heading",{name:fixture.expected.targetTitle}).waitFor({timeout:30000});
await page.waitForTimeout(1000);

// force scroll to top and wait for virtualizer stable
await page.evaluate(()=>{
  const scroller=[...document.querySelectorAll(".scroll-view__viewport")].find(el=> el.querySelector("[data-timeline-row]"));
  if(scroller) scroller.scrollTop=0;
});
await page.waitForTimeout(800);

// un-clip virtual rows for screenshot
await page.addStyleTag({content:`
  [data-timeline-key]{ overflow: visible !important; overflow-clip-margin: unset !important; }
  [style*="overflow: clip"]{ overflow: visible !important; }
`});

const card = page.locator('[data-component="task-tool-card"]').first();
await card.waitFor({timeout:10000});
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await card.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/focus-before.png"});
console.log("before card shot");

// scoped injection - only task button
const css = `
[data-component="task-tool-card"]{
  border:0.5px solid var(--v2-border-border-base, #e5e7eb) !important;
  border-left:3px solid var(--task-agent-color, #2563eb) !important;
  border-radius:10px !important;
  overflow:hidden !important;
  background: var(--v2-background-bg-base, white) !important;
  box-shadow: 0 1px 2px rgba(0,0,0,.04) !important;
}
[data-component="task-tool-card"] [data-component="task-tool-title"]{
  display:inline-flex; align-items:center; gap:6px;
  padding:2px 8px; border-radius:999px;
  font-size:11px !important; font-weight:600 !important;
  color: var(--task-agent-color, #2563eb) !important;
  background: color-mix(in srgb, var(--task-agent-color, #2563eb) 10%, white) !important;
  border:0.5px solid color-mix(in srgb, var(--task-agent-color, #2563eb) 18%, transparent) !important;
}
[data-component="task-tool-card"] [data-component="task-tool-title"]::after{
  content:" subagent";
  font-weight:500; opacity:.55; margin-left:2px; font-size:11px;
}
[data-component="task-tool-card"] [data-slot="basic-tool-tool-subtitle"]{
  font-size:13px !important; font-weight:500 !important; color:#111827 !important;
}
`;
await page.addStyleTag({content: css});
await page.waitForTimeout(500);
await card.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/focus-after.png"});
await page.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/focus-full-after.png", fullPage:false});
console.log("after done");
await browser.close();
console.log("done keep vite open");
