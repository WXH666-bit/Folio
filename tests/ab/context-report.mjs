// Generate a reviewable report from measured pi runs, never from hand-entered percentages.
// Defaults are the serial, six-question smoke comparison. Raw/transient runs stay in tests/tmp.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const beforeDir = path.resolve(ROOT, arg("before", "tests/tmp/context-serial-before"));
const afterDir = path.resolve(ROOT, arg("after", "tests/tmp/context-serial-after"));
const spec = JSON.parse(await fs.readFile(path.join(ROOT, "tests/ab/questions-context.json"), "utf8"));
async function load(dir) {
  const rows = JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8"));
  return rows.filter((r) => spec.questions.some((q) => q.id === r.qid));
}
const before = await load(beforeDir), after = await load(afterDir);
for (const rows of [before, after]) {
  if (rows.length !== spec.questions.length || new Set(rows.map((r) => r.qid)).size !== spec.questions.length) {
    throw new Error("Expected exactly one run for each comparison question; do not silently mix incomplete or repeated runs");
  }
}
const short = (r) => ({ qid: r.qid, run: r.run, code: r.code, completed: r.completed, rateLimited: r.rateLimited,
  answer: r.answer, acc: r.acc, fileCheck: r.fileCheck, citationCheck: r.citationCheck,
  promptTokens: r.promptTokens, toolCalls: r.toolCalls, repeatedReads: r.repeatedReads,
  wallMs: r.wallMs, attempts: r.attempts });
const data = { date: "2026-10-31", model: "aigw/DeepSeek-V4-Flash-0731-W8A8", exposure: "direct",
  method: "6 original questions, 26-document corpus, one serial run per question per version; pause 25s, no runner retry, 120s timeout; not a statistically stable estimate",
  before: before.map(short), after: after.map(short),
  manualReview: [
    { qid: "q9-scan", phase: "after", finding: "调用 Folio 后又调用原生 bash/read；120 秒超时，没有最终答案。工具无文本状态不能阻止模型继续尝试。" },
    { qid: "q11-update-md", phase: "after", finding: "真实写盘正确，但将 ¶7 称为第 7 条/节；原文是第二节第 7 行。引用术语不准确。" },
    { qid: "q13-delete-csv", phase: "before", finding: "真实删除正确，但最终答案写第 6 行；原始 CSV 的作废记录在第 5 行。引用字面模式未抓到错误。" },
    { qid: "q13-delete-csv", phase: "after", finding: "真实删除正确，最终答案注明第 5 行，与原始文件一致。" }
  ] };
await fs.writeFile(path.join(ROOT, "tests/ab/context-results.json"), JSON.stringify(data, null, 2) + "\n");
const fmt = (n) => n.toLocaleString("en-US");
const valid = (r) => r.code === 0 && r.completed && !r.rateLimited;
const pass = (r) => valid(r) && r.acc === 1 && (!r.fileCheck || r.fileCheck.pass);
const total = (rows, key) => rows.reduce((sum, r) => sum + (r[key] ?? 0), 0);
const status = (r) => !r ? "未运行" : r.rateLimited ? "限流" : !valid(r) ? "未完成" : pass(r) ? "字面判分通过" : "未通过";
const stats = (rows) => ({ valid: rows.filter(valid).length, passed: rows.filter(pass).length,
  writes: rows.filter((r) => r.fileCheck?.pass).length, writeTotal: rows.filter((r) => r.fileCheck).length,
  citations: rows.filter((r) => valid(r) && r.citationCheck?.pass).length,
  tokens: total(rows, "promptTokens"), calls: total(rows, "toolCalls"), repeated: total(rows, "repeatedReads"),
  seconds: Math.round(total(rows, "wallMs") / 1000) });
