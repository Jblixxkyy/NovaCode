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
await page.waitForTimeout(1200);

// inject showcase that clones real card outside virtualizer - DOM inspect technique
await page.evaluate(()=>{
  const card = document.querySelector('[data-component="task-tool-card"]');
  if(!card) { console.log("no card"); return; }
  const wrapper = document.createElement("div");
  wrapper.id="mockup-showcase";
  wrapper.style.cssText="position:fixed; top:64px; left:50%; transform:translateX(-50%); width:min(560px, 90vw); background:white; border:1px solid #e5e7eb; border-radius:12px; padding:16px; box-shadow:0 8px 24px rgba(0,0,0,.12); z-index:9999; font-family:Inter,system-ui,sans-serif;";
  wrapper.innerHTML=`<div style="font:600 11px Inter; letter-spacing:.06em; text-transform:uppercase; color:#9ca3af; margin-bottom:8px;">Live DOM clone — only sub-agent button changed (real styles)</div>`;
  const clone = card.cloneNode(true);
  // enlarge clone container for visibility
  const holder = document.createElement("div");
  holder.style.cssText="padding:8px 0";
  holder.appendChild(clone);
  wrapper.appendChild(holder);
  const note = document.createElement("div");
  note.style.cssText="margin-top:8px; font:400 11px Inter; color:#6b7280; line-height:1.5;";
  note.textContent="This is the real [data-component=task-tool-card] from message-part.tsx:2134, cloned outside the virtualizer so you see it without scroll hacks. Chat behind is untouched.";
  wrapper.appendChild(note);
  document.body.appendChild(wrapper);
});
await page.waitForTimeout(600);
await page.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/dom-before.png", fullPage:false});
console.log("before");

// now inject scoped CSS only for task card
const css = `
#mockup-showcase [data-component="task-tool-card"]{
  border:0.5px solid var(--v2-border-border-base, #e5e7eb) !important;
  border-left:3px solid var(--task-agent-color, #2563eb) !important;
  border-radius:10px !important;
  overflow:hidden !important;
  background: var(--v2-background-bg-base, white) !important;
  box-shadow: 0 1px 2px rgba(0,0,0,.04) !important;
}
#mockup-showcase [data-component="task-tool-card"] [data-component="task-tool-title"]{
  display:inline-flex; align-items:center; gap:6px;
  padding:2px 8px; border-radius:999px;
  font-size:11px !important; font-weight:600 !important;
  color: var(--task-agent-color, #2563eb) !important;
  background: color-mix(in srgb, var(--task-agent-color, #2563eb) 10%, white) !important;
  border:0.5px solid color-mix(in srgb, var(--task-agent-color, #2563eb) 18%, transparent) !important;
}
#mockup-showcase [data-component="task-tool-card"] [data-component="task-tool-title"]::after{
  content:" subagent";
  font-weight:500; opacity:.55; margin-left:2px; font-size:11px;
}
#mockup-showcase [data-component="task-tool-card"] [data-slot="basic-tool-tool-subtitle"]{
  font-size:13px !important; font-weight:500 !important; color:#111827 !important;
}
`;
await page.addStyleTag({content: css});
await page.waitForTimeout(600);
await page.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/dom-after.png", fullPage:false});
console.log("after");

// keep vite open, close browser but leave vite
await browser.close();
console.log("done - vite still running on 12144");
