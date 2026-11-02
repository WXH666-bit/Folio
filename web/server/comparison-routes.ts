import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Comparisons } from "./comparison.js";
import { HttpError } from "./library.js";
import type { ComparisonEvent } from "../comparison-shared.js";
const params=z.object({id:z.string().uuid()});
export async function comparisonRoutes(app:FastifyInstance,comparisons:Comparisons){
  app.get("/api/comparisons",()=>comparisons.history());
  app.get("/api/comparisons/environment",()=>comparisons.environment());
  app.get("/api/comparisons/demos",async()=>[...comparisons.items.values()].filter(c=>c.replayOnly).map(({id,title,createdAt,status,demoKey,model,sourceVersion,verification})=>({id,title,createdAt,status,demoKey,model,sourceVersion,verification})));
  app.post("/api/comparisons",request=>{const body=z.object({workspace:z.enum(["main","demo"]),documents:z.array(z.string().uuid()).min(1).max(100),message:z.string().min(1).max(12000),title:z.string().max(100).optional()}).parse(request.body);return comparisons.create(body.workspace,body.documents,body.message,body.title);});
  app.get("/api/comparisons/:id",request=>comparisons.get(params.parse(request.params).id));
  app.get("/api/comparisons/:id/drafts",request=>comparisons.drafts(params.parse(request.params).id));
  app.post("/api/comparisons/:id/apply",request=>{const {id}=params.parse(request.params),{keys}=z.object({keys:z.array(z.object({doc:z.string(),id:z.string()})).min(1).max(200)}).parse(request.body);return comparisons.apply(id,keys);});
  app.post("/api/comparisons/:id/discard",request=>comparisons.discard(params.parse(request.params).id));
  app.post("/api/comparisons/:id/stop",request=>comparisons.stop(params.parse(request.params).id));
  app.get("/api/comparisons/:id/input/:file/preview",request=>{const {id,file}=params.extend({file:z.string().uuid()}).parse(request.params),query=z.object({label:z.string().optional(),line:z.coerce.number().int().positive().optional()}).parse(request.query);return comparisons.preview(id,file,query.label,query.line);});
  app.get("/api/comparisons/:id/input/:file/content",async(request,reply)=>{
    const {id,file}=params.extend({file:z.string().uuid()}).parse(request.params),c=await comparisons.get(id),input=await comparisons.inputFile(c,file),query=z.object({download:z.string().optional()}).parse(request.query);
    const inline=input.file.kind==="pdf"&&query.download!=="1";reply.type(inline?"application/pdf":"application/octet-stream").header("Content-Disposition",`${inline?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(input.file.name)}`);return reply.send(fs.createReadStream(input.source));
  });
  app.get("/api/comparisons/:id/output/:arm/:file",async(request,reply)=>{
    const {id,arm,file}=params.extend({arm:z.enum(["native","folio"]),file:z.string().uuid()}).parse(request.params),c=await comparisons.get(id),input=c.files.find(f=>f.id===file);
    if(!input)throw new HttpError(404,"没有这份文件");if(!["completed","failed","cancelled","interrupted","awaiting_approval"].includes(c.arms[arm].status))throw new HttpError(409,"这一侧还在执行，请等待文件核对完成");
    reply.type("application/octet-stream").header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(input.name)}`);
    if(c.replayOnly){const bytes=c.downloads?.[arm]?.[input.name];if(bytes)return Buffer.from(bytes,"base64");return reply.send(fs.createReadStream((await comparisons.inputFile(c,file)).source));}
    const source=path.join(comparisons.documents(c,arm),input.name);if(!(await fsp.lstat(source)).isFile())throw new HttpError(409,"结果不是可下载的普通文件");return reply.send(fs.createReadStream(source));
  });
  app.get("/api/comparisons/:id/events",async(request,reply)=>{
    const {id}=params.parse(request.params),c=await comparisons.get(id),q=z.object({after:z.coerce.number().int().nonnegative().optional()}).parse(request.query);let sent=Number(request.headers["last-event-id"]??q.after??0);if(!Number.isInteger(sent)||sent<0)sent=0;
    reply.hijack();reply.raw.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache",Connection:"keep-alive","X-Accel-Buffering":"no"});reply.raw.flushHeaders();
    const send=(event:ComparisonEvent)=>{if(event.seq<=sent)return;sent=event.seq;reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);};comparisons.events.on(id,send);for(const event of c.events)send(event);
    const timer=setInterval(()=>reply.raw.write(": keep-alive\n\n"),15000);timer.unref();reply.raw.on("close",()=>{clearInterval(timer);comparisons.events.off(id,send);});
  });
}
