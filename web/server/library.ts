import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, sanitizeName, writeAtomic } from "../../src/store.js";
import { detectKind } from "../../src/parse.js";
import { indexOne, isInside } from "../../src/indexer.js";
import { evidence, indexLines } from "../../src/evidence.js";
import { discardRevisions, listRevisions } from "../../src/revisions.js";
import type { DocEntry } from "../../src/types.js";
import type { DocumentInfo, WorkspaceInfo, Preview, ModelSettings, RunInfo } from "../shared.js";

export class HttpError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
interface FileMeta { id: string; name: string; uploadedAt: string; sample?: boolean; }
interface WorkspaceMeta { id: string; name: string; demo: boolean; files: FileMeta[]; }
export interface PrivateSettings { baseUrl: string; model: string; apiKey: string; }
export function editableActions(kind: string): DocumentInfo["editableActions"] {
  return kind === "text" ? ["replace", "insert_after", "delete"] : kind === "docx" ? ["replace"] : [];
}
export class Library {
  private queues = new Map<string, Promise<unknown>>();
  private config?: PrivateSettings;
  constructor(readonly dataRoot: string, readonly projectRoot: string, config?: PrivateSettings) { this.config = config; }
  folder(id: string): string {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new HttpError(400, "工作区标识无效");
    return path.join(this.dataRoot, "workspaces", id);
  }
  store(id: string) { return new Store(path.join(this.folder(id), "documents"), path.join(this.folder(id), "folio")); }
  async init() {
    await fs.mkdir(this.dataRoot, { recursive: true });
    for (const [id, name] of [["main", "我的文档"], ["demo", "比赛示例"]]) {
      await fs.mkdir(this.store(id).root, { recursive: true }); await this.store(id).init();
      try { await fs.access(path.join(this.folder(id), "workspace.json")); }
      catch { await this.saveMeta({ id, name, demo: id === "demo", files: [] }); }
    }
  }
  async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn); this.queues.set(id, current);
    try { return await current; } finally { if (this.queues.get(id) === current) this.queues.delete(id); }
  }
  async meta(id: string): Promise<WorkspaceMeta> {
    try { return JSON.parse(await fs.readFile(path.join(this.folder(id), "workspace.json"), "utf8")); }
    catch { throw new HttpError(404, "没有找到这个工作区"); }
  }
  private async saveMeta(meta: WorkspaceMeta) { await writeAtomic(path.join(this.folder(meta.id), "workspace.json"), JSON.stringify(meta)); }
  info(file: FileMeta, entry?: DocEntry): DocumentInfo {
    return { ...file, kind: entry?.kind ?? detectKind(file.name) ?? "text", size: entry?.size ?? 0,
      status: !entry ? "index_unavailable" : entry.warnings.some(w => w.startsWith("parse failed:")) ? "parse_failed" : entry.chars === 0 ? "no_text" : "ready",
      warnings: entry?.warnings ?? [], units: entry?.units ?? 0, unitKind: entry?.unitKind ?? "block",
      version: entry?.revision, editableActions: editableActions(entry?.kind ?? detectKind(file.name) ?? "text") };
  }
  async workspace(id: string): Promise<WorkspaceInfo> {
    const meta = await this.meta(id), manifest = await this.store(id).load();
    return { id, name: meta.name, demo: meta.demo, documents: meta.files.map(f => this.info(f, manifest.docs[f.name])) };
  }
  async file(id: string, docId: string) {
    const meta = await this.meta(id), file = meta.files.find(f => f.id === docId);
    if (!file) throw new HttpError(404, "文件已移出工作区");
    const store = this.store(id), source = path.resolve(store.root, file.name);
    if (!isInside(source, store.root)) throw new HttpError(400, "文件路径无效");
    return { meta, file, source, store, entry: (await store.load()).docs[file.name] };
  }
  private name(value: string) {
    if (!value || value.includes("/") || value.includes("\\") || value.includes("\0") || value.startsWith(".")) throw new HttpError(400, "请使用不带路径的文件名");
    if (!detectKind(value)) throw new HttpError(415, "暂不支持这个文件格式");
    return sanitizeName(value.trim());
  }
  async add(id: string, originalName: string, buffer: Buffer, sample = false): Promise<DocumentInfo> {
    const name = this.name(originalName), meta = await this.meta(id); let unique = name, n = 2;
    while (meta.files.some(f => f.name.toLocaleLowerCase() === unique.toLocaleLowerCase())) {
      const ext = path.extname(name); unique = `${name.slice(0, -ext.length)} (${n++})${ext}`;
    }
    const file: FileMeta = { id: randomUUID(), name: unique, uploadedAt: new Date().toISOString(), sample };
    const store = this.store(id); await fs.writeFile(path.join(store.root, unique), buffer, { flag: "wx" });
    const entry = await indexOne(store, path.join(store.root, unique), store.root);
    meta.files.push(file); await this.saveMeta(meta); return this.info(file, entry);
  }
  async cancelFileDrafts(store: Store, name: string) {
    const pending = (await listRevisions(store, name)).filter(r => r.status === "pending");
    if (pending.length) await discardRevisions(store, name, pending.map(r => r.id));
  }
  async rename(id: string, docId: string, requested: string) {
    const { file, meta, source, store } = await this.file(id, docId), name = this.name(requested);
    if (path.extname(name).toLowerCase() !== path.extname(file.name).toLowerCase()) throw new HttpError(400, "重命名时请保留文件扩展名");
    if (name === file.name) return this.workspace(id);
    if (meta.files.some(f => f.id !== docId && f.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new HttpError(409, "这个文件名已经存在");
    const target = path.resolve(store.root, name); if (!isInside(target, store.root)) throw new HttpError(400, "文件路径无效");
    await this.cancelFileDrafts(store, file.name);
    await fs.rename(source, target); await store.removeDoc(file.name); file.name = name; await this.saveMeta(meta);
    await indexOne(store, target, store.root); return this.workspace(id);
  }
  async remove(id: string, docId: string) {
    const { file, meta, source, store } = await this.file(id, docId);
    await this.cancelFileDrafts(store, file.name); await fs.rm(source); await store.removeDoc(file.name);
    meta.files = meta.files.filter(f => f.id !== docId); await this.saveMeta(meta);
  }
  async preview(id: string, docId: string, label?: string, version?: string, line = 1): Promise<Preview> {
    const { file, store, entry } = await this.file(id, docId);
    if (!entry) throw new HttpError(409, "索引还未就绪，请重新索引");
    if (version && version !== entry.revision) throw new HttpError(409, "原文版本已变化，这条引用需要重新读取");
    const checked = await evidence(store, entry);
    if (checked.status === "no_text") {
      const labels = entry.kind === "pdf" ? Array.from({ length: entry.units }, (_, i) => `p.${i + 1}`) : [];
      return { doc: this.info(file, entry), text: "", labels, label: label ?? labels[0] ?? "", lines: [], truncated: false };
    }
    if (checked.status !== "ready") throw new HttpError(409, checked.warnings.join("；"));
    const all = indexLines(checked.text), labels = [...new Set(all.map(l => l.label))], chosen = label ?? labels[0] ?? "";
    const paged = ["pdf", "pptx", "xlsx"].includes(entry.kind), source = paged ? all.filter(l => l.label === chosen) : all;
    const anchor = Math.max(0, source.findIndex(l => l.label === chosen && l.line >= line)), begin = Math.max(0, anchor - 5);
    const lines = source.slice(begin, begin + 120).map(l => ({ label: l.label, line: l.line, text: l.text }));
    return { doc: this.info(file, entry), text: lines.map(l => l.text).join("\n"), labels, label: chosen, lines, truncated: begin > 0 || source.length > begin + 120 };
  }
  async refresh(id: string, docId: string) { const { source, store } = await this.file(id, docId); await indexOne(store, source, store.root); return this.workspace(id); }
  async settings(): Promise<PrivateSettings> {
    if (this.config) return this.config;
    try { this.config = JSON.parse(await fs.readFile(path.join(this.dataRoot, "config.json"), "utf8")); }
    catch { this.config = { baseUrl: "", model: "", apiKey: "" }; }
    return this.config!;
  }
  async publicSettings(): Promise<ModelSettings> { const s = await this.settings(); return { baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKey }; }
  async saveSettings(input: { baseUrl: string; model: string; apiKey?: string }): Promise<ModelSettings> {
    let url: URL; try { url = new URL(input.baseUrl); } catch { throw new HttpError(400, "API 地址格式不正确"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HttpError(400, "API 地址必须是 HTTP(S) 接口地址");
    if (!input.model.trim() || input.model.length > 200) throw new HttpError(400, "请填写模型名称");
    const previous = await this.settings(), apiKey = input.apiKey?.trim() || previous.apiKey;
    if (!apiKey) throw new HttpError(400, "请填写 API 密钥");
    const config = { baseUrl: input.baseUrl.replace(/\/+$/, ""), model: input.model.trim(), apiKey };
    await writeAtomic(path.join(this.dataRoot, "config.json"), JSON.stringify(config)); this.config = config;
    return this.publicSettings();
  }
  runFolder(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, "任务标识无效"); return path.join(this.dataRoot, "runs", id); }
  async saveRun(run: RunInfo) { const { events: _, ...meta } = run; await fs.mkdir(this.runFolder(run.id), { recursive: true }); await writeAtomic(path.join(this.runFolder(run.id), "run.json"), JSON.stringify(meta)); }
  async loadRun(id: string): Promise<RunInfo> {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(this.runFolder(id), "run.json"), "utf8"));
      let raw = ""; try { raw = await fs.readFile(path.join(this.runFolder(id), "events.jsonl"), "utf8"); } catch {}
      const events = raw.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      return { ...meta, events };
    } catch { throw new HttpError(404, "任务记录不存在"); }
  }
  async history(workspaceId: string) {
    let ids: string[]; try { ids = await fs.readdir(path.join(this.dataRoot, "runs")); } catch { return []; }
    const runs = await Promise.all(ids.map(id => this.loadRun(id).catch(() => null)));
    return runs.filter((r): r is RunInfo => !!r && r.workspaceId === workspaceId).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
}
