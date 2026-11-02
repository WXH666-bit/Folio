// Folio 三臂对比跑分器。
//   node tests/ab/run.mjs --arms A,B,C --qs q1-locate,q2-amend --conc 3
//
// 每个 (arm, question) 都是完全隔离的一次实验：
//   - 独立工作目录 tests/tmp/ab-work/<arm>-<qid>/，里面是 3 份测试件的全新副本
//     （否则 A 臂会把抽出来的 .txt 留在共享语料目录里，后面的臂直接 cat 就作弊了）
//   - 独立 pi home tests/tmp/ab-homes/<arm>-<qid>/，mcp.json 指向该次的工作目录
//   - B/C 臂在起 pi 之前先把该次工作目录索引好，索引耗时不计入 walls
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { summarize, scoreRec, norm } from "./stat.mjs";
import { isolatedEnv, balancedJobs } from "./isolation.mjs";

const ZIP_DOCS = new Set([".docx", ".pptx", ".xlsx"]);

/** Text of a document as an editor would see it — used to check write tasks. */
async function readAny(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") return "";
  if (!ZIP_DOCS.has(ext)) return fs.readFileSync(file, "utf8");
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const parts = [];
  for (const name of Object.keys(zip.files)) {
    if (!/\.xml$/.test(name)) continue;
    if (!/^(word\/document|ppt\/slides\/slide|xl\/sharedStrings|xl\/worksheets\/sheet)/.test(name)) continue;
    const xml = await zip.file(name).async("string");
    for (const m of xml.matchAll(/<(?:w:t|a:t|t)\b[^>]*>([\s\S]*?)<\/(?:w:t|a:t|t)>/g)) parts.push(m[1]);
  }
  return parts.join("");
}

/** A write task is only "done" if the bytes on disk say so. */
async function checkFiles(q, workDir) {
  if (!q.verify) return null;
  const flat = (s) => norm(String(s ?? "")).replace(/[\u3000\s]+/g, "");
  let text;
  try {
    text = await readAny(path.join(workDir, q.verify.file));
  } catch (err) {
    return { pass: false, missing: q.verify.contains ?? [], left: [], error: String(err) };
  }
  const body = flat(text);
  const missing = (q.verify.contains ?? []).filter((k) => !body.includes(flat(k)));
  const left = (q.verify.absent ?? []).filter((k) => body.includes(flat(k)));
  return { pass: missing.length === 0 && left.length === 0, missing, left };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const CORPUS = path.join(ROOT, "tests", "ab", "corpus");
const RUNS = path.join(ROOT, "tests", "ab", "runs");
const WORK = path.join(ROOT, "tests", "tmp", "ab-work");
const OS_TMP = path.join(ROOT, "tests", "tmp", "ab-private");
const HOMES = path.join(ROOT, "tests", "tmp", "ab-homes");
const TEMPLATE_HOME = path.join(ROOT, "tests", "tmp", "pi-home");
// 用 pi-run 里的副本，避免 npm 重装/外部变动在跑分中途破坏依赖树
const PI = path.join(ROOT, "tests", "tmp", "pi-run", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const MODEL = "aigw/DeepSeek-V4-Flash-0731-W8A8";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const arms = arg("arms", "A,B,C").split(",").filter(Boolean);
const conc = Number(arg("conc", "3"));
// 每格跑几遍：同一题反复跑，方差很大，报告里取中位数
const repeat = Math.max(1, Number(arg("repeat", "1")));
const thinking = arg("thinking", "off");
const CLI = path.resolve(ROOT, arg("folio-cli", "dist/cli.js"));
const modelId = arg("model", MODEL);
const timeoutMs = Number(arg("timeout", "900")) * 1000;
const pauseMs = Math.max(0, Number(arg("pause-ms", "0")));
const maxRetries = Math.max(0, Number(arg("retries", "1")));
const paired = arg("order", "grouped") === "paired";
const corpusDir = path.resolve(ROOT, arg("corpus", CORPUS));
const runsDir = path.resolve(ROOT, arg("runs", RUNS));
const qFile = path.resolve(ROOT, arg("qfile", path.join(ROOT, "tests", "ab", "questions.json")));
const FIXTURES = fs.readdirSync(corpusDir).filter((f) => fs.statSync(path.join(corpusDir, f)).isFile());

const spec = JSON.parse(fs.readFileSync(qFile, "utf8"));
const qs = spec.questions.filter((q) => {
  const want = arg("qs", "");
  return !want || want.split(",").includes(q.id);
});

const ARMS = {
  A: { label: "A 原生 bash+python", mcp: null },
  B: { label: "B folio direct", mcp: "direct" },
  C: { label: "C folio codemode", mcp: "codemode" },
};

function rmrf(p) {
  const rel = path.relative(path.join(ROOT, "tests", "tmp"), path.resolve(p));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("refusing cleanup outside tests/tmp");
  fs.rmSync(p, { recursive: true, force: true });
}

function prep(arm, q, r = 1) {
  const tag = repeat > 1 ? `${arm}-${q.id}-r${r}` : `${arm}-${q.id}`;
  // Each run gets a uniquely named private work/home pair under tests/tmp.
  // This isolates normal writes, not arbitrary filesystem access; the prompt also
  // prohibits looking into other runs. It is not a security sandbox.
  fs.mkdirSync(OS_TMP, { recursive: true });
  const privateRoot = fs.mkdtempSync(path.join(OS_TMP, `folio-ab-${tag}-`));
  const workDir = path.join(privateRoot, "work");
  const homeDir = path.join(privateRoot, "home");
  rmrf(workDir);
  rmrf(homeDir);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  for (const f of FIXTURES) fs.copyFileSync(path.join(corpusDir, f), path.join(workDir, f));

  // pi 的模型配置（和真实 ~/.pi 完全无关）
  fs.copyFileSync(path.join(TEMPLATE_HOME, "models.json"), path.join(homeDir, "models.json"));

  const indexHome = path.join(homeDir, ".folio");
  const exposure = ARMS[arm].mcp;
  if (exposure) {
    const serveArgs = [CLI, "serve", "--root", workDir, "--home", indexHome];
    // 修改/新增/删除类题要真的能写，否则 B/C 只能“提意见”，和 A 的 python 不对等
    if (/修改|新增|删除/.test(String(q.kind ?? ""))) serveArgs.push("--allow-apply");
    const mcp = {
      mcpServers: {
        folio: {
          command: "node",
          args: serveArgs,
          description: "Search and page through the PDF/DOCX/TXT files in the current folder; every hit carries a real page number.",
          exposure,
          timeout: 120,
        },
      },
    };
    fs.writeFileSync(path.join(homeDir, "mcp.json"), JSON.stringify(mcp, null, 2));
  }
  return { privateRoot, workDir, homeDir, indexHome };
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { ...opts, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, out }));
  });
}

