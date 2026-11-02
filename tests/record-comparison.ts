/** Explicitly record the three synthetic demo pairs. Never runs on normal application startup. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { DEMO_TASKS, type Comparison } from "../web/comparison-shared.js";
import type { WorkspaceInfo, Draft, RunInfo } from "../web/shared.js";
const base=process.env.FOLIO_COMPARE_RECORD_URL??"http://127.0.0.1:3212";
const caseKey=process.argv[2];
async function call<T>(url:string,body?:unknown):Promise<T>{const r=await fetch(base+url,body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error??String(r.status));return value as T;}
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let workspace=await call<WorkspaceInfo>("/api/workspaces/demo");
if(workspace.documents.length!==3){const seed=await call<RunInfo>("/api/workspaces/demo/examples",{});for(let i=0;i<120;i++){const r=await call<RunInfo>(`/api/runs/${seed.id}`);if(r.status==="completed")break;if(r.status==="failed")throw Error(r.error);await pause(500);}workspace=await call<WorkspaceInfo>("/api/workspaces/demo");}
const h=createHash("sha256");for(const file of ["web/server/comparison.ts","web/server/native.ts","web/server/native-extension.mjs","web/comparison-shared.ts"])h.update(await fs.readFile(file));const version=h.digest("hex");
for(const task of DEMO_TASKS.filter(t=>!caseKey||t.key===caseKey)){
 let c=await call<Comparison>("/api/comparisons",{workspace:"demo",documents:workspace.documents.map(d=>d.id),message:task.message,title:task.title});console.log(`Recording ${task.key}: ${c.id}`);
 let last="",approved=false;
 for(let i=0;i<420;i++){
  c=await call<Comparison>(`/api/comparisons/${c.id}`);
  const status=`${c.arms.native.status} | ${c.arms.folio.status} · ${c.events.filter(e=>e.type==="tool_start").map(e=>e.arm+":"+e.tool).join(",")}`;
  if(status!==last){console.log(status);last=status;}
  if(c.arms.folio.status==="awaiting_approval"&&!approved){const drafts=await call<Draft[]>(`/api/comparisons/${c.id}/drafts`);const keys=drafts.filter(d=>d.canApply&&d.status==="pending").map(d=>({doc:d.doc,id:d.id}));assert(keys.length);approved=true;c=await call<Comparison>(`/api/comparisons/${c.id}/apply`,{keys});console.log("Recorded confirmation via the explicit apply endpoint");}
  if(!["queued","running","awaiting_approval"].includes(c.status))break;
  await pause(1000);
 }
 if(["queued","running","awaiting_approval"].includes(c.status)){await call(`/api/comparisons/${c.id}/stop`,{});throw Error(`Recording timed out: ${c.id}`);}
 const outputs:Comparison["downloads"]={native:{},folio:{}};let verified=c.status==="completed";
 for(const arm of ["native","folio"] as const){
  for(const file of c.files){const response=await fetch(`${base}/api/comparisons/${c.id}/output/${arm}/${file.id}`);if(!response.ok){verified=false;continue;}const bytes=Buffer.from(await response.arrayBuffer());const original=await fs.readFile(path.join("tests/ab/corpus2",file.name));
   if(task.key==="edit"&&file.name==="财税_报销制度.md"){const expected=original.toString("utf8").replace("30 日内","15 日内");if(bytes.toString("utf8")!==expected)verified=false;}
   else if(task.key==="delete"&&file.name==="技术_值班记录.csv"){const expected=original.toString("utf8").split(/\r?\n/).filter(line=>!line.includes("作废记录")).join("\n");if(bytes.toString("utf8").replace(/\r\n/g,"\n")!==expected)verified=false;}
   else if(!bytes.equals(original))verified=false;
   if(!bytes.equals(original))outputs[arm]![file.name]=bytes.toString("base64");
  }
  if(task.key==="pdf"&&!/90/.test(c.arms[arm].answer))verified=false;
 }
 c.replayOnly=true;c.demoKey=task.key;c.downloads=outputs;c.recordingVersion=version;
 c.verification=verified?`预置断言通过：${task.key==="pdf"?"两边答复含 90 天，全部输入文档字节保持不变；原生工具生成的辅助文件另见文件变化":task.key==="edit"?"只替换报销期限，其余输入文档逐字节保持不变":"只删除作废记录，其余输入文档逐字节保持不变"}。${approved?"确认由采集验收脚本显式调用，回放不执行写回":"输入文档没有写回"}`:"本次真实记录包含未通过或未完成结果，需展开原文核对；没有替换为成功动画";
 // Export only normalized events and necessary artifacts, never raw pi sessions/configuration.
 const projectRoot=path.resolve(".");const redact=(value:any):any=>typeof value==="string"?value.split(projectRoot).join("<项目目录>").split(projectRoot.replace(/\\/g,"/")).join("<项目目录>"):Array.isArray(value)?value.map(redact):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v)])):value;
 await fs.mkdir("web/demos",{recursive:true});await fs.writeFile(`web/demos/${task.key}.json`,JSON.stringify(redact(c),null,2)+"\n");console.log(`Saved ${task.key}: ${c.status}, integrity=${verified}, native=${c.arms.native.inputTokens}, folio=${c.arms.folio.inputTokens}`);
}
