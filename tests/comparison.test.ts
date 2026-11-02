import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../web/server/app.js";
import { addRevision } from "../src/revisions.js";
import { Store } from "../src/store.js";
import { chapters, statusAt, answerAt, type Comparison } from "../web/comparison-shared.js";
import { nativeStage } from "../web/server/comparison.js";
import { connectionFor,dockerInvocation,mappedHostDataPath } from "../web/server/docker-client.mjs";
import type { AgentContext, WireEvent } from "../web/server/pi.js";
// @ts-ignore Plain JS extension is intentionally loaded by pi rather than compiled.
import { remotePath } from "../web/server/native-extension.mjs";

const root=path.resolve("tests/tmp/comparison-tests");assert(root.startsWith(path.resolve("tests/tmp")+path.sep));await fs.rm(root,{recursive:true,force:true});
let nativeEmit:(e:WireEvent)=>void=()=>{},folioEmit:(e:WireEvent)=>void=()=>{},folioContext:AgentContext,nativeContext:AgentContext;
let nativePrompts=0,folioPrompts=0,removed=0;
const sandbox={async status(){return{ready:true,image:"test-image",error:""};},async start(){return"owned-test";},async remove(){removed++;}};
const {app,library,comparisons}=await createApp({dataRoot:root,comparisonDependencies:{sandbox,
  nativeFactory:async(context,_id,emit)=>{nativeContext=context;nativeEmit=emit;return{async prompt(){nativePrompts++;},async abort(){emit({type:"agent_settled",aborted:true});},async close(){}};},
  folioFactory:async(context,emit)=>{folioContext=context;folioEmit=emit;return{async prompt(){folioPrompts++;},async abort(){emit({type:"agent_settled",aborted:true});},async close(){}};}
}});
const request=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,...(payload===undefined?{}:{payload})});
const wait=async(test:()=>boolean|Promise<boolean>)=>{for(let n=0;n<300;n++){if(await test())return;await new Promise(r=>setTimeout(r,10));}throw Error("timed out");};
const messageEnd=(emit:typeof nativeEmit,text:string)=>emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text},{type:"thinking",thinking:"never show"}],usage:{input:40,cacheRead:7,output:9},stopReason:"stop"}});
const begin=async(ids:string[])=>{const before=nativePrompts;const response=await request("POST","/api/comparisons",{workspace:"main",documents:ids,message:"将报销期限30日改为15日，其他保持"});assert.equal(response.statusCode,200,response.body);const c=response.json() as Comparison;await wait(()=>nativePrompts>before&&folioPrompts>before);return c;};
try{
 await library.saveSettings({baseUrl:"http://localhost:9/v1",model:"paired",apiKey:"test-secret"});
 const file=await library.add("main","报销.md",Buffer.from("期限30日\n保留这一行\n"));const source=(await library.file("main",file.id)).source,original=await fs.readFile(source);
 assert.equal((await request("POST","/api/comparisons",{workspace:"main",documents:[],message:"x"})).statusCode,400);
 const c=await begin([file.id]);assert.equal(c.files[0].hash.length,64);assert.notEqual(nativeContext!.workspace,folioContext!.workspace);assert.equal(nativeContext!.settings.model,folioContext!.settings.model);assert(!nativeContext!.documents.includes(".pi"));
 assert.equal((await request("POST","/api/comparisons",{workspace:"main",documents:[file.id],message:"again"})).statusCode,409);
 assert.deepEqual(await fs.readFile(path.join(comparisons.folder(c.id),"input",file.name)),original);assert.deepEqual(await fs.readFile(path.join(nativeContext!.documents,file.name)),original);assert.deepEqual(await fs.readFile(path.join(folioContext!.documents,file.name)),original);
 nativeEmit({type:"tool_execution_start",toolName:"read",toolCallId:"read1",args:{path:"报销.md"}});
 nativeEmit({type:"tool_execution_end",toolName:"read",toolCallId:"read1",result:{content:[{type:"text",text:"期限30日\n保留这一行"}]}});
 nativeEmit({type:"tool_execution_start",toolName:"edit",toolCallId:"edit1",args:{path:"报销.md",edits:[{oldText:"30日",newText:"15日"}]}});
 await fs.writeFile(path.join(nativeContext!.documents,file.name),"期限15日\n保留这一行\n");
 nativeEmit({type:"tool_execution_end",toolName:"edit",toolCallId:"edit1",result:{content:[{type:"text",text:"success"}]}});messageEnd(nativeEmit,"已直接修改副本");nativeEmit({type:"agent_end"});
 await wait(async()=> (await comparisons.get(c.id)).events.some(e=>e.tool==="edit"&&e.type==="tool_end"));assert.equal((await comparisons.get(c.id)).arms.native.status,"running","agent_end cannot finish native");nativeEmit({type:"agent_settled"});
 const store=new Store(folioContext!.documents,folioContext!.indexHome);const rev=await addRevision(store,{doc:file.name,target:"¶1",text:"期限15日"});
 folioEmit({type:"tool_execution_start",toolName:"mcp__folio__folio_revise",toolCallId:"f1",args:{doc:file.name,target:"¶1"}});folioEmit({type:"tool_execution_end",toolName:"mcp__folio__folio_revise",toolCallId:"f1",result:{content:[{type:"text",text:`proposed ${rev.id} — ${file.name}`} ]}});messageEnd(folioEmit,"已修改！（不能越过真实状态）");folioEmit({type:"agent_settled"});
 await wait(async()=> (await comparisons.get(c.id)).status==="awaiting_approval");
 let state=await comparisons.get(c.id);assert.deepEqual(await fs.readFile(source),original);assert.deepEqual(await fs.readFile(path.join(folioContext!.documents,file.name)),original);assert.equal(state.arms.native.changes[0].status,"modified");assert.equal(state.arms.folio.changes[0].status,"unchanged");assert(!JSON.stringify(state).includes("never show"));assert(!JSON.stringify(state).includes("test-secret"));
 assert.equal(state.arms.native.inputTokens,47);assert.equal(state.arms.folio.inputTokens,47);assert(state.events.some(e=>e.arm==="native"&&e.type==="native_write"));assert(!state.events.some(e=>e.arm==="folio"&&e.type==="applied"));
 assert.equal((await request("POST",`/api/comparisons/${c.id}/apply`,{keys:[]})).statusCode,400);
 assert.equal((await request("POST",`/api/comparisons/${c.id}/apply`,{keys:[{doc:file.name,id:"r999"}]})).statusCode,409);
 await new Promise(r=>setTimeout(r,20));const approved=await request("POST",`/api/comparisons/${c.id}/apply`,{keys:[{doc:file.name,id:rev.id}]});assert.equal(approved.statusCode,200,approved.body);state=approved.json();assert.equal(state.status,"completed");assert(state.arms.folio.confirmationMs>0);assert.equal(state.arms.folio.changes[0].status,"modified");assert.deepEqual(await fs.readFile(source),original);
 for(const arm of ["native","folio"]){const output=await request("GET",`/api/comparisons/${c.id}/output/${arm}/${file.id}`);assert.equal(output.body,"期限15日\n保留这一行\n");}
 const preview=(await request("GET",`/api/comparisons/${c.id}/input/${file.id}/preview`)).json();assert.equal(preview.lines[0].text,"期限30日");
 assert.deepEqual(state.events.map(e=>e.seq),state.events.map((_,i)=>i+1));assert(state.events.every(e=>e.comparisonId===c.id&&e.originalAt&&e.runId));
 const phases=chapters(state.events);assert(phases.some(ch=>ch.stage==="draft"));assert(phases.some(ch=>ch.stage==="delivery"));const earlier=state.events.filter(e=>e.seq<=state.events.find(e=>e.type==="native_write")!.seq);assert.notEqual(statusAt(earlier,"native"),"completed");assert.equal(answerAt(state.events,"native"),"已直接修改副本");
 const p=nativePrompts;await request("GET",`/api/comparisons/${c.id}`);assert.equal(nativePrompts,p,"refresh must not restart");
 await app.listen({host:"127.0.0.1",port:0});const addr=app.server.address();assert(addr&&typeof addr!=="string");const response=await fetch(`http://127.0.0.1:${addr.port}/api/comparisons/${c.id}/events?after=0`,{headers:{"Last-Event-ID":String(state.events.length-1)}});const reader=response.body!.getReader(),chunk=await reader.read();const events=new TextDecoder().decode(chunk.value);assert(events.includes(`"seq":${state.events.length}`));assert(!events.includes('"seq":1,'));await reader.cancel();
 const quiet=await fetch(`http://127.0.0.1:${addr.port}/api/comparisons/${c.id}/events?after=${state.events.length}`,{signal:AbortSignal.timeout(1500)});assert.equal(quiet.status,200,"a resumed quiet stream must open before its next heartbeat");await quiet.body!.cancel();
 const next=await begin([file.id]);await request("POST",`/api/comparisons/${next.id}/stop`);assert.equal((await comparisons.get(next.id)).status,"cancelled");assert.deepEqual(await fs.readFile(source),original);
 const failed=await begin([file.id]);nativeEmit({type:"driver_error",message:"test-secret provider failed"});await wait(async()=> (await comparisons.get(failed.id)).arms.native.status==="failed");assert(!(await comparisons.get(failed.id)).arms.native.error!.includes("test-secret"));await request("POST",`/api/comparisons/${failed.id}/stop`);
  const empty=await library.add("main","空白.md",Buffer.alloc(0));const noText=await begin([empty.id]);assert((await comparisons.get(noText.id)).events.some(e=>e.type==="indexed"&&e.state==="waiting"));await request("POST",`/api/comparisons/${noText.id}/stop`);
 assert.equal(nativeStage("bash",{command:"rg 期限 报销.md"}),"search");assert.equal(nativeStage("bash",{command:"open('a.md','w').write('x')"}),"draft");
 assert.equal(remotePath(root,path.join(root,"文档.md")),"/workspace/文档.md");assert.throws(()=>remotePath(root,path.resolve("README.md")));assert.throws(()=>remotePath(root,"/workspace/../../etc/passwd"));
 assert(removed>0);console.log("comparison: equal inputs, isolated sessions/copies, genuine write state, approval, counters, replay boundaries, stop/error, SSE resume and refresh passed");
  assert.deepEqual(dockerInvocation(["exec","example","bash"],connectionFor("auto","linux",true)),{command:"docker",args:["exec","example","bash"]});
  assert.equal(connectionFor("auto","darwin",true).kind,"direct");assert.equal(connectionFor("auto","win32",true).kind,"direct");
  assert.equal(mappedHostDataPath(path.join(root,"comparisons/id/documents"),root,"/srv/folio/data"),"/srv/folio/data/comparisons/id/documents");assert.equal(mappedHostDataPath(path.resolve(root,"../outside"),root,"/srv/folio/data"),undefined);
  assert.deepEqual(connectionFor("wsl","win32",false,"Debian").prefix,["-d","Debian","--exec","docker"]);assert.deepEqual(connectionFor("auto","win32",false).prefix,["--exec","docker"]);assert.throws(()=>connectionFor("auto","linux",false));
}finally{await app.close();}

