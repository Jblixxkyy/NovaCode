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
console.log("goto commit done, url", page.url());
await page.waitForLoadState("domcontentloaded", {timeout:60000});
console.log("domcontentloaded");
await page.getByRole("heading",{name:fixture.expected.targetTitle}).waitFor({timeout:30000});
await page.waitForTimeout(800);

// helper to find task card visible
async function findVisibleTask(){
  return page.evaluate(()=>{
    const scroller = [...document.querySelectorAll(".scroll-view__viewport")].find(el=> el.querySelector("[data-timeline-row]"));
    if(!scroller) return null;
    const cards = [...scroller.querySelectorAll('[data-component="task-tool-card"]')];
    for(const c of cards){
      const r=c.getBoundingClientRect(), vr=scroller.getBoundingClientRect();
      if(r.bottom>vr.top && r.top<vr.bottom) return true;
    }
    return false;
  });
}
let attempts=0;
await page.evaluate(()=>{
  const scroller=[...document.querySelectorAll(".scroll-view__viewport")].find(el=> el.querySelector("[data-timeline-row]"));
  if(scroller) scroller.scrollTop=0;
});
await page.waitForTimeout(600);
while(!(await findVisibleTask()) && attempts<40){
  await page.evaluate(()=>{
    const scroller=[...document.querySelectorAll(".scroll-view__viewport")].find(el=> el.querySelector("[data-timeline-row]"));
    if(scroller) scroller.scrollTop+=400;
  });
  await page.waitForTimeout(250);
  attempts++;
}
console.log("attempts",attempts, "found", await findVisibleTask());
const count = await page.locator('[data-component="task-tool-card"]').count();
console.log("total task count", count);
const card = page.locator('[data-component="task-tool-card"]').first();
await card.waitFor({timeout:10000});
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await page.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/live-baseline.png", fullPage:true});
await card.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/live-baseline-card.png"});
console.log("baseline done");

// inject only task card - scoped
const css = `
[data-component="task-tool-card"]{
  border:0.5px solid var(--v2-border-border-base, #e5e7eb) !important;
  border-left:3px solid var(--task-agent-color, #2563eb) !important;
  border-radius:10px !important;
  overflow:hidden !important;
  background: var(--v2-background-bg-base, white) !important;
  box-shadow: 0 1px 2px rgba(0,0,0,.04) !important;
}
[data-component="task-tool-card"]:hover{
  border-color: var(--v2-border-border-strong, #d1d5db) !important;
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
[data-component="task-tool-card"] [data-component="task-tool-action"]{
  background:white; border:0.5px solid #e5e7eb; border-radius:6px; width:22px; height:22px;
}
`;
await page.addStyleTag({content: css});
await page.waitForTimeout(500);
await page.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/live-after.png", fullPage:true});
await card.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/live-after-card.png"});
console.log("after done");
// keep browser open for iteration? close after 60s to allow further changes
await page.waitForTimeout(2000);
await browser.close();
console.log("done");
