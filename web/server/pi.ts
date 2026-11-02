import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import type { PrivateSettings } from "./library.js";

export type WireEvent = Record<string, any>;
export interface AgentDriver {
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
}
export interface AgentContext { projectRoot: string; dataRoot: string; workspace: string; documents: string; indexHome: string; settings: PrivateSettings; }
export type AgentFactory = (context: AgentContext, emit: (event: WireEvent) => void) => Promise<AgentDriver>;

/** Pi's framing is LF-only: Unicode U+2028/U+2029 are valid inside document text. */
export class JsonLines {
  private decoder = new StringDecoder("utf8"); private pending = "";
  constructor(private emit: (value: WireEvent) => void) {}
  feed(chunk: Buffer) {
    this.pending += this.decoder.write(chunk);
    let at: number;
    while ((at = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, at).replace(/\r$/, ""); this.pending = this.pending.slice(at + 1);
      if (line.trim()) this.emit(JSON.parse(line));
    }
  }
}

export class RpcDriver implements AgentDriver {
  private child: ChildProcessWithoutNullStreams;
  private requests = new Map<string, { resolve: (v: WireEvent) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closing = false; private stderr = "";
  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, private emit: (event: WireEvent) => void) {
    this.child = spawn(command, args, { ...options, windowsHide: true, detached: process.platform !== "win32", stdio: "pipe" });
    const decoder = new JsonLines(event => {
      if (event.type === "response" && event.id && this.requests.has(event.id)) {
        const req = this.requests.get(event.id)!; clearTimeout(req.timer); this.requests.delete(event.id);
        event.success ? req.resolve(event) : req.reject(new Error(String(event.error ?? "pi 请求失败")));
      } else this.emit(event);
    });
    this.child.stdout.on("data", chunk => { try { decoder.feed(chunk); } catch { this.emit({ type: "driver_error", message: "pi 返回了无法识别的协议消息" }); } });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    this.child.on("error", err => this.fail(err));
    this.child.on("close", code => {
      this.fail(new Error("pi 进程已结束"), false);
      if (!this.closing) this.emit({ type: "driver_error", message: `独立 pi 意外退出（${code ?? "signal"}）${this.stderr ? ": " + this.stderr.slice(-800) : ""}` });
    });
    this.child.stdin.on("error", () => {});
  }
  private fail(error: Error, notify = true) {
    for (const req of this.requests.values()) { clearTimeout(req.timer); req.reject(error); }
    this.requests.clear(); if (notify && !this.closing) this.emit({ type: "driver_error", message: error.message });
  }
  command(type: string, data: Record<string, unknown> = {}): Promise<WireEvent> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error("pi 启动或命令响应超时")); }, 30_000);
      this.requests.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n", err => {
        if (err) { clearTimeout(timer); this.requests.delete(id); reject(err); }
      });
    });
  }
  async prompt(message: string) { const result = await this.command("prompt", { message }); if (result.data?.disposition === "handled") throw new Error("此输入被 pi 当作命令处理，请用自然语言描述文档任务。"); }
  async abort() { await this.command("abort"); }
  async close() {
    if (this.closing) return; this.closing = true; this.fail(new Error("pi 已关闭"), false);
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.stdin.end();
    const timer = setTimeout(() => {
      if (!child.pid) return;
      if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else { try { process.kill(-child.pid,"SIGKILL"); } catch { child.kill("SIGKILL"); } }
    }, 2000);
    await exited; clearTimeout(timer);
  }
}

export async function piStatus(projectRoot: string) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, "pi/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
    return { installed: pkg.version === "1.4.0", version: pkg.version as string };
  } catch { return { installed: false, version: null }; }
}

export function ownedEnvironment(context: AgentContext): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^PI_/i.test(key)) delete env[key];
  const home = path.join(context.dataRoot, "runtime-home"), temp = path.join(home, "temp");
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData/Roaming"), LOCALAPPDATA: path.join(home, "AppData/Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_DATA_HOME: path.join(home, ".local/share"),
    TEMP: temp, TMP: temp, TMPDIR: temp, PI_CODING_AGENT_DIR: path.join(context.workspace, "pi"),
    PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", FOLIO_WEB_MODEL_KEY: context.settings.apiKey };
}

export async function preparePiHome(context: AgentContext) {
  if (!(await piStatus(context.projectRoot)).installed) throw new Error("独立 pi 尚未安装，请在项目根目录运行 npm run setup:pi");
  const agentHome = path.join(context.workspace, "pi"), sessions = path.join(agentHome, "sessions");
  const env = ownedEnvironment(context);
  for (const dir of [agentHome, sessions, env.HOME!, env.TEMP!, env.APPDATA!, env.LOCALAPPDATA!]) await fs.mkdir(dir, { recursive: true });
  const models = { providers: { "folio-web": { name: "文档工坊模型", baseUrl: context.settings.baseUrl, api: "openai-completions", apiKey: "$FOLIO_WEB_MODEL_KEY", authHeader: true,
    compat: { supportsReasoningEffort: false, supportsStore: false, supportsDeveloperRole: false },
    models: [{ id: context.settings.model, name: context.settings.model, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } };
  for (const [name, value] of [["models.json", models]]) {
    const target = path.join(agentHome, String(name)), next = JSON.stringify(value);
    if (await fs.readFile(target, "utf8").catch(() => "") !== next) await fs.writeFile(target, next);
  }
  const cli = path.join(context.projectRoot, "pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  return { agentHome, sessions, env, cli };
}

export const createPiAgent: AgentFactory = async (context, emit) => {
  const { agentHome, sessions, env, cli } = await preparePiHome(context);
  const mcp = { mcpServers: { folio: { command: process.execPath, args: [path.join(context.projectRoot, "dist/cli.js"), "serve", "--root", context.documents, "--home", context.indexHome], exposure: "direct", timeout: 120 } } };
  const target = path.join(agentHome, "mcp.json"), next = JSON.stringify(mcp);
  if (await fs.readFile(target, "utf8").catch(() => "") !== next) await fs.writeFile(target, next);
  const tools = ["list", "outline", "search", "page", "revise", "revisions"].map(n => `mcp__folio__folio_${n}`).join(",");
  const instructions = "你是 Folio 文档工坊的文档助手，用中文简洁回答。只使用提供的 Folio 工具，不转换文件或调用外部程序。引用真实文件名和页码/段落，必须保留版本。扫描件没有文字时如实说明需要 OCR，不猜测内容。修改必须先 folio_page 读取原文及 version，再 folio_revise。你只能提出修改，不能写回；告诉用户在网页右侧查看差异并点击确认盖章。不要声称已修改/保存文件。DOCX 仅能替换文字；其他非文本格式仅提供修改建议。整份文件重命名和删除由网页文件菜单操作，不要清空正文来代替删除文件。";
  const driver = new RpcDriver(process.execPath, [cli, "--mode", "rpc", "--continue", "--session-dir", sessions,
    "--model", `folio-web/${context.settings.model}`, "--tools", tools, "--no-context-files", "--no-skills", "--no-prompt-templates", "--thinking", "off", "--append-system-prompt", instructions],
    { cwd: context.documents, env }, emit);
  try { await driver.command("get_state"); } catch (error) { await driver.close(); throw error; }
  return driver;
};