const b = stats(before), a = stats(after);
const table = spec.questions.map((q) => {
  const old = before.find((r) => r.qid === q.id), now = after.find((r) => r.qid === q.id);
  return [q.kind + " · " + q.id, fmt(old?.promptTokens ?? 0), fmt(now?.promptTokens ?? 0), `${old?.toolCalls ?? 0} → ${now?.toolCalls ?? 0}`, `${status(old)} → ${status(now)}`];
});
const md = ["# 本轮读取与版本校验验证", "", "日期：2026-10-31。七个工具名称不变；新增读取状态、按需展开、输出预算与游标、文件版本校验。", "",
  "## 功能验证", "", "- 新增 25 项读取/版本回归：含长行与 emoji 分页不丢字、搜索续查无重复、完整条款与 Markdown 章节、扫描件/解析失败/超时区分、同大小同时间戳变更、旧引用/游标拒绝、真实批量增删改及备份。",
  "- 原有解析、存储、搜索、DOCX、修订单、多格式与 MCP 进程冒烟通过；最后修改后重跑了受影响的读取、搜索、MCP 范围。",
  "- 新增统计回归 8 条：只有最后正常结束的回答才计分，HTTP 429 后的中间说明不再冒充答案；重复读取单独统计。", "",
  "## 真实 pi 对照", "", data.method, "",
  "两边使用同一网关、模型、26 份文档、direct 接线和六道原有题；每题一个独立工作目录与 pi home，三道写类题以磁盘内容判定。未修改个人 pi 配置。",
  "最初尝试六题 × 三遍 × 两版本并行，对网关造成每分钟 40 请求限流，已停止。该试跑不计入此表；原始记录保留在 tests/tmp/context-before 与 context-after。这里是另行串行重跑的单次样本，不是 n=3 中位数，不宣称稳定收益。", "",
  "| 任务 | 改前 prompt token | 改后 prompt token | 工具调用前→后 | 判定前→后 |", "|---|---:|---:|---:|---|",
  ...table.map((r) => `| ${r.join(" | ")} |`), "",
  "| 汇总 | 改前 | 改后 |", "|---|---:|---:|",
  `| 正常完成且未受 429 影响 | ${b.valid}/${before.length} | ${a.valid}/${after.length} |`,
  `| 答案字面校验 + 写盘校验通过 | ${b.passed}/${before.length} | ${a.passed}/${after.length} |`,
  `| 真实写盘 | ${b.writes}/${b.writeTotal} | ${a.writes}/${a.writeTotal} |`,
  `| 引用字面模式校验 | ${b.citations}/${before.length} | ${a.citations}/${after.length} |`,
  `| 全部样本 prompt token | ${fmt(b.tokens)} | ${fmt(a.tokens)} |`,
  `| 全部工具调用 | ${b.calls} | ${a.calls} |`,
  `| 相同参数重复调用 Folio 读取工具 | ${b.repeated} | ${a.repeated} |`,
  `| 累计运行秒数（不含任务间暂停/预索引） | ${b.seconds} | ${a.seconds} |`, "",
  "判分限制：关键词与引用模式只检查字面，不等于语义正确率。模型可能在引用某一段时遗漏表格行，或把 DOCX 段号误称页码；原文引用仍需复核。工具状态不会约束模型通过原生 read/bash 绕过 Folio。后面的逐次答案可供人工复核。",
  "实际计费 tokenizer 与工具 maxTokens 的 o200k_base 估算不同。版本字段、警告和更详细的工具 schema 本身有成本；本轮不保证每个任务降低 token。", "",
  "## 人工复核发现", "", ...data.manualReview.map((r) => `- ${r.qid}（${r.phase === "before" ? "改前" : "改后"}）：${r.finding}`), "",
  "## 逐次答案与校验", "",
  ...spec.questions.flatMap((q) => ["### " + q.id, ...[["改前", before], ["改后", after]].flatMap(([label, rows]) => {
    const r = rows.find((r) => r.qid === q.id);
    return [`**${label}**：${status(r)}`, "", r?.answer || "（没有正常完成的最终回答）", "",
      `引用模式：${r?.citationCheck?.pass ? "匹配" : "未匹配"}；写盘：${r?.fileCheck ? r.fileCheck.pass ? "通过" : "未通过" : "不适用"}。`, ""];
  })]),
  "## 复现", "", "先 npm run build。运行前保留旧版本 dist 到 tests/tmp/context-baseline/dist；本次快照在修改前编译。pi 与模型配置沿用 tests/tmp/pi-run、tests/tmp/pi-home，密钥通过环境变量传入，不写入报告。", "",
  "```powershell", "# 两条串行执行，不同时跑；网关仍可能被其它会话占用",
  "node tests/ab/run.mjs --arms B --conc 1 --retries 0 --pause-ms 25000 --timeout 120 --folio-cli tests/tmp/context-baseline/dist/cli.js --corpus tests/ab/corpus2 --qfile tests/ab/questions-context.json --runs tests/tmp/context-serial-before",
  "node tests/ab/run.mjs --arms B --conc 1 --retries 0 --pause-ms 25000 --timeout 120 --corpus tests/ab/corpus2 --qfile tests/ab/questions-context.json --runs tests/tmp/context-serial-after",
  "node tests/ab/context-report.mjs", "```", "",
  "原始过程放在 tests/tmp；长期保留不含密钥的 context-results.json、此报告和题目定义。旧版本快照属于临时文件，不应提交；跨机器重现改前结果需要另外保留对应源码版本。", ""];
