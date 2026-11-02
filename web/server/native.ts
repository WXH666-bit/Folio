import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { dockerRun, dockerPath, holdDockerHost, dockerConnection } from "./docker-client.mjs";
import { RpcDriver, preparePiHome, type AgentContext, type AgentDriver, type WireEvent } from "./pi.js";
export const TOOL_IMAGE = "folio-comparison-tools:1";
const leases=new Map<string,{close():void}>();
export async function docker(args: string[], timeout=30000) {
  return dockerRun(args,timeout);
}
export async function sandboxStatus():Promise<{ready:boolean;image:string;error:string;transport?:string}> {
  try { const image=await docker(["image","inspect",TOOL_IMAGE,"--format","{{.Id}}"],12000);return {ready:true,image,error:"",transport:(await dockerConnection()).label}; }
  catch { return {ready:false,image:"",error:"现场对照需要准备隔离工具环境：npm run setup:compare"}; }
}
export function ownedContainer(id: string) { if(!/^[a-f0-9-]{36}$/.test(id))throw Error("Invalid comparison ID");return `folio-cmp-${id}`; }
export async function startSandbox(id: string, documents: string, readonlyNames: string[]) {
  const container=ownedContainer(id);
  leases.set(id,await holdDockerHost());
  try {
  const root=await dockerPath(documents);
  const bind=(source:string,target:string,readonly=false)=>["type=bind",...Object.entries({source,target}).map(([key,value])=>value.includes(',')?`"${key}=${value}"`:`${key}=${value}`),...(readonly?["readonly"]:[])].join(',');
  const args=["run","-d","--name",container,"--network","none","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges","--pids-limit","128","--tmpfs","/tmp:rw,nosuid,size=256m",...['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'].flatMap(key=>['--env',`${key}=`]),"--mount",bind(root,"/workspace")];
  // Protect unsupported source formats even from arbitrary native shell commands.
  for(const name of readonlyNames)args.push("--mount",bind(`${root}/${name}`,`/workspace/${name}`,true));
  args.push(TOOL_IMAGE);await docker(args);return container;
  }catch(error){leases.get(id)?.close();leases.delete(id);throw error;}
}
export async function removeSandbox(id:string) { try{await docker(["rm","-f",ownedContainer(id)]).catch(()=>{});}finally{leases.get(id)?.close();leases.delete(id);} }
export async function createNativeAgent(context:AgentContext, container:string, emit:(event:WireEvent)=>void):Promise<AgentDriver> {
  const {cli,sessions,env}=await preparePiHome(context);
  env.FOLIO_NATIVE_CONTAINER=container;
  env.DOCKER_CONFIG=process.env.DOCKER_CONFIG??path.join(os.homedir(),".docker");
  // Native bash's overflow files stay inside the mounted private copy, so read can expand them.
  env.TEMP=env.TMP=env.TMPDIR=path.join(context.documents,".tool-output");
  await fs.mkdir(env.TEMP,{recursive:true});
  env.FOLIO_NATIVE_SDK=path.join(context.projectRoot,"pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const prompt="你是文档助手，用中文简洁回答。你在执行一个不使用 Folio 的真实对照任务。使用 read/bash/edit/write 原生工具完成任务。bash 在 Linux 隔离工具环境执行，当前目录 /workspace，文件工具使用相对路径。Python3 已有 PyMuPDF(fitz)、python-docx、openpyxl、python-pptx、BeautifulSoup；也有 rg 和 pdftotext。没有联网能力，不要安装依赖或访问任何配置。只操作任务所选文件副本。TXT/MD/CSV/LOG 可以增删改正文；DOCX 只能替换文字；PDF/PPTX/XLSX/HTML 只读与建议，扫描件无 OCR。修改任务可直接修改本副本，准确报告实际改动，不需要等待网页确认。引用文件及页码或行号。只查询时不要修改文件。";
  const driver=new RpcDriver(process.execPath,[cli,"--mode","rpc","--session-dir",sessions,"--no-mcp","--no-context-files","--no-skills","--no-prompt-templates","--tools","read,bash,edit,write","-e",path.join(context.projectRoot,"web/server/native-extension.mjs"),"--model",`folio-web/${context.settings.model}`,"--thinking","off","--append-system-prompt",prompt],{cwd:context.documents,env},emit);
  try{await driver.initialize();}catch(error){await driver.close();throw error;}return driver;
}
