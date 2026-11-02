import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Library, HttpError, editableActions, type PrivateSettings } from "./library.js";
import { Workshop } from "./workshop.js";
import { createPiAgent, type AgentDriver, type AgentFactory, type WireEvent } from "./pi.js";
import { createNativeAgent, removeSandbox, sandboxStatus, startSandbox } from "./native.js";
import { parseFile, detectKind } from "../../src/parse.js";
import { writeAtomic } from "../../src/store.js";
import type { Arm, ArmResult, Comparison, ComparisonEvent, ComparisonSummary, FileChange } from "../comparison-shared.js";
import type { Draft, FlowEvent, Preview, RunInfo, Stage } from "../shared.js";

export interface ComparisonDependencies {
  folioFactory?: AgentFactory;
  nativeFactory?: (context: Parameters<AgentFactory>[0], id:string, emit:(event:WireEvent)=>void)=>Promise<AgentDriver>;
  sandbox?: { status:typeof sandboxStatus; start:typeof startSandbox; remove:typeof removeSandbox };
}
interface Runtime { folio: Workshop; folioLibrary: Library; native?: AgentDriver; queue:Promise<unknown>; settings:PrivateSettings; nativeSeq:number; nativeStop?:string; accepting?:boolean; tools:Map<string,{at:number;stage:Stage;args:Record<string,unknown>}>; stop:boolean; }
const initialArm=():ArmResult=>({runId:randomUUID(),status:"queued",answer:"",inputTokens:0,outputTokens:0,indexMs:0,confirmationMs:0,toolCalls:0,returnedChars:0,toolMs:0,changes:[]});
const terminal=(s:string)=>["completed","failed","cancelled","interrupted"].includes(s);
const hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
function plain(event:WireEvent) {return (event.result?.content??[]).filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");}
export function nativeStage(tool:string,args:Record<string,unknown>):Stage {
  if(tool==="read")return "evidence";
  if(tool==="edit"||tool==="write")return "draft";
  const command=String(args.command??"");
  if(/(?:save\(|write_text\(|write_bytes\(|open\([^\n]*['"](?:w|a)|\.write\(|unlink\(|remove\(|sed\s+-i)/.test(command))return "draft";
  if(/(?:^|[;\n])\s*(?:ls|find|pwd)\b/.test(command)&&!/(?:grep|rg\s|python|pdftotext)/.test(command))return "inbox";
  if(/(?:grep|\brg\b|search|find\(|re\.|\bin\s+|if\s|关键词|备份|报销|作废)/.test(command))return "search";
  return "evidence";
}
export class Comparisons {
  readonly events=new EventEmitter();
  readonly items=new Map<string,Comparison>();
  private runtime=new Map<string,Runtime>();
  private writes=new Map<string,Promise<unknown>>();
  private busy=false;
  private verifiedInputs=new Map<string,{mtime:number;size:number;hash:string}>();
  private sandbox: NonNullable<ComparisonDependencies["sandbox"]>;
  constructor(readonly library:Library,readonly dependencies:ComparisonDependencies={}) {this.sandbox=dependencies.sandbox??{status:sandboxStatus,start:startSandbox,remove:removeSandbox};this.events.setMaxListeners(100);}
  folder(id:string) {if(!/^[a-f0-9-]{36}$/.test(id))throw new HttpError(400,"对照标识无效");return path.join(this.library.dataRoot,"comparisons",id);}
  async init() {
    let ids:string[]=[];try{ids=await fs.readdir(path.join(this.library.dataRoot,"comparisons"));}catch{}
    for(const id of ids){try{const c=JSON.parse(await fs.readFile(path.join(this.folder(id),"comparison.json"),"utf8")) as Comparison;c.events=(await fs.readFile(path.join(this.folder(id),"events.jsonl"),"utf8").catch(()=>"")).split("\n").filter(Boolean).flatMap(s=>{try{return[JSON.parse(s)];}catch{return[];}});
      if(c.status==="running"||c.status==="queued"){c.status="interrupted";for(const arm of ["native","folio"] as const)if(!terminal(c.arms[arm].status)){c.arms[arm].status="interrupted";c.arms[arm].error="服务重启，对照已中断，没有自动重跑。";}await this.sandbox.remove(c.id);}
      this.items.set(c.id,c);await this.save(c);
    }catch{}}
    const demoFolder=path.join(this.library.projectRoot,"web/demos");
    for(const name of await fs.readdir(demoFolder).catch(()=>[]))if(name.endsWith(".json")){
      const c=JSON.parse(await fs.readFile(path.join(demoFolder,name),"utf8")) as Comparison;
      c.replayOnly=true;this.items.set(c.id,c);
    }
  }
  isBusy(){return this.busy||[...this.items.values()].some(c=>["queued","running"].includes(c.status));}
  async environment(){return this.sandbox.status();}
  async save(c:Comparison){const {events:_,...meta}=c;const task=(this.writes.get(c.id)??Promise.resolve()).then(()=>writeAtomic(path.join(this.folder(c.id),"comparison.json"),JSON.stringify(meta)));this.writes.set(c.id,task);await task;}
  async get(id:string){const c=this.items.get(id);if(!c)throw new HttpError(404,"没有这场对照");return c;}
  async history():Promise<ComparisonSummary[]>{return [...this.items.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(({id,title,createdAt,status,replayOnly})=>({id,title,createdAt,status,replayOnly}));}
  private async emit(c:Comparison,arm:Arm,event:Omit<ComparisonEvent,"comparisonId"|"arm"|"seq"|"at">){
    const runtime=this.runtime.get(c.id),key=runtime?.settings.apiKey??"";
    const clean=(value:any):any=>typeof value==="string"&&key?value.split(key).join("[已隐藏密钥]"):Array.isArray(value)?value.map(clean):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v)])):value;
    const full:ComparisonEvent=clean({...event,comparisonId:c.id,arm,seq:c.events.length+1,at:new Date().toISOString()});c.events.push(full);
    const task=(this.writes.get(c.id)??Promise.resolve()).then(()=>fs.appendFile(path.join(this.folder(c.id),"events.jsonl"),JSON.stringify(full)+"\n"));this.writes.set(c.id,task);await task;this.events.emit(c.id,full);return full;
  }
  private async ownEvent(c:Comparison,arm:Arm,type:string,stage:Stage,state:FlowEvent["state"],message:string,extra:Partial<ComparisonEvent>={}){
    return this.emit(c,arm,{runId:c.arms[arm].runId,originalSeq:0,originalAt:new Date().toISOString(),type,stage,state,message,...extra});
  }
  async create(ws:string,ids:string[],message:string,title?:string){
    if(this.isBusy())throw new HttpError(409,"已有一场现场对照正在运行，请先停止或等待结束");
    if(!ids.length||new Set(ids).size!==ids.length)throw new HttpError(400,"请选择不重复的对照文件");
    if(!message.trim()||message.length>12000)throw new HttpError(400,"请填写对照任务（最多 12000 字符）");
    this.busy=true;
    try{
      const settings=await this.library.settings();if(!settings.apiKey||!settings.model||!settings.baseUrl)throw new HttpError(409,"请先回到工坊连接模型");
      const environment=await this.sandbox.status();if(!environment.ready)throw new HttpError(409,environment.error);
      const selected=await Promise.all(ids.map(id=>this.library.file(ws,id)));
      const c:Comparison={id:randomUUID(),title:title??message.slice(0,45),message,createdAt:new Date().toISOString(),model:settings.model,piVersion:"1.4.0",sourceWorkspace:ws,status:"queued",files:[],arms:{native:initialArm(),folio:initialArm()},events:[],sourceVersion:"",environment:environment.image,verification:"任意上传任务的答案与修改意图需人工核对"};
      const folder=this.folder(c.id);await fs.mkdir(path.join(folder,"input"),{recursive:true});await fs.mkdir(path.join(folder,"native/documents"),{recursive:true});
      c.runtime=`应用端 ${process.platform} · ${environment.transport??"注入的测试后端"} 工具执行`;
      for(const source of selected){const data=await fs.readFile(source.source),digest=hash(data);if(source.entry?.contentHash&&source.entry.contentHash!==digest)throw new HttpError(409,`${source.file.name} 已改变，请先刷新索引`);await fs.writeFile(path.join(folder,"input",source.file.name),data);await fs.writeFile(path.join(folder,"native/documents",source.file.name),data);c.files.push({id:source.file.id,name:source.file.name,kind:source.entry?.kind??detectKind(source.file.name)??"text",size:data.length,hash:digest,sourceVersion:source.entry?.revision});}
      c.sourceVersion=hash(Buffer.from(JSON.stringify(c.files.map(f=>[f.name,f.hash]))));
      const lib=new Library(path.join(folder,"folio"),this.library.projectRoot,{...settings});const workshop=new Workshop(lib,this.dependencies.folioFactory??createPiAgent);
      await workshop.init();this.runtime.set(c.id,{folio:workshop,folioLibrary:lib,settings:{...settings},queue:Promise.resolve(),nativeSeq:0,tools:new Map(),stop:false});
      this.items.set(c.id,c);await this.save(c);void this.execute(c).catch(error=>this.preparationFailure(c,error));return c;
    }finally{this.busy=false;}
  }
  private async execute(c:Comparison){
    const runtime=this.runtime.get(c.id)!;c.status="running";const start=new Date().toISOString();for(const side of ["native","folio"] as const){c.arms[side].startedAt=start;c.arms[side].status="running";await this.ownEvent(c,side,"prepared","inbox","done",`${c.files.length} 份相同版本的文件副本已送达`);}await this.save(c);
    await Promise.allSettled([this.runNative(c),this.runFolio(c)]);
  }
  private async preparationFailure(c:Comparison,error:unknown){for(const arm of ["native","folio"] as const)if(!terminal(c.arms[arm].status))await this.fail(c,arm,error);}
  private async runFolio(c:Comparison){
    const r=this.runtime.get(c.id)!;
    try{
      for(const file of c.files){if(r.stop)return;const begin=Date.now();await this.ownEvent(c,"folio","index","inbox","running",`建立索引：${file.name}`);const doc=await r.folioLibrary.add("main",file.name,await fs.readFile(path.join(this.folder(c.id),"input",file.name)));const ms=Date.now()-begin;c.arms.folio.indexMs+=ms;await this.ownEvent(c,"folio","indexed","inbox",doc.status==="ready"?"done":doc.status==="no_text"?"waiting":"error",doc.status==="ready"?`${file.name} 索引就绪`:doc.status==="no_text"?`${file.name} 没有可提取的正文${doc.kind==="pdf"?"，未执行 OCR":""}`:`${file.name} 解析未成功`,{indexMs:ms,detail:doc.warnings.join("\n")});}
      if(r.stop)return;
      const run=await r.folio.createTask("main",c.message);c.arms.folio.runId=run.id;
      const seen=new Set<number>();const forward=(e:FlowEvent)=>{if(seen.has(e.seq))return;seen.add(e.seq);r.queue=r.queue.then(()=>this.folioEvent(c,run.id,e)).catch(error=>this.fail(c,"folio",error));};
      r.folio.events.on(run.id,forward);for(const e of run.events)forward(e);await this.save(c);
    }catch(error){await this.fail(c,"folio",error);}
  }
  private async folioEvent(c:Comparison,runId:string,event:FlowEvent){
    const r=this.runtime.get(c.id)!;const arm=c.arms.folio;
    if(r.stop&&event.type!=="settled")return;
    const extra:Partial<ComparisonEvent>={};
    if(event.type==="tool_start"){arm.toolCalls++;r.tools.set(`folio:${event.toolCallId}`,{at:new Date(event.at).getTime(),stage:event.stage!,args:event.args??{}});}
    if(event.type==="tool_end"){const tool=r.tools.get(`folio:${event.toolCallId}`);extra.toolMs=tool?Math.max(0,new Date(event.at).getTime()-tool.at):0;extra.returnedChars=event.detail?.length??0;arm.toolMs+=extra.toolMs;arm.returnedChars+=extra.returnedChars;}
    if(event.type==="answer_delta")arm.answer+=event.text??"";
    if(event.type==="answer"){arm.answer=event.text??"";arm.inputTokens=event.inputTokens??arm.inputTokens;arm.outputTokens=event.outputTokens??arm.outputTokens;}
    if(event.type==="failed"||event.type==="settled")extra.armStatus=r.stop?"cancelled":(await r.folio.getRun(runId)).status;
    await this.emit(c,"folio",{...event,...extra,originalSeq:event.seq,originalAt:event.at,detail:event.detail?.slice(0,16000)});
    if(event.type==="failed"||event.type==="settled"){
      const run=await r.folio.getRun(runId);arm.status=r.stop?"cancelled":run.status;arm.answer=run.answer;arm.error=run.error;
      if(arm.status==="awaiting_approval"){arm.endedAt=event.at;arm.awaitingSince=event.at;r.accepting=true;}
      if(terminal(arm.status)){arm.endedAt=event.at;arm.awaitingSince=undefined;}
      arm.changes=await this.changes(c,"folio");await this.reconcile(c);
      if(terminal(arm.status))void r.folio.closeAgents();
    }
  }
  private async runNative(c:Comparison){
    const r=this.runtime.get(c.id)!;
    try{
      const documents=path.join(this.folder(c.id),"native/documents");
      const context={projectRoot:this.library.projectRoot,dataRoot:path.join(this.folder(c.id),"native"),workspace:path.join(this.folder(c.id),"native/agent"),documents,indexHome:path.join(this.folder(c.id),"native/unused-index"),settings:r.settings};
      if(this.dependencies.nativeFactory)r.native=await this.dependencies.nativeFactory(context,c.id,event=>this.enqueueNative(c,event));
      else{const container=await this.sandbox.start(c.id,documents,c.files.filter(f=>!editableActions(f.kind).length).map(f=>f.name));if(r.stop){await this.sandbox.remove(c.id);return;}r.native=await createNativeAgent(context,container,event=>this.enqueueNative(c,event));}
      if(r.stop){await r.native.close();return;}await this.ownEvent(c,"native","starting","inbox","done","原生 pi 接单：没有连接 Folio MCP");await r.native.prompt(c.message);
    }catch(error){await this.fail(c,"native",error);await this.sandbox.remove(c.id);}
  }
  private enqueueNative(c:Comparison,event:WireEvent){const r=this.runtime.get(c.id)!;r.queue=r.queue.then(()=>this.nativeEvent(c,event)).catch(error=>this.fail(c,"native",error));}
  private async nativeEvent(c:Comparison,event:WireEvent){
    const r=this.runtime.get(c.id)!,arm=c.arms.native;if(r.stop||terminal(arm.status))return;
    const seq=++r.nativeSeq,at=new Date().toISOString();const emit=(e:Omit<ComparisonEvent,"arm"|"comparisonId"|"at"|"seq"|"originalSeq"|"originalAt"|"runId">)=>this.emit(c,"native",{...e,runId:arm.runId,originalSeq:seq,originalAt:at});
    if(event.type==="tool_execution_start"){
      const tool=String(event.toolName),stage=nativeStage(tool,event.args??{});arm.toolCalls++;r.tools.set(`native:${event.toolCallId}`,{at:Date.now(),stage,args:event.args??{}});
      await emit({type:"tool_start",tool,toolCallId:event.toolCallId,args:event.args,stage,state:"running",message:tool==="bash"?"执行原生 shell 命令":tool==="read"?"直接读取文件":tool==="edit"?"直接替换文件内容":"直接写入文件副本"});
    }else if(event.type==="tool_execution_end"){
      const tool=r.tools.get(`native:${event.toolCallId}`),text=plain(event),ms=tool?Date.now()-tool.at:0;arm.toolMs+=ms;arm.returnedChars+=text.length;
      await emit({type:"tool_end",tool:String(event.toolName),toolCallId:event.toolCallId,args:tool?.args,stage:tool?.stage??"evidence",state:event.isError?"error":"done",message:event.isError?"原生工具返回错误":"原生工具完成",detail:text.slice(0,16000),returnedChars:text.length,toolMs:ms});
    }else if(event.type==="message_start"&&event.message?.role==="assistant"){arm.answer="";await emit({type:"answer",text:""});}
    else if(event.type==="message_update"&&event.assistantMessageEvent?.type==="text_delta"){const text=String(event.assistantMessageEvent.delta??"");arm.answer+=text;await emit({type:"answer_delta",text});}
    else if(event.type==="message_end"&&event.message?.role==="assistant"){
      const m=event.message;arm.answer=(m.content??[]).filter((v:any)=>v.type==="text").map((v:any)=>v.text).join("");r.nativeStop=m.stopReason;const usage=m.usage??{};arm.inputTokens+=(usage.input??0)+(usage.cacheRead??0)+(usage.cacheWrite??0);arm.outputTokens+=usage.output??0;arm.error=m.errorMessage;
      await emit({type:"answer",text:arm.answer,inputTokens:arm.inputTokens,outputTokens:arm.outputTokens});
    }else if(event.type==="startup_wait")await emit({type:"notice",stage:"inbox",state:"running",message:event.message});
    else if(event.type==="auto_retry_start")await emit({type:"notice",stage:"search",state:"waiting",message:"模型接口正在重试",detail:String(event.errorMessage??"")});
    else if(event.type==="driver_error")await this.fail(c,"native",event.message);
    else if(event.type==="agent_settled"){
      const finalStatus=event.aborted?"cancelled":r.nativeStop==="stop"?"completed":"failed";arm.endedAt=at;if(finalStatus==="failed")arm.error??="模型没有正常结束";
      await r.native?.close();await this.sandbox.remove(c.id);
      arm.status=finalStatus;
      arm.changes=await this.changes(c,"native");if(arm.changes.some(f=>f.status!=="unchanged"))await emit({type:"native_write",stage:"approval",state:"done",message:"已核对实际修改：原生侧直接写入隔离副本，没有独立盖章环节"});
      await emit({type:"settled",stage:"delivery",state:arm.status==="completed"?"done":"error",armStatus:arm.status,message:arm.status==="completed"?"原生侧执行结束":"原生侧未完成",detail:arm.error});await this.reconcile(c);
    }
  }
  private async fail(c:Comparison,arm:Arm,error:unknown){
    if(arm==="native"){await this.runtime.get(c.id)?.native?.close();await this.sandbox.remove(c.id);}
    const a=c.arms[arm];if(a.status==="cancelled")return;a.status="failed";const key=this.runtime.get(c.id)?.settings.apiKey??"";a.error=String(error instanceof Error?error.message:error);if(key)a.error=a.error.split(key).join("[已隐藏密钥]");a.endedAt=new Date().toISOString();
    await this.ownEvent(c,arm,"failed","delivery","error","这一侧没有完成",{detail:a.error,armStatus:"failed"});await this.reconcile(c);
  }
  private async reconcile(c:Comparison){
    const arms=Object.values(c.arms);c.status=arms.some(a=>["queued","running"].includes(a.status))?"running":arms.some(a=>a.status==="awaiting_approval")?"awaiting_approval":arms.every(a=>a.status==="completed")?"completed":arms.some(a=>a.status==="failed")?"failed":arms.some(a=>a.status==="interrupted")?"interrupted":"cancelled";await this.save(c);
    this.events.emit(`${c.id}:status`,c.status);
    await this.emit(c,"folio",{runId:c.arms.folio.runId,originalSeq:0,originalAt:new Date().toISOString(),type:"status",message:c.status});
  }
  documents(c:Comparison,arm:Arm){return arm==="native"?path.join(this.folder(c.id),"native/documents"):path.join(this.folder(c.id),"folio/workspaces/main/documents");}
  async changes(c:Comparison,arm:Arm):Promise<FileChange[]>{
    const result:FileChange[]=[];const root=this.documents(c,arm);
    for(const file of c.files){let current:Buffer;try{if(!(await fs.lstat(path.join(root,file.name))).isFile())throw Error("非普通文件");current=await fs.readFile(path.join(root,file.name));}catch{result.push({name:file.name,status:"deleted",supported:!!editableActions(file.kind).length});continue;}
      const changed=hash(current)!==file.hash;const row:FileChange={name:file.name,status:changed?"modified":"unchanged",supported:!!editableActions(file.kind).length};
      if(changed&&file.kind==="text"){row.before=(await fs.readFile(path.join(this.folder(c.id),"input",file.name),"utf8")).slice(0,40000);row.after=current.toString("utf8").slice(0,40000);}
      else if(changed&&file.kind==="docx"){const before=await parseFile(path.join(this.folder(c.id),"input",file.name),"docx"),after=await parseFile(path.join(root,file.name),"docx");row.before=before.units.flatMap(u=>u.lines).join("\n").slice(0,40000);row.after=after.units.flatMap(u=>u.lines).join("\n").slice(0,40000);}
      result.push(row);
    }
    const extra=await fs.readdir(root).catch(()=>[]);for(const name of extra)if(!name.startsWith(".")&&!c.files.some(f=>f.name===name)&&(await fs.lstat(path.join(root,name))).isFile())result.push({name,status:"added",supported:false});
    return result;
  }
  async drafts(id:string):Promise<Draft[]>{const c=await this.get(id);if(c.replayOnly)return [];const r=this.runtime.get(id);try{if(r)return r.folio.drafts(await r.folio.getRun(c.arms.folio.runId));const lib=new Library(path.join(this.folder(id),"folio"),this.library.projectRoot,await this.library.settings());const controller=new Workshop(lib);return controller.drafts(await lib.loadRun(c.arms.folio.runId));}catch(error){if((error as HttpError).statusCode===404)return [];throw error;}}
  private async resume(id:string){const c=await this.get(id);let r=this.runtime.get(id);if(r)return r;const settings=await this.library.settings(),lib=new Library(path.join(this.folder(id),"folio"),this.library.projectRoot,settings),folio=new Workshop(lib);await folio.init();r={folio,folioLibrary:lib,settings,queue:Promise.resolve(),nativeSeq:0,tools:new Map(),stop:false};this.runtime.set(id,r);const run=await folio.getRun(c.arms.folio.runId);folio.events.on(run.id,(e:FlowEvent)=>{r!.queue=r!.queue.then(()=>this.folioEvent(c,run.id,e));});return r;}
  async apply(id:string,keys:{doc:string;id:string}[]){const c=await this.get(id);if(c.replayOnly)throw new HttpError(409,"历史回放不能执行写回");if(c.arms.folio.status!=="awaiting_approval")throw new HttpError(409,"请等待 Folio 完成草案后确认");const r=await this.resume(id);const begin=Date.now(),since=c.arms.folio.awaitingSince;await r.folio.apply(c.arms.folio.runId,keys);await r.queue;if(since)c.arms.folio.confirmationMs+=Math.max(0,begin-new Date(since).getTime());await this.save(c);return c;}
  async discard(id:string){const c=await this.get(id);if(c.replayOnly||["queued","running"].includes(c.arms.folio.status))throw new HttpError(409,"当前不能撤销");const r=await this.resume(id),begin=Date.now(),since=c.arms.folio.awaitingSince;await r.folio.discard(c.arms.folio.runId);await r.queue;if(since)c.arms.folio.confirmationMs+=Math.max(0,begin-new Date(since).getTime());await this.save(c);return c;}
  async stop(id:string){const c=await this.get(id),r=this.runtime.get(id);if(!r)return c;r.stop=true;
    await Promise.allSettled([r.native?.abort(),r.native?.close(),r.folio.stop(c.arms.folio.runId),this.sandbox.remove(id)]);
    for(const arm of ["native","folio"] as const)if(!terminal(c.arms[arm].status)){if(c.arms[arm].awaitingSince){c.arms[arm].confirmationMs+=Date.now()-new Date(c.arms[arm].awaitingSince!).getTime();c.arms[arm].awaitingSince=undefined;}c.arms[arm].status="cancelled";c.arms[arm].endedAt=new Date().toISOString();await this.ownEvent(c,arm,"settled","delivery","waiting","对照已停止；已发生的文件变化保留在隔离副本",{armStatus:"cancelled"});}
    try{await r.folio.discard(c.arms.folio.runId);}catch{}await r.queue;await this.reconcile(c);return c;
  }
  async inputFile(c:Comparison,fileId:string){const file=c.files.find(f=>f.id===fileId);if(!file)throw new HttpError(404,"没有这份输入文件");const source=c.replayOnly?path.join(this.library.projectRoot,"tests/ab/corpus2",file.name):path.join(this.folder(c.id),"input",file.name);if(c.replayOnly){if(!["技术_规范全文.pdf","财税_报销制度.md","技术_值班记录.csv"].includes(file.name))throw new HttpError(409,"回放材料无效");const stat=await fs.stat(source),known=this.verifiedInputs.get(source);let digest=known?.hash;if(!known||known.mtime!==stat.mtimeMs||known.size!==stat.size){digest=hash(await fs.readFile(source));this.verifiedInputs.set(source,{mtime:stat.mtimeMs,size:stat.size,hash:digest});}if(digest!==file.hash)throw new HttpError(409,"回放材料版本已经变化，当前不能展示原文件");}return{file,source};}
  async preview(id:string,fileId:string,label?:string,line?:number):Promise<Preview>{const c=await this.get(id),{file,source:input}=await this.inputFile(c,fileId);const parsed=await parseFile(input,detectKind(file.name)!);const labels=parsed.units.map(u=>u.label),chosen=label??labels[0]??"";const paged=["pdf","pptx","xlsx"].includes(file.kind);const rows=parsed.units.flatMap(u=>u.lines.map((text,i)=>({label:u.label,line:i+1,text})));const source=paged?rows.filter(row=>row.label===chosen):rows;const anchor=Math.max(0,source.findIndex(row=>row.label===chosen&&row.line>=(line??1))),begin=Math.max(0,anchor-4),lines=source.slice(begin,begin+120);
    return {doc:{...file,kind:detectKind(file.name)!,uploadedAt:c.createdAt,status:rows.length?"ready":"no_text",units:parsed.units.length,unitKind:parsed.unitKind,warnings:parsed.warnings,editableActions:[],version:file.hash},labels,label:chosen,text:lines.map(l=>l.text).join("\n"),lines,truncated:begin>0||source.length>begin+120};}
  async close(){for(const [id,r] of this.runtime){await r.native?.close();await r.folio.close();if(!terminal(this.items.get(id)!.arms.native.status))await this.sandbox.remove(id);await r.queue;}await Promise.allSettled(this.writes.values());}
}
