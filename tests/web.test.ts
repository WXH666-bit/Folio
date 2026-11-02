import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../web/server/app.js";
import { addRevision, applyRevisions, listRevisions } from "../src/revisions.js";
import type { WireEvent } from "../web/server/pi.js";
import type { RunInfo } from "../web/shared.js";

const dataRoot = path.resolve("tests/tmp/web-tests");
assert(dataRoot.startsWith(path.resolve("tests/tmp") + path.sep));
await fs.rm(dataRoot, { recursive: true, force: true });
let wire: (event: WireEvent) => void = () => {}, prompts = 0;
const { app, library, workshop } = await createApp({ dataRoot, agentFactory: async (_context, emit) => {
  wire = emit; return { async prompt() { prompts++; }, async abort() { emit({type:"agent_settled",aborted:true}); }, async close() {} };
} });
const request = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, ...(payload === undefined ? {} : {payload}) });
const wait = async (predicate: () => boolean|Promise<boolean>) => { for(let n=0;n<200;n++){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error("timed out"); };
async function upload(name: string, text: string|Buffer) {
  const job = (await request("POST","/api/workspaces/main/uploads")).json();
  const boundary="folio-boundary";
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),Buffer.isBuffer(text)?text:Buffer.from(text),Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return app.inject({method:"POST",url:`/api/workspaces/main/documents?run=${job.id}`,headers:{"content-type":`multipart/form-data; boundary=${boundary}`},payload:body});
}
async function task() { const r=(await request("POST","/api/workspaces/main/runs",{message:"修改报销时限"})).json() as RunInfo; await wait(()=>prompts>0);return r; }
async function settle(run: RunInfo, text="已修改并保存！") {
  wire({type:"message_end",message:{role:"assistant",content:[{type:"text",text},{type:"thinking",thinking:"hidden"}],stopReason:"stop",usage:{input:12,output:4}}});
  wire({type:"agent_end"}); await new Promise(r=>setTimeout(r,30));assert.equal((await workshop.getRun(run.id)).status,"running","agent_end is not settled");
  wire({type:"agent_settled"});await wait(async()=> (await workshop.getRun(run.id)).status!=="running");
}
async function propose(run:RunInfo, doc:string, target:string, text:string) {
  const revision=await addRevision(library.store("main"),{doc,target,text});
  wire({type:"tool_execution_start",toolName:"mcp__folio__folio_revise",toolCallId:doc+revision.id,args:{doc,target,text}});
  wire({type:"tool_execution_end",toolName:"mcp__folio__folio_revise",toolCallId:doc+revision.id,result:{content:[{type:"text",text:`proposed ${revision.id}: ${doc}`} ]},isError:false});
  await wait(async()=> (await workshop.getRun(run.id)).revisionKeys.some(k=>k.id===revision.id&&k.doc===doc));return revision;
}
try {
  assert.equal((await request("GET","/api/status")).statusCode,200);
  assert.equal((await app.inject({method:"GET",url:"/api/status",headers:{host:"evil.test"}})).statusCode,403);
  assert.equal((await app.inject({method:"POST",url:"/api/workspaces/main/uploads",headers:{origin:"https://evil.test"}})).statusCode,403);
  const config=await request("PUT","/api/settings",{baseUrl:"http://127.0.0.1:9/v1",model:"test",apiKey:"secret-test-key"});assert.equal(config.statusCode,200);assert(!config.body.includes("secret-test-key"));
  assert(!(await request("GET","/api/settings")).body.includes("secret-test-key"));
  assert.equal((await upload("报销.md","报销时限为30天。\n作废记录\n保留记录\n")).statusCode,200);
  assert.equal((await upload("报销.md","重复文件独立保存\n")).statusCode,200);
  assert.equal((await upload("不支持.exe","bad")).statusCode,415);
  await assert.rejects(()=>library.add("main","../escape.md",Buffer.from("bad")));
  const docs=(await library.workspace("main")).documents;assert.equal(docs.length,2);assert.equal(docs[1].name,"报销 (2).md");
  const doc=docs[0],file=await library.file("main",doc.id),content=()=>fs.readFile(file.source,"utf8");
  const preview=(await request("GET",`/api/workspaces/main/documents/${doc.id}/preview`)).json();assert.equal(preview.lines[0].text,"报销时限为30天。");
  const run=await task(), revision=await propose(run,doc.name,"¶1","报销时限为15天。");
  wire({type:"tool_execution_start",toolName:"mcp__folio__folio_page",toolCallId:"page",args:{doc:doc.name}});
  wire({type:"tool_execution_end",toolName:"mcp__folio__folio_page",toolCallId:"page",result:{content:[{type:"text",text:`${doc.name} [version=${doc.version}]\n${doc.name}:¶1:L1  报销时限为30天。`}]}});
  await settle(run);
  let saved=await workshop.getRun(run.id);assert.equal(saved.status,"awaiting_approval");assert.equal(saved.outcome,"proposals");assert((await content()).includes("30天"));assert(!saved.events.some(e=>e.type==="applied"));assert.equal(saved.events.flatMap(e=>e.references??[])[0].docId,doc.id);assert(!JSON.stringify(saved).includes("hidden"));
  assert.equal((await request("POST",`/api/runs/${run.id}/apply`,{keys:[]})).statusCode,400);
  assert.equal((await request("POST",`/api/runs/${run.id}/apply`,{keys:[{doc:doc.name,id:"r999"}]})).statusCode,409);
  const unowned=await addRevision(file.store,{doc:docs[1].name,target:"¶1",text:"其他任务的修改"});
  assert.equal((await request("POST",`/api/runs/${run.id}/apply`,{keys:[{doc:docs[1].name,id:unowned.id}]})).statusCode,409);
  const applied=await request("POST",`/api/runs/${run.id}/apply`,{keys:[{doc:doc.name,id:revision.id}]});assert.equal(applied.statusCode,200);assert.equal(applied.json().outcome,"written");assert((await content()).includes("15天"));
  assert.equal(applied.json().events.filter((e:any)=>e.stage==="approval").at(-1).state,"done");
  const download=await request("GET",`/api/workspaces/main/documents/${doc.id}/content?download=1`);assert.equal(download.body,await content());assert(download.headers["content-disposition"]?.includes("attachment"));
  assert.equal((await request("GET",`/api/workspaces/main/documents/${doc.id}/preview?version=${doc.version}`)).statusCode,409);
  prompts=0;const cancelled=await task(), r2=await propose(cancelled,doc.name,"¶1","不应写入");await settle(cancelled);
  assert.equal((await request("POST",`/api/runs/${cancelled.id}/discard`)).statusCode,200);
  assert.equal((await listRevisions(file.store,doc.name)).find(r=>r.id===r2.id)?.status,"discarded");
  assert.equal((await request("POST",`/api/runs/${cancelled.id}/apply`,{keys:[{doc:doc.name,id:r2.id}]})).statusCode,409);
  await applyRevisions(file.store,doc.name,[]);assert(!(await content()).includes("不应写入"),"discarded cannot apply later via MCP");
  prompts=0;const stale=await task(),r3=await propose(stale,doc.name,"¶1","旧版本修改");await settle(stale);
  await fs.writeFile(file.source,"外部更新\n");const conflict=await request("POST",`/api/runs/${stale.id}/apply`,{keys:[{doc:doc.name,id:r3.id}]});assert.equal(conflict.json().outcome,"partial");assert.equal(await content(),"外部更新\n");assert(!conflict.json().events.some((e:any)=>e.type==="applied"&&e.state==="done"));
  assert.equal((await upload("页面.html","<p>安全文本</p><script>alert('x')</script>")).statusCode,200);
  const html=(await library.workspace("main")).documents.find(d=>d.kind==="html")!;assert.deepEqual(html.editableActions,[]);
  assert.equal((await request("GET",`/api/workspaces/main/documents/${html.id}/content`)).headers["content-type"],"application/octet-stream");
  await upload("空白.md","");const empty=(await library.workspace("main")).documents.find(d=>d.name==="空白.md")!;
  assert.equal((await request("GET",`/api/workspaces/main/documents/${empty.id}/preview`)).statusCode,200);
  for (const name of ["培训_课程大纲.pptx","政府_预算表.xlsx","政府_签到表_扫描件.pdf"]) {
    assert.equal((await upload(name,await fs.readFile(path.join("tests/ab/corpus2",name)))).statusCode,200);
    const uploaded=(await library.workspace("main")).documents.find(d=>d.name===name)!;assert.deepEqual(uploaded.editableActions,[]);
    const preview=await request("GET",`/api/workspaces/main/documents/${uploaded.id}/preview`);assert.equal(preview.statusCode,200);
    if(uploaded.kind==="pdf"){assert.equal(preview.json().doc.status,"no_text");assert(preview.json().labels.length>0);assert.deepEqual(preview.json().lines,[]);}
  }
  prompts=0;const readonly=await task(),r4=await propose(readonly,html.name,"¶1","建议文本");await settle(readonly);assert.equal((await workshop.getRun(readonly.id)).status,"completed");assert.equal((await request("POST",`/api/runs/${readonly.id}/apply`,{keys:[{doc:html.name,id:r4.id}]})).statusCode,409);
  await upload("副本.docx",await fs.readFile("tests/fixtures/付款条款_内部说明.docx"));const docx=(await library.workspace("main")).documents.find(d=>d.kind==="docx")!;assert.deepEqual(docx.editableActions,["replace"]);
  assert.equal((await request("PATCH",`/api/workspaces/main/documents/${doc.id}`,{name:"报销 (2).md"})).statusCode,409);
  assert.equal((await request("PATCH",`/api/workspaces/main/documents/${doc.id}`,{name:"报销.txt"})).statusCode,400);
  assert.equal((await request("PATCH",`/api/workspaces/main/documents/${doc.id}`,{name:"新名称.md"})).statusCode,200);
  assert.equal((await request("DELETE",`/api/workspaces/main/documents/${doc.id}`)).statusCode,200);
  assert.equal((await request("GET",`/api/workspaces/main/documents/${doc.id}/content`)).statusCode,404);
  prompts=0;const mixed=await task(),approved=await propose(mixed,docs[1].name,"¶1","已确认的内容");const remaining=await propose(mixed,html.name,"¶1","未确认的建议");await settle(mixed);
  await request("POST",`/api/runs/${mixed.id}/apply`,{keys:[{doc:docs[1].name,id:approved.id}]});
  const discarded=await request("POST",`/api/runs/${mixed.id}/discard`);assert.equal(discarded.json().outcome,"partial");assert(discarded.json().events.some((e:any)=>e.type==="applied"&&e.state==="done"));assert.equal((await listRevisions(file.store,html.name)).find(r=>r.id===remaining.id)?.status,"discarded");
  assert.equal((await request("GET",`/api/workspaces/main/documents/${docs[1].id}/content?download=1`)).body,"已确认的内容\n");
  console.log("web: upload/name isolation, capabilities, references, human approval, discard, conflicts, downloads, rename/delete passed");
} finally { await app.close(); }
