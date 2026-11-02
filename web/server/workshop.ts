import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { applyRevisions, discardRevisions, listRevisions } from "../../src/revisions.js";
import { resolveDoc } from "../../src/search.js";
import { Library, HttpError, editableActions } from "./library.js";
import { createPiAgent, type AgentDriver, type AgentFactory, type WireEvent } from "./pi.js";
import type { RunInfo, FlowEvent, Stage, Reference, Draft, WorkspaceInfo } from "../shared.js";

const toolStage: Record<string, Stage> = { folio_list: "inbox", folio_outline: "search", folio_search: "search", folio_page: "evidence", folio_revise: "draft", folio_revisions: "draft" };
const toolLabel: Record<string,string> = { folio_list: "清点文档", folio_outline: "查看目录", folio_search: "寻找线索", folio_page: "展开原文", folio_revise: "拟定修改", folio_revisions: "检查修改单" };
export function collectReferences(text: string, workspace: WorkspaceInfo): Reference[] {
  const refs: Reference[] = [], fallback = /\[version=([a-f0-9]+)\]/.exec(text)?.[1];
  for (const line of text.split("\n")) {
    const doc = workspace.documents.find(d => line.startsWith(d.name + ":")); if (!doc) continue;
    const match = /^(.+):L(\d+)(?: \[version=([a-f0-9]+)\])?\s+(.*)$/.exec(line.slice(doc.name.length + 1));
    if (match && (match[3] || fallback)) refs.push({ docId: doc.id, doc: doc.name, label: match[1], line: Number(match[2]), target: `${match[1]}:L${match[2]}`, version: match[3] || fallback!, text: match[4] });
  }
  return refs;
}
export class Workshop {
  readonly events = new EventEmitter();
  readonly runs = new Map<string, RunInfo>();
  private active = new Map<string, string>();
  private drivers = new Map<string, Promise<AgentDriver>>();
  private writes = new Map<string, Promise<unknown>>();
  private wireQueues = new Map<string, Promise<unknown>>();
  private lastStop = new Map<string,string>();
  constructor(readonly library: Library, readonly factory: AgentFactory = createPiAgent) { this.events.setMaxListeners(100); }
  async init() {
    await this.library.init();
    for (const id of ["main", "demo"]) for (const run of await this.library.history(id)) {
      if (["running", "queued"].includes(run.status)) { run.status = "interrupted"; run.error = "服务已重启，任务已中断；没有自动重跑。"; await this.library.saveRun(run); }
      this.runs.set(run.id, run);
    }
  }
  assertIdle(ws: string) { if (this.active.has(ws)) throw new HttpError(409, "小π正在处理这个工作区，请先停止或等待任务结束"); }
  async withIdle<T>(ws: string, fn: () => Promise<T>) { return this.library.exclusive(ws, async () => { this.assertIdle(ws); return fn(); }); }
  async getRun(id: string) { const run = this.runs.get(id) ?? await this.library.loadRun(id); this.runs.set(id, run); return run; }
  async history(ws: string) { return [...this.runs.values()].filter(r => r.workspaceId === ws).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  private async makeRun(ws: string, kind: RunInfo["kind"], message: string) {
    await this.library.meta(ws);
    const run: RunInfo = { id: randomUUID(), workspaceId: ws, kind, message, createdAt: new Date().toISOString(), status: "queued", answer: "", inputTokens: 0, outputTokens: 0, revisionKeys: [], events: [] };
    this.runs.set(run.id, run); await this.library.saveRun(run); return run;
  }
  private async emit(run: RunInfo, event: Omit<FlowEvent, "seq"|"runId"|"at">) {
    const full: FlowEvent = { ...event, seq: run.events.length + 1, runId: run.id, at: new Date().toISOString() };
    run.events.push(full);
    const task = (this.writes.get(run.id) ?? Promise.resolve()).then(() => fs.appendFile(path.join(this.library.runFolder(run.id), "events.jsonl"), JSON.stringify(full) + "\n"));
    this.writes.set(run.id, task); await task; this.events.emit(run.id, full); return full;
  }
  async createUpload(ws: string) { return this.withIdle(ws, () => this.makeRun(ws, "upload", "把文档送进工坊")); }
  async upload(ws: string, runId: string, files: AsyncIterable<{ filename: string; buffer: () => Promise<Buffer> }>) {
    return this.withIdle(ws, async () => {
      const run = await this.getRun(runId); if (run.workspaceId !== ws || run.kind !== "upload" || run.status !== "queued") throw new HttpError(409, "上传任务无效或已经处理");
      this.active.set(ws, run.id); run.status = "running"; await this.library.saveRun(run);
      try {
        let count = 0;
        for await (const file of files) {
          await this.emit(run, { type: "upload", stage: "inbox", state: "running", message: `正在接收 ${file.filename}` });
          const buffer = await file.buffer();
          await this.emit(run, { type: "index", stage: "inbox", state: "running", message: `为 ${file.filename} 建立页码索引` });
          const doc = await this.library.add(ws, file.filename, buffer);
          count++; await this.emit(run, { type: "indexed", stage: "inbox", state: doc.status === "ready" ? "done" : "waiting", message: doc.status === "ready" ? `${doc.name} 已就绪` : `${doc.name} ${doc.status === "no_text" ? doc.kind === "pdf" ? "没有文字层，需要 OCR" : "没有可索引的正文" : "未能解析"}`, detail: doc.warnings.join("\n") });
        }
        if (!count) throw new HttpError(400, "请选择需要上传的文件");
        run.status = "completed"; run.outcome = "answer"; run.answer = `${count} 份文档已进入工坊。选择下面的任务，或直接告诉小π你想做什么。`;
        await this.emit(run, { type: "settled", stage: "inbox", state: "done", message: "文档接收完成" });
      } catch (error) { await this.failure(run, error); throw error; }
      finally { this.active.delete(ws); await this.library.saveRun(run); }
      return run;
    });
  }
  async seed() {
    const run = await this.withIdle("demo", async () => { const r = await this.makeRun("demo", "upload", "载入比赛示例"); this.active.set("demo", r.id); return r; });
    void (async () => {
      try {
        run.status = "running"; await this.library.saveRun(run);
        const driver = this.drivers.get("demo"); if (driver) { this.drivers.delete("demo"); await (await driver.catch(() => null))?.close(); }
        const sessions = path.resolve(this.library.folder("demo"), "pi/sessions");
        if (!sessions.startsWith(this.library.folder("demo") + path.sep)) throw new Error("Invalid session directory");
        await fs.rm(sessions, { recursive: true, force: true });
        for (const f of (await this.library.meta("demo")).files.filter(f => f.sample)) await this.library.remove("demo", f.id);
        for (const name of ["技术_规范全文.pdf", "财税_报销制度.md", "技术_值班记录.csv"]) {
          await this.emit(run, { type: "index", stage: "inbox", state: "running", message: `装入示例：${name}` });
          await this.library.add("demo", name, await fs.readFile(path.join(this.library.projectRoot, "tests/ab/corpus2", name)), true);
          await this.emit(run, { type: "indexed", stage: "inbox", state: "done", message: `${name} 准备好了` });
        }
        run.status = "completed"; run.outcome = "answer"; run.answer = "三份真实示例已就绪！试试找出备份策略，再给报销制度改个稿。示例来自合成测试材料。";
        await this.emit(run, { type: "settled", stage: "inbox", state: "done", message: "示例工坊准备完毕" });
      } catch (e) { await this.failure(run, e); }
      finally { this.active.delete("demo"); await this.library.saveRun(run); }
    })();
    return run;
  }
  async createTask(ws: string, message: string) {
    const run = await this.withIdle(ws, async () => {
      if (!message.trim() || message.length > 12000) throw new HttpError(400, "请填写任务，长度不要超过 12000 字符");
      const config = await this.library.settings(); if (!config.apiKey || !config.model || !config.baseUrl) throw new HttpError(409, "先在右上角连接模型，小π才能开始工作");
      if (!(await this.library.workspace(ws)).documents.length) throw new HttpError(409, "先上传文档，或载入比赛示例");
      const result = await this.makeRun(ws, "task", message.trim()); this.active.set(ws, result.id); result.status = "running"; await this.library.saveRun(result); return result;
    });
    void this.drive(run); return run;
  }
  private async drive(run: RunInfo) {
    try {
      const ws = run.workspaceId;
      await this.emit(run, { type: "starting", stage: "inbox", state: "running", message: "小π接到任务，正在打开独立工作台" });
      if (run.status !== "running") return;
      let driver = this.drivers.get(ws);
      if (!driver) {
        const settings = await this.library.settings();
        driver = this.factory({ projectRoot: this.library.projectRoot, dataRoot: this.library.dataRoot, workspace: this.library.folder(ws), documents: this.library.store(ws).root, indexHome: this.library.store(ws).home, settings }, event => {
          const queue = (this.wireQueues.get(ws) ?? Promise.resolve()).then(() => this.consume(ws, event));
          this.wireQueues.set(ws, queue.catch(error => this.failActive(ws, error)));
        });
        this.drivers.set(ws, driver);
      }
      const client = await driver;
      if (run.status !== "running") return;
      await client.prompt(run.message + "\n\n请引用真实原文。修改只生成建议，等待网页里的用户确认，不要宣布已经写回。");
      if (run.status === "running") await this.emit(run, { type: "accepted", stage: "inbox", state: "done", message: "独立小π已接单，等待真实工具调用" });
    } catch (error) { this.drivers.delete(run.workspaceId); if (run.status === "running") await this.failure(run, error); this.active.delete(run.workspaceId); }
  }
  private async redacted(message: string) { const key = (await this.library.settings()).apiKey; return key ? message.split(key).join("[已隐藏密钥]") : message; }
  private async consume(ws: string, event: WireEvent) {
    const id = this.active.get(ws); if (!id) return; const run = await this.getRun(id);
    if (run.kind !== "task" || run.status !== "running") return;
    if (event.type === "tool_execution_start") {
      const tool = String(event.toolName).replace(/^mcp__folio__/, "");
      await this.emit(run, { type: "tool_start", stage: toolStage[tool] ?? "search", state: "running", tool, toolCallId: event.toolCallId, args: event.args, message: toolLabel[tool] ?? "执行文档工具" });
    } else if (event.type === "tool_execution_end") {
      const tool = String(event.toolName).replace(/^mcp__folio__/, ""), text = await this.redacted((event.result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"));
      const references = collectReferences(text, await this.library.workspace(ws));
      await this.emit(run, { type: "tool_end", stage: toolStage[tool] ?? "search", state: event.isError ? "error" : "done", tool, toolCallId: event.toolCallId, message: event.isError ? "这一步遇到了问题" : `${toolLabel[tool] ?? "文档工具"}完成`, detail: text, references });
      if (tool === "folio_revise" && !event.isError) {
        const revisionId = /^proposed (r\d+)/.exec(text)?.[1];
        const args = run.events.find(e => e.type === "tool_start" && e.toolCallId === event.toolCallId)?.args;
        const doc = await resolveDoc(this.library.store(ws), String(args?.doc ?? ""));
        if (revisionId && doc && !run.revisionKeys.some(r => r.id === revisionId && r.doc === doc)) run.revisionKeys.push({ id: revisionId, doc });
      }
      if (/status=(no_text|incomplete|stale_index|parse_failed)/.test(text)) await this.emit(run, { type: "notice", stage: toolStage[tool] ?? "evidence", state: "waiting", message: text.includes("status=no_text") ? "文件中没有可提取的正文" : "证据尚不完整，请留意原文状态", detail: text });
    } else if (event.type === "message_start" && event.message?.role === "assistant") {
      run.answer = ""; await this.emit(run, { type: "answer", text: "" });
    } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const text = await this.redacted(event.assistantMessageEvent.delta ?? ""); run.answer += text; await this.emit(run, { type: "answer_delta", text });
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message; this.lastStop.set(run.id, message.stopReason ?? "");
      run.answer = await this.redacted((message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""));
      const usage = message.usage ?? {}; run.inputTokens += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0); run.outputTokens += usage.output ?? 0;
      if (message.errorMessage) run.error = await this.redacted(message.errorMessage);
      await this.emit(run, { type: "answer", text: run.answer, inputTokens: run.inputTokens, outputTokens: run.outputTokens });
    } else if (event.type === "startup_wait") await this.emit(run, { type: "notice", stage: "inbox", state: "running", message: event.message });
    else if (event.type === "auto_retry_start") await this.emit(run, { type: "notice", stage: "search", state: "waiting", message: "模型连接正在重试", detail: await this.redacted(String(event.errorMessage ?? "")) });
    else if (event.type === "driver_error") { this.drivers.delete(ws); await this.failure(run, event.message); this.active.delete(ws); }
    else if (event.type === "agent_settled") {
      if (event.aborted) { run.status = "cancelled"; run.error = undefined; }
      else if (this.lastStop.get(run.id) !== "stop") { await this.failure(run, run.error ?? "模型没有返回正常结束的最终答复"); this.active.delete(ws); return; }
      else {
        const drafts = await this.drafts(run);
        const applicable = drafts.some(d => d.status === "pending" && d.canApply);
        run.status = applicable ? "awaiting_approval" : "completed"; run.outcome = drafts.length ? "proposals" : "answer"; run.error = undefined;
      }
      await this.emit(run, { type: "settled", stage: run.status === "awaiting_approval" ? "approval" : "delivery", state: run.status === "awaiting_approval" ? "waiting" : "done", message: run.status === "cancelled" ? "任务已停止，尚未确认的修改没有写回" : run.status === "awaiting_approval" ? "改稿已就绪，等你盖章" : run.outcome === "proposals" ? "修改意见已生成，此格式不直接写回" : "答复已完成" });
      this.active.delete(ws); await this.library.saveRun(run);
    }
  }
  private async failActive(ws: string, error: unknown) { const id = this.active.get(ws); if (id) await this.failure(await this.getRun(id), error); this.active.delete(ws); }
  private async failure(run: RunInfo, error: unknown) {
    run.status = "failed"; run.error = await this.redacted(error instanceof Error ? error.message : String(error));
    await this.emit(run, { type: "failed", stage: "delivery", state: "error", message: "任务没有完成", detail: run.error }); await this.library.saveRun(run);
  }
  async drafts(run: RunInfo): Promise<Draft[]> {
    const all = await listRevisions(this.library.store(run.workspaceId)), workspace = await this.library.workspace(run.workspaceId);
    return all.filter(r => run.revisionKeys.some(k => k.doc === r.doc && k.id === r.id)).map(r => {
      const doc = workspace.documents.find(d => d.name === r.doc);
      return { ...r, docId: doc?.id ?? "", canApply: !!doc && editableActions(doc.kind).includes(r.action) };
    });
  }
  async apply(runId: string, keys: { doc: string; id: string }[]) {
    const run = await this.getRun(runId);
    return this.withIdle(run.workspaceId, async () => {
      if (!keys.length) throw new HttpError(400, "请至少选择一条修改");
      const drafts = await this.drafts(run);
      const selected = keys.map(key => drafts.find(d => d.id === key.id && d.doc === key.doc));
      if (selected.some(d => !d || d.status !== "pending" || !d.canApply)) throw new HttpError(409, "只能确认本次任务中仍待处理且支持写回的修改");
      await this.emit(run, { type: "apply_start", stage: "approval", state: "running", message: "收到你的确认，开始写回" });
      let applied = 0, conflicts = 0; const warnings: string[] = [];
      try { for (const doc of [...new Set(keys.map(k => k.doc))]) {
        const result = await applyRevisions(this.library.store(run.workspaceId), doc, keys.filter(k => k.doc === doc).map(k => k.id));
        applied += result.applied.length; conflicts += result.conflicts.length;
        if (result.indexWarning) warnings.push(result.indexWarning);
        await this.emit(run, { type: "applied", stage: "delivery", state: result.applied.length ? "done" : "error", message: `${doc}：写回 ${result.applied.length} 处${result.conflicts.length ? `，冲突 ${result.conflicts.length} 处` : ""}`, detail: result.conflicts.map(c => `${c.id}: ${c.why}`).join("\n") + (result.indexWarning ? "\n文件已写回，但索引需要刷新：" + result.indexWarning : "") });
      } } catch (error) {
        run.status = "failed"; run.outcome = "partial";
        run.error = await this.redacted(`写回中断，请检查原文和修改状态后重新索引：${error instanceof Error ? error.message : String(error)}`);
        await this.emit(run, { type: "failed", stage: "approval", state: "error", message: "写回没有全部完成", detail: run.error });
        await this.library.saveRun(run); return run;
      }
      const remaining = (await this.drafts(run)).some(d => d.status === "pending" && d.canApply);
      run.status = remaining ? "awaiting_approval" : applied ? "completed" : "failed";
      run.outcome = conflicts ? "partial" : "written"; run.error = conflicts ? "部分修改因版本变化而未能写回，请重新读取原文。" : warnings.length ? "文件已写回，但索引需要刷新。" : undefined;
      await this.emit(run, { type: "apply_end", stage: "approval", state: conflicts ? "error" : remaining ? "waiting" : "done", message: conflicts ? "写回校验发现冲突" : "本次确认已处理" });
      await this.emit(run, { type: "settled", stage: remaining ? "approval" : "delivery", state: remaining ? "waiting" : applied ? "done" : "error", message: applied ? `已真实写回 ${applied} 处修改` : "没有修改写入文件", detail: run.error });
      await this.library.saveRun(run); return run;
    });
  }
  async discard(runId: string) {
    const run = await this.getRun(runId);
    return this.withIdle(run.workspaceId, async () => {
      const drafts = (await this.drafts(run)).filter(d => d.status === "pending");
      for (const doc of [...new Set(drafts.map(d => d.doc))]) await discardRevisions(this.library.store(run.workspaceId), doc, drafts.filter(d => d.doc === doc).map(d => d.id));
      const written = run.events.some(e => e.type === "applied" && e.state === "done");
      run.status = "completed"; run.outcome = written ? "partial" : "discarded";
      await this.emit(run, { type: "settled", stage: "approval", state: "done", message: written ? "剩余草案已撤销，已确认的写回保留" : "修改建议已撤销，原文未改" }); await this.library.saveRun(run); return run;
    });
  }
  async stop(id: string) {
    const run = await this.getRun(id);
    if (run.status === "queued") { run.status = "cancelled"; await this.library.saveRun(run); return run; }
    if (run.status !== "running" || run.kind !== "task") return run;
    run.status = "cancelled";
    const client = await this.drivers.get(run.workspaceId)?.catch(() => null);
    if (client) { await client.abort().catch(() => {}); await client.close(); this.drivers.delete(run.workspaceId); }
    await this.emit(run, { type: "settled", stage: "delivery", state: "done", message: "任务已停止，未确认的改稿不会写回" }); await this.library.saveRun(run);
    this.active.delete(run.workspaceId); return run;
  }
  async closeAgents() { for (const driver of this.drivers.values()) await (await driver.catch(() => null))?.close(); this.drivers.clear(); }
  isBusy() { return this.active.size > 0; }
  async close() { await this.closeAgents(); await Promise.allSettled([...this.writes.values(), ...this.wireQueues.values()]); }
}
