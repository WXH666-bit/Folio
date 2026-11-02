import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { startSandbox, removeSandbox, docker, ownedContainer } from "../web/server/native.js";
// @ts-ignore Loaded by pi; the test invokes the same extension without making model calls.
import extension from "../web/server/native-extension.mjs";
const project=path.resolve("."),root=path.resolve("tests/tmp/native-sandbox"),documents=path.join(root,"documents"),id=randomUUID();
assert(root.startsWith(path.resolve("tests/tmp")+path.sep));await fs.rm(root,{recursive:true,force:true});await fs.mkdir(documents,{recursive:true});await fs.writeFile(path.join(documents,"说明.md"),"原文30日\n保留记录\n");await fs.writeFile(path.join(documents,"只读,材料.pdf"),"readonly");
const savedCwd=process.cwd();const tools=new Map<string,any>(),hooks=new Map<string,any>();
try{
 const container=await startSandbox(id,documents,["只读,材料.pdf"]);
 process.env.FOLIO_NATIVE_CONTAINER=container;process.env.FOLIO_NATIVE_SDK=path.join(project,"pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
 process.env.PI_CODING_AGENT_DIR=path.join(root,"private-pi");process.env.HOME=process.env.USERPROFILE=path.join(root,"runtime-home");process.env.FOLIO_WEB_MODEL_KEY="sandbox-key-must-stay-outside";
 process.chdir(documents);await extension({registerTool(tool:any){tools.set(tool.name,tool);},on(name:string,handler:any){hooks.set(name,handler);}});
 async function invoke(name:string,args:any){const event={toolName:name,input:args};const rejected=hooks.get("tool_call")?.(event);if(rejected?.block)throw Error(rejected.reason);return tools.get(name).execute(randomUUID(),args,undefined,undefined,{cwd:documents});}
 const read=await invoke("read",{path:"/workspace/说明.md"});assert(read.content.some((c:any)=>c.text?.includes("原文30日")));
 await invoke("edit",{path:"说明.md",edits:[{oldText:"原文30日",newText:"原文15日"}]});assert.equal(await fs.readFile(path.join(documents,"说明.md"),"utf8"),"原文15日\n保留记录\n");
 await assert.rejects(()=>invoke("read",{path:path.join(root,"outside-secret.txt")}));
 const env=await invoke("bash",{command:"python3 -c \"import os; print('SECRET_PRESENT' if os.getenv('FOLIO_WEB_MODEL_KEY') else 'NO_SECRET'); print('SOCKET_PRESENT' if os.path.exists('/var/run/docker.sock') else 'NO_SOCKET')\""});const text=env.content.map((c:any)=>c.text??"").join("");assert(text.includes("NO_SECRET"));assert(text.includes("NO_SOCKET"));
 const blocked=await invoke("bash",{command:"python3 -c \"open('只读,材料.pdf','wb').write(b'bad')\""});assert.equal(blocked.isError,true);assert.equal(await fs.readFile(path.join(documents,"只读,材料.pdf"),"utf8"),"readonly");
 await new Promise(r=>setTimeout(r,13000));assert.equal(await docker(["inspect",ownedContainer(id),"--format","{{.State.Running}}"]),"true","model idle time must not shut down the WSL tool container");
 await invoke("read",{path:"说明.md"});console.log("native sandbox: real native read/edit/bash, Unicode paths, comma filename, scope guard, no key/socket, read-only formats and WSL idle lifecycle passed");
}finally{process.chdir(savedCwd);await removeSandbox(id);}