async function runOne(arm, q, r = 1) {
  const { privateRoot, workDir, homeDir, indexHome } = prep(arm, q, r);
  const env = isolatedEnv(privateRoot, homeDir);
  const dir = path.join(runsDir, arm);
  fs.mkdirSync(dir, { recursive: true });
  const stem = repeat > 1 ? `${q.id}.r${r}` : q.id;

  // 先把这次的工作目录索引好（只影响 B/C 的索引内容，不计时）
  let indexMs = 0;
  if (ARMS[arm].mcp) {
    const start = Date.now();
    const idx = await run(process.execPath, [CLI, "index", "--root", workDir, "--home", indexHome], { cwd: workDir, env });
    indexMs = Date.now() - start;
    if (idx.code !== 0) console.error(`  [index failed ${arm} ${q.id}] ${idx.out.slice(-300)}`);
  }

  const jsonl = path.join(dir, `${stem}.jsonl`);
  const out = fs.openSync(jsonl, "w");

  const prompt = `${q.q}\n\n回答要求：直接给结论，一到两句话，并注明依据来自哪个文件、第几页或第几节。所有临时文件只能写在当前工作目录或环境变量指定的隔离临时目录；禁止访问用户的真实主目录、个人 pi 配置及其它测试运行目录。`;
  // Keep built-in extensions: pi implements MCP itself as a built-in extension.
  // Personal extensions cannot be discovered in these fresh isolated homes.
  const args = [PI, "-p", prompt, "--model", modelId, "--mode", "json", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--extension", path.join(here,"pi-isolation-guard.mjs"), "--thinking", thinking];
  if (!ARMS[arm].mcp) args.push("--no-mcp");

  return new Promise((resolve) => {
    const t0 = Date.now();
    // stdin 必须 ignore：管道未关闭时 pi 会一直等 stdin，什么也不输出
    const child = spawn(process.execPath, args, { cwd: workDir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const errBuf = [];
    child.stdout.on("data", (d) => fs.writeSync(out, d));
    child.stderr.on("data", (d) => errBuf.push(d.toString()));
    const killer = setTimeout(() => {
      try {
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("close", async (code) => {
      clearTimeout(killer);
      fs.closeSync(out);
      let s = null;
      try {
        s = summarize(jsonl);
      } catch {}
      const rec = {
        arm,
        qid: q.id,
        run: r,
        kind: q.kind,
        code,
        folioCli: CLI,
        wallMs: Date.now() - t0,
        indexMs,
        workDir,
        agentDir: homeDir,
        expects: q.expect,
        expectKeys: q.expectKeys,
        stderrTail: errBuf.join("").slice(-800),
        turns: s?.turns ?? 0,
        toolCalls: s?.toolCalls ?? 0,
        retrievalCalls: s?.retrievalCalls ?? 0,
        repeatedReads: s?.repeatedReads ?? 0,
        tools: s?.tools?.map((t) => t.name) ?? [],
        inputTokens: s?.inputTokens ?? 0,
        cacheReadTokens: s?.cacheReadTokens ?? 0,
        promptTokens: s?.promptTokens ?? 0,
        outputTokens: s?.outputTokens ?? 0,
        reasoningTokens: s?.reasoningTokens ?? 0,
        peakContext: s?.peakContext ?? 0,
        modelMs: s?.durationMs ?? 0,
        retries: s?.retries ?? 0,
        answer: s?.answer ?? "",
        completed: s?.completed ?? false,
        rateLimited: s?.rateLimited ?? false,
        forbid: q.forbid ?? null,
      };
      const scored = scoreRec(rec);
      Object.assign(rec, scored);
      if (q.forbid?.length) {
        const a = norm(rec.answer);
        const hit = q.forbid.filter((k) => a.includes(norm(k)));
        if (hit.length) {
          rec.forbidHit = hit;
          rec.acc = 0;
        }
      }
      rec.fileCheck = await checkFiles(q, workDir);
      if (rec.fileCheck && !rec.fileCheck.pass) rec.acc = 0;
      // This is a literal citation check, separately reported from answer scoring.
      rec.citationCheck = q.citationPatterns ? {
        pass: q.citationPatterns.every((p) => new RegExp(p, "u").test(norm(rec.answer))),
        patterns: q.citationPatterns,
      } : null;
      fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(rec, null, 2));
      resolve(rec);
    });
  });
}

const jobs = paired ? balancedJobs(arms, qs, repeat) : [];
if (!paired) for (const arm of arms) for (const q of qs) for (let r = 1; r <= repeat; r++) jobs.push({ arm, q, r });
let idx = 0;
const results = [];
const keyOf = (rec) => `${rec.arm}|${rec.qid}|${rec.run ?? 1}`;
async function worker() {
  while (idx < jobs.length) {
    const j = jobs[idx++];
    let rec = await runOne(j.arm, j.q, j.r);
    const attempts = [{ promptTokens: rec.promptTokens, wallMs: rec.wallMs, completed: rec.completed, rateLimited: rec.rateLimited }];
    // An empty transcript is a transport/model failure, not an answer: retry once
    // rather than scoring it as "the tool did not help".
    for (let attempt = 0; attempt < maxRetries && rec.empty; attempt++) {
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
      rec = await runOne(j.arm, j.q, j.r);
      attempts.push({ promptTokens: rec.promptTokens, wallMs: rec.wallMs, completed: rec.completed, rateLimited: rec.rateLimited });
    }
    rec.attempts = attempts;
    rec.attemptPromptTokens = attempts.reduce((sum, a) => sum + a.promptTokens, 0);
    rec.attemptWallMs = attempts.reduce((sum, a) => sum + a.wallMs, 0);
    const stem = repeat > 1 ? `${j.q.id}.r${j.r}` : j.q.id;
    fs.writeFileSync(path.join(runsDir, j.arm, `${stem}.json`), JSON.stringify(rec, null, 2));
    results.push(rec);
    // Persist each completed run so an interruption cannot lose the comparison.
    fs.writeFileSync(path.join(runsDir, "progress.json"), JSON.stringify(results, null, 2));
    console.log(
      `[${results.length}/${jobs.length}] ${rec.arm} ${rec.qid}${repeat > 1 ? `#${rec.run}` : ""} turns=${rec.turns} tools=${rec.toolCalls} prompt=${rec.promptTokens} (in=${rec.inputTokens} cache=${rec.cacheReadTokens}) peak=${rec.peakContext} acc=${rec.acc.toFixed(2)} ${Math.round(rec.wallMs / 1000)}s`,
    );
    if (pauseMs && idx < jobs.length) await new Promise((r) => setTimeout(r, pauseMs));
  }
}
await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, worker));

const all = JSON.parse(fs.existsSync(path.join(runsDir, "summary.json")) ? fs.readFileSync(path.join(runsDir, "summary.json"), "utf8") : "[]");
const fresh = new Set(results.map(keyOf));
const merged = all.filter((a) => !fresh.has(keyOf(a))).concat(results);
fs.writeFileSync(path.join(runsDir, "summary.json"), JSON.stringify(merged.sort((a, b) => keyOf(a).localeCompare(keyOf(b))), null, 2));
console.log(`\ndone -> ${path.relative(ROOT, path.join(runsDir, "summary.json"))}`);