await fs.writeFile(path.join(ROOT, "tests/ab/context-report.md"), md.join("\n"));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Folio · 本轮验证</title>
<style>
:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#20302c;background:#f5f6f3;font-synthesis:none}
*{box-sizing:border-box}body{margin:0}main{max-width:880px;margin:auto;padding:52px 28px 40px}
header{border-top:4px solid #245d48;padding-top:18px}header p{margin:0;color:#50645a;font-size:13px;letter-spacing:.05em}
h1{font-size:32px;line-height:1.3;margin:14px 0}h2{font-size:17px;margin:0 0 14px}p{line-height:1.75}
.lead{font-size:17px;max-width:42em}section{margin-top:30px}ul{padding-left:1.2em;line-height:1.8;margin:0}
.checks{border-block:1px solid #cbd4cc;padding:18px 0}.checks p{margin:0}.checks strong{color:#245d48}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}caption{text-align:left;color:#50645a;font-size:13px;padding:0 0 10px}
th,td{padding:11px 9px;border-bottom:1px solid #d7ded6;text-align:right}th:first-child,td:first-child{text-align:left}th{color:#50645a;font-weight:500}tfoot{font-weight:600}small{display:block;font-size:12px;line-height:1.6;color:#50645a}.fail{color:#a13625}
.note{color:#50645a;font-size:13px;margin-top:14px}footer{border-top:1px solid #cbd4cc;margin-top:28px;padding-top:16px;font-size:13px;line-height:1.8}a{color:#245d48;text-underline-offset:3px}a:focus-visible{outline:2px solid #245d48;outline-offset:4px}
@media(max-width:520px){main{padding:28px 18px}h1{font-size:27px}.lead{font-size:16px}th,td{padding:10px 4px;font-size:13px}section{margin-top:25px}}
</style></head><body><main>
<header><p>FOLIO / 验证记录 · 2026-10-31</p><h1>四项改进已落地</h1>
<p class="lead">读取状态更明确，长内容可以继续展开，旧版本引用会被拦截。功能测试通过；模型实测结果有升有降，暂不能得出稳定省 token 的结论。</p></header>
<section aria-labelledby="changes"><h2 id="changes">改了什么</h2><ul>
<li><b>明确状态：</b>区分未命中、无文本、解析失败、索引过期与未查完。</li>
<li><b>按需读取：</b>支持全文、上下文、章节展开；预算内返回，游标续读。</li>
<li><b>版本核对：</b>引用绑定文件版本；文件变化后，旧修订拒绝写入。</li>
<li><b>验证与统计：</b>增加回归测试，区分最终答案、真实写盘与失败任务。</li>
</ul></section>
<section class="checks" aria-label="功能验证"><p><strong>25 项新增功能测试通过</strong> · 8 条统计检查通过</p><small>原有回归与 MCP 端到端验证通过；变更后已重跑受影响范围。</small></section>
<section aria-labelledby="comparison"><h2 id="comparison">同一模型，改前与改后</h2>
<table><caption>26 份文档 · 6 类任务各跑一次 · 数值为 prompt token</caption>
<thead><tr><th scope="col">任务</th><th scope="col">改前</th><th scope="col">改后</th></tr></thead>
<tbody>${spec.questions.map((q) => { const old = before.find((r) => r.qid === q.id), now = after.find((r) => r.qid === q.id); return `<tr><th scope="row">${esc(q.kind)}</th><td>${fmt(old?.promptTokens ?? 0)}${!valid(old) ? `<small class="fail">${status(old)}</small>` : ""}</td><td>${fmt(now?.promptTokens ?? 0)}${!valid(now) ? `<small class="fail">${status(now)}</small>` : ""}</td></tr>`; }).join("\n")}</tbody>
<tfoot><tr><th scope="row">正常完成</th><td>${b.valid}/${before.length}</td><td>${a.valid}/${after.length}</td></tr>
<tr><th scope="row">写盘检查通过</th><td>${b.writes}/${b.writeTotal}</td><td>${a.writes}/${a.writeTotal}</td></tr></tfoot></table>
<p class="note">这是单次探索样本，不代表稳定收益。未完成任务的已消耗 token 也计入。关键词命中不等于引用正确；工具返回无文本，也不能阻止模型自行调用其他工具。</p>
</section><footer><a href="tests/ab/context-report.md">详细结果与失败说明</a> · <a href="tests/ab/context-results.json">机器可读数据</a><br>独立结果页，可由 tests/ab/context-report.mjs 重新生成。</footer>
</main></body></html>`;
await fs.writeFile(path.join(ROOT, "verification.html"), html);
console.log(JSON.stringify({ before: b, after: a, report: "tests/ab/context-report.md", page: "verification.html" }));
