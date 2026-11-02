import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { JsonLines, RpcDriver, ownedEnvironment, piStatus, type WireEvent } from "../web/server/pi.js";
import { createApp } from "../web/server/app.js";
import type { RunInfo } from "../web/shared.js";

const messages: WireEvent[]=[];const decoder=new JsonLines(e=>messages.push(e));
const raw=Buffer.from(JSON.stringify({type:"text",text:"中文分块😀\u2028保留\u2029换行"})+"\r\n"+JSON.stringify({type:"end"})+"\n");
for(let i=0;i<raw.length;i++)decoder.feed(raw.subarray(i,i+1));assert.equal(messages.length,2);assert.equal(messages[0].text,"中文分块😀\u2028保留\u2029换行");
const root=path.resolve("tests/tmp/web-rpc-tests");assert(root.startsWith(path.resolve("tests/tmp")+path.sep));await fs.rm(root,{recursive:true,force:true});await fs.mkdir(root,{recursive:true});
const fixture=path.join(root,"rpc-child.cjs");
await fs.writeFile(fixture,`const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',s=>{const c=JSON.parse(s);process.stdout.write(JSON.stringify({type:'response',id:c.id,success:true})+'\\n');if(c.type==='prompt'){process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'真实中文'}})+'\\n');}if(c.type==='abort')process.stdout.write(JSON.stringify({type:'agent_settled',aborted:true})+'\\n');if(c.type==='exit')process.exit(7);});`);
const events:WireEvent[]=[];const driver=new RpcDriver(process.execPath,[fixture],{cwd:root,env:process.env},e=>events.push(e));
const wait=async(p:()=>boolean|Promise<boolean>)=>{for(let i=0;i<300;i++){if(await p())return;await new Promise(r=>setTimeout(r,10));}throw new Error("timed out");};
await driver.prompt("开始");await wait(()=>events.length>0);assert.equal(events[0].assistantMessageEvent.delta,"真实中文");assert(!events.some(e=>e.type==="agent_settled"));await driver.abort();await wait(()=>events.some(e=>e.type==="agent_settled"));await driver.command("exit");await wait(()=>events.some(e=>e.type==="driver_error"));await driver.close();
const env=ownedEnvironment({projectRoot:path.resolve("."),dataRoot:root,workspace:path.join(root,"workspace"),documents:root,indexHome:root,settings:{baseUrl:"http://localhost/v1",model:"test",apiKey:"private"}});
assert(env.HOME!.startsWith(root));assert(env.PI_CODING_AGENT_DIR!.startsWith(root));assert.equal(env.FOLIO_WEB_MODEL_KEY,"private");assert.equal((await piStatus(path.resolve("."))).version,"1.4.0");
let emit:(e:WireEvent)=>void=()=>{},starts=0;
const {app,library,workshop}=await createApp({dataRoot:path.join(root,"data"),agentFactory:async(_c,sink)=>{emit=sink;return{async prompt(){starts++;},async abort(){sink({type:"agent_settled",aborted:true});},async close(){}};}});
try{
  await library.saveSettings({baseUrl:"http://localhost:9/v1",model:"test",apiKey:"masked-key"});await library.add("main","原文.md",Buffer.from("中文原文\n"));
  await app.listen({host:"127.0.0.1",port:0});const address=app.server.address();assert(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
  let run=(await app.inject({method:"POST",url:"/api/workspaces/main/runs",payload:{message:"查询"}})).json() as RunInfo;await wait(()=>starts===1);
  await app.inject({url:`/api/runs/${run.id}`});assert.equal(starts,1,"refresh only reads, does not restart");
  emit({type:"message_update",assistantMessageEvent:{type:"thinking_delta",delta:"private reasoning"}});
  emit({type:"tool_execution_start",toolName:"mcp__folio__folio_search",toolCallId:"s1",args:{query:"中文"}});
  emit({type:"tool_execution_end",toolName:"mcp__folio__folio_search",toolCallId:"s1",result:{content:[{type:"text",text:"no hits"}]},isError:false});
  emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"查询完成"}],stopReason:"stop"}});emit({type:"agent_end"});
  await wait(async()=> (await workshop.getRun(run.id)).events.some(e=>e.type==="answer"));assert.equal((await workshop.getRun(run.id)).status,"running");
  emit({type:"agent_settled"});await wait(async()=> (await workshop.getRun(run.id)).status==="completed");
  run=await workshop.getRun(run.id);assert(!JSON.stringify(run).includes("private reasoning"));assert.equal(run.events.find(e=>e.type==="tool_start")?.stage,"search");assert.deepEqual(run.events.map(e=>e.seq),run.events.map((_,i)=>i+1));
  const sse=await fetch(`${base}/api/runs/${run.id}/events?after=0`,{headers:{"Last-Event-ID":String(run.events.length-1)}});const reader=sse.body!.getReader(),chunk=await reader.read();const text=new TextDecoder().decode(chunk.value);assert(!text.includes('"seq":1,'));assert(text.includes(`"seq":${run.events.length},`));await reader.cancel();assert.equal(starts,1);
  const stop=(await app.inject({method:"POST",url:"/api/workspaces/main/runs",payload:{message:"停止测试"}})).json() as RunInfo;await wait(()=>starts===2);await app.inject({method:"POST",url:`/api/runs/${stop.id}/stop`});assert.equal((await workshop.getRun(stop.id)).status,"cancelled");
  const failed=(await app.inject({method:"POST",url:"/api/workspaces/main/runs",payload:{message:"错误测试"}})).json() as RunInfo;await wait(()=>starts===3);emit({type:"driver_error",message:"provider masked-key failed"});await wait(async()=> (await workshop.getRun(failed.id)).status==="failed");assert(!(await workshop.getRun(failed.id)).error!.includes("masked-key"));
  console.log("web-rpc: UTF8 JSONL, prompt acknowledgement, settled boundary, tool mapping, hidden reasoning, stop/error, SSE resume and refresh passed");
}finally{await app.close();}
