import Fastify from "fastify";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Library, HttpError, type PrivateSettings } from "./library.js";
import { Workshop } from "./workshop.js";
import { piStatus, type AgentFactory } from "./pi.js";
import type { RunInfo } from "../shared.js";
import { Comparisons, type ComparisonDependencies } from "./comparison.js";
import { comparisonRoutes } from "./comparison-routes.js";

export interface AppOptions { dataRoot?: string; projectRoot?: string; agentFactory?: AgentFactory; comparisonDependencies?: ComparisonDependencies; modelSettings?:PrivateSettings; }
const idParams = z.object({ ws: z.string().min(1) });
const fileParams = idParams.extend({ doc: z.string().uuid() });
const runParams = z.object({ run: z.string().uuid() });
const settingsBody = z.object({ baseUrl: z.string().min(1).max(2000), model: z.string().min(1).max(200), apiKey: z.string().max(4000).optional() });

export async function createApp(options: AppOptions = {}) {
  const projectRoot = options.projectRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const library = new Library(path.resolve(options.dataRoot ?? process.env.FOLIO_WEB_DATA ?? path.join(projectRoot, "data")), projectRoot,options.modelSettings);
  const workshop = new Workshop(library, options.agentFactory); await workshop.init();
  const comparisons = new Comparisons(library,options.comparisonDependencies);await comparisons.init();
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, forceCloseConnections: true });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 10, fields: 5 } });
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "localhost";
    let hostname: string; try { hostname = new URL(`http://${host}`).hostname; } catch { throw new HttpError(403, "仅允许本机访问"); }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) throw new HttpError(403, "文档工坊只接受本机访问");
    if (request.headers.origin) {
      let origin: URL; try { origin = new URL(request.headers.origin); } catch { throw new HttpError(403, "请求来源无效"); }
      if (origin.host !== host || !["http:","https:"].includes(origin.protocol)) throw new HttpError(403, "不接受其他网站发起的操作");
    }
    reply.header("X-Content-Type-Options", "nosniff");
  });
  app.setErrorHandler(async (error, _request, reply) => {
    let message = error instanceof z.ZodError ? "请求参数不完整或格式不正确" : error instanceof Error ? error.message : String(error);
    const key = (await library.settings()).apiKey; if (key) message = message.split(key).join("[已隐藏密钥]");
    const status = error instanceof z.ZodError ? 400 : (error as HttpError).statusCode ?? 500;
    reply.code(status >= 400 && status <= 599 ? status : 500).send({ error: message });
  });
  app.get("/api/status", async () => ({ pi: await piStatus(projectRoot), model: await library.publicSettings(), supported: ["pdf","docx","pptx","xlsx","html","htm","txt","md","csv","log"] }));
  app.get("/api/settings", () => library.publicSettings());
  app.put("/api/settings", async request => {
    if (workshop.isBusy()||comparisons.isBusy()) throw new HttpError(409, "请先停止正在运行的任务，再切换模型");
    const settings = settingsBody.parse(request.body); await workshop.closeAgents(); return library.saveSettings(settings);
  });
  app.post("/api/settings/test", async request => {
    const input = settingsBody.parse(request.body), previous = await library.settings(), apiKey = input.apiKey?.trim() || previous.apiKey;
    if (!apiKey) throw new HttpError(400, "请填写 API 密钥");
    let url: URL; try { url = new URL(input.baseUrl); } catch { throw new HttpError(400, "API 地址无效"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HttpError(400, "请填写 HTTP(S) 接口地址");
    try {
      const response = await fetch(input.baseUrl.replace(/\/+$/, "") + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: input.model, messages: [{ role: "user", content: "Reply only OK." }], max_tokens: 4, stream: false }), signal: AbortSignal.timeout(25_000) });
      if (!response.ok) throw new Error(`模型接口返回 HTTP ${response.status}`);
      const data = await response.json() as { choices?: unknown[] };
      if (!data.choices?.length) throw new Error("接口没有返回兼容的模型答复");
      return { ok: true, message: "模型已回应，连接可用" };
    } catch (error) { throw new HttpError(502, (error instanceof Error ? error.message : "连接失败").split(apiKey).join("[已隐藏密钥]")); }
  });
  app.get("/api/workspaces", async () => Promise.all([library.workspace("main"), library.workspace("demo")]));
  app.get("/api/workspaces/:ws", request => library.workspace(idParams.parse(request.params).ws));
  app.post("/api/workspaces/demo/examples", async () => workshop.seed());
  app.post("/api/workspaces/:ws/uploads", request => workshop.createUpload(idParams.parse(request.params).ws));
  app.post("/api/workspaces/:ws/documents", async request => {
    const { ws } = idParams.parse(request.params), { run } = z.object({ run: z.string().uuid() }).parse(request.query);
    const parts = request.files();
    async function* files() { for await (const part of parts) yield { filename: part.filename, buffer: () => part.toBuffer() }; }
    return workshop.upload(ws, run, files());
  });
  app.patch("/api/workspaces/:ws/documents/:doc", async request => {
    const { ws, doc } = fileParams.parse(request.params), { name } = z.object({ name: z.string().min(1).max(250) }).parse(request.body);
    return workshop.withIdle(ws, () => library.rename(ws, doc, name));
  });
  app.delete("/api/workspaces/:ws/documents/:doc", async request => {
    const { ws, doc } = fileParams.parse(request.params);
    await workshop.withIdle(ws, () => library.remove(ws, doc)); return { ok: true };
  });
  app.post("/api/workspaces/:ws/documents/:doc/refresh", request => {
    const { ws, doc } = fileParams.parse(request.params); return workshop.withIdle(ws, () => library.refresh(ws, doc));
  });
  app.get("/api/workspaces/:ws/documents/:doc/preview", request => {
    const { ws, doc } = fileParams.parse(request.params), query = z.object({ label: z.string().optional(), version: z.string().optional(), line: z.coerce.number().int().positive().optional() }).parse(request.query);
    return library.preview(ws, doc, query.label, query.version, query.line);
  });
  app.get("/api/workspaces/:ws/documents/:doc/content", async (request, reply) => {
    const { ws, doc } = fileParams.parse(request.params), file = await library.file(ws, doc);
    const { download, version } = z.object({ download: z.string().optional(), version: z.string().optional() }).parse(request.query);
    if (version && version !== file.entry?.revision) throw new HttpError(409, "文档版本已改变，请重新打开预览");
    const inline = file.entry?.kind === "pdf" && download !== "1";
    reply.header("Content-Type", inline ? "application/pdf" : "application/octet-stream");
    reply.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.file.name)}`);
    return reply.send(fs.createReadStream(file.source));
  });
  app.get("/api/workspaces/:ws/runs", async request => (await workshop.history(idParams.parse(request.params).ws)).map(({events: _, ...run}) => run));
  app.post("/api/workspaces/:ws/runs", request => {
    const { ws } = idParams.parse(request.params), { message } = z.object({ message: z.string().min(1).max(12000) }).parse(request.body);
    return workshop.createTask(ws, message);
  });
  app.get("/api/runs/:run", request => workshop.getRun(runParams.parse(request.params).run));
  app.get("/api/runs/:run/drafts", async request => workshop.drafts(await workshop.getRun(runParams.parse(request.params).run)));
  app.post("/api/runs/:run/apply", request => {
    const { run } = runParams.parse(request.params), { keys } = z.object({ keys: z.array(z.object({ doc: z.string(), id: z.string() })).min(1).max(200) }).parse(request.body);
    return workshop.apply(run, keys);
  });
  app.post("/api/runs/:run/discard", request => workshop.discard(runParams.parse(request.params).run));
  app.post("/api/runs/:run/stop", request => workshop.stop(runParams.parse(request.params).run));
  app.get("/api/runs/:run/proposals.md", async (request, reply) => {
    const run = await workshop.getRun(runParams.parse(request.params).run), drafts = await workshop.drafts(run);
    const text = ["# Folio 修改意见", "", ...drafts.flatMap(d => [`## ${d.doc} · ${d.target}`, `版本：${d.version ?? "未知"}；状态：${d.status}`, `操作：${d.action}`, "", "原文：", d.before, "", "建议：", d.action === "delete" ? "删除此行" : d.text, "", `原因：${d.reason}`, ""])].join("\n");
    reply.header("Content-Type", "text/markdown; charset=utf-8").header("Content-Disposition", "attachment; filename=folio-proposals.md"); return text;
  });
  app.get("/api/runs/:run/events", async (request, reply) => {
    const { run: id } = runParams.parse(request.params), run = await workshop.getRun(id);
    const query = z.object({ after: z.coerce.number().int().nonnegative().optional() }).parse(request.query);
    let sent = Number(request.headers["last-event-id"] ?? query.after ?? 0); if (!Number.isInteger(sent) || sent < 0) sent = query.after ?? 0;
    reply.hijack(); reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: RunInfo["events"][number]) => { if (event.seq <= sent) return; sent = event.seq; reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`); };
    workshop.events.on(id, send); for (const event of run.events) send(event);
    const heartbeat = setInterval(() => reply.raw.write(": keep-alive\n\n"), 15_000); heartbeat.unref();
    reply.raw.on("close", () => { clearInterval(heartbeat); workshop.events.off(id, send); });
  });
  const ui = path.join(projectRoot, "web/dist");
  await comparisonRoutes(app,comparisons);
  if (fs.existsSync(path.join(ui, "index.html"))) {
    await app.register(staticFiles, { root: ui, prefix: "/", wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "没有这个接口" }) : reply.sendFile("index.html"));
  } else app.get("/", (_req, reply) => reply.code(503).send({ error: "前端尚未构建，请运行 npm run build:web；开发时访问 Vite 地址。" }));
  app.addHook("onClose", async () => {await comparisons.close();await workshop.close();});
  return { app, library, workshop, comparisons };
}
