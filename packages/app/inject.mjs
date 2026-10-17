import { chromium } from "@playwright/test";
import { mockOpenCodeServer, currentSession } from "./e2e/utils/mock-server.ts";
import { base64Encode } from "@novacode-ai/core/util/encode";

const directory = "C:/OpenCode/SubagentNavigation";
const projectID = "proj_subagent_navigation";
const parentID = "ses_subagent_parent";
const childID = "ses_subagent_child";
const parentTitle = "Parent session";
const childTitle = "Subagent child session";
const taskDescription = "Inspect child navigation";

function session(id, title, created, extra) {
  return { id, slug: id, projectID, directory, title, version: "dev", time: { created, updated: created }, ...(extra||{}) };
}
function childSession(){ return session(childID, childTitle, 1700000001000, { parentID }); }
function parentMessages(){
  const userID="msg_user_0001", assistantID="msg_assistant_0001";
  return [
    { info:{id:userID,sessionID:parentID,role:"user",time:{created:1700000000000},agent:"build",model:{providerID:"opencode",modelID:"claude-opus-4-6"}}, parts:[{id:"prt_user_text_0001",sessionID:parentID,messageID:userID,type:"text",text:"Delegate work to a subagent"}]},
    { info:{id:assistantID,sessionID:parentID,role:"assistant",time:{created:1700000001000,completed:1700000002000},parentID:userID,modelID:"claude-opus-4-6",providerID:"opencode",mode:"build",agent:"build",path:{cwd:directory,root:directory},cost:0.01,tokens:{input:100,output:200,reasoning:0,cache:{read:0,write:0}},finish:"stop"}, parts:[{id:"prt_tool_task_0001",sessionID:parentID,messageID:assistantID,type:"tool",callID:"call_task_0001",tool:"task",state:{status:"completed",input:{description:taskDescription,subagent_type:"explore"},output:"Subagent finished",title:taskDescription,metadata:{sessionId:childID},time:{start:1700000001000,end:1700000002000}}}] }
  ];
}
function sessionHref(sid){
  const server=`http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`;
  return `http://127.0.0.1:3000/server/${base64Encode(server)}/session/${sid}`;
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport:{width:1440,height:900}, deviceScaleFactor:2 });
const page = await ctx.newPage();

await mockOpenCodeServer(page, {
  directory,
  project:{id:projectID,worktree:directory,vcs:"git",name:"subagent-navigation",time:{created:1700000000000,updated:1700000000000},sandboxes:[]},
  provider:{all:[{id:"opencode",name:"OpenCode",models:{"claude-opus-4-6":{id:"claude-opus-4-6",name:"Claude Opus 4.6",limit:{context:200_000}}}}],connected:["opencode"],default:{providerID:"opencode",modelID:"claude-opus-4-6"}},
  sessions:[session(parentID,parentTitle,1700000000000), childSession()],
  pageMessages:(sid)=>({items: sid===parentID ? parentMessages() : []}),
});

await page.route((url)=> url.pathname==="/api/session" && url.port===(process.env.PLAYWRIGHT_SERVER_PORT??"4096"), (route)=> route.fulfill({status:200,contentType:"application/json",headers:{"access-control-allow-origin":"*"}, body: JSON.stringify({data:[currentSession(session(parentID,parentTitle,1700000000000))], cursor:{}})}))

const server=`http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`;
await page.addInitScript(({directory,server,sessionId})=>{
  localStorage.setItem("settings.v3", JSON.stringify({general:{newLayoutDesigns:true}}));
  localStorage.setItem("opencode.global.dat:server", JSON.stringify({projects:{local:[{worktree:directory,expanded:true}]}, lastProject:{local:directory}}));
  localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify([{type:"session",server,sessionId}]));
},{directory,server,sessionId:parentID});

await page.goto(sessionHref(parentID), {waitUntil:"domcontentloaded"});
await page.waitForTimeout(2500);
console.log("url", page.url());
console.log("content snippet", (await page.content()).slice(0,3000));
const card = page.locator('[data-component="task-tool-card"]').first();
await card.waitFor({timeout:15000}).catch(async e=>{ console.log("card not found, body text:", (await page.locator("body").innerText()).slice(0,2000)); throw e; });
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(800);

// baseline
await page.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/live-baseline.png", fullPage:true});
await card.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/live-baseline-card.png"});

// inject CSS - scoped only to task card
const css = `
/* Only the sub-agent button - nothing else in chat */
[data-component="task-tool-card"]{
  border:0.5px solid var(--v2-border-border-base, #e5e7eb) !important;
  border-left:3px solid var(--task-agent-color, #2563eb) !important;
  border-radius:10px !important;
  overflow:hidden !important;
  background: var(--v2-background-bg-base, white) !important;
  box-shadow: 0 1px 2px rgba(0,0,0,.04) !important;
  transition: border-color .15s ease, box-shadow .15s ease !important;
}
[data-component="task-tool-card"]:hover{
  border-color: var(--v2-border-border-strong, #d1d5db) !important;
  box-shadow: 0 2px 8px rgba(0,0,0,.06) !important;
}
[data-component="task-tool-card"] [data-component="task-tool-surface"]{
  padding: 2px 0 !important;
}
/* pill for agent name - use existing data-component task-tool-title */
[data-component="task-tool-card"] [data-component="task-tool-title"]{
  display:inline-flex; align-items:center; gap:6px;
  padding:2px 8px; border-radius:999px;
  font-size:11px !important; font-weight:600 !important; letter-spacing:.02em;
  color: var(--task-agent-color, #2563eb) !important;
  background: color-mix(in srgb, var(--task-agent-color, #2563eb) 10%, white) !important;
  border:0.5px solid color-mix(in srgb, var(--task-agent-color, #2563eb) 18%, transparent) !important;
}
/* add subagent label via pseudo */
[data-component="task-tool-card"] [data-component="task-tool-title"]::after{
  content:" subagent";
  font-weight:500; opacity:.6; margin-left:2px;
}
/* description */
[data-component="task-tool-card"] [data-slot="basic-tool-tool-subtitle"]{
  font-size:13px !important; font-weight:500 !important; color: #111827 !important;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
/* footer hint */
[data-component="task-tool-card"] [data-component="task-tool-action"]{
  background:white; border:0.5px solid #e5e7eb; border-radius:6px; width:22px; height:22px;
}
`;
await page.addStyleTag({content: css});
await page.waitForTimeout(400);
await page.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/live-after.png", fullPage:true});
await card.screenshot({path:"C:/Users/jblix/AppData/Local/Temp/novacode/live-after-card.png"});
await browser.close();
console.log("done");
