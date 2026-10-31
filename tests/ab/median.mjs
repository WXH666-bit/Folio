// 把 runs/summary.json 按 (臂, 题) 聚成中位数表 —— 同一题多跑几遍时方差很大，
// 单次数值不适合拿来对外说。用法：
//   node tests/ab/median.mjs                      # tests/ab/runs
//   node tests/ab/median.mjs --runs tests/ab/runs-n3 --out tests/ab/report-n3.md
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const runsDir = path.resolve(ROOT, opt("runs", path.join(ROOT, "tests", "ab", "runs")));
const outFile = opt("out", null);
const rows = JSON.parse(fs.readFileSync(path.join(runsDir, "summary.json"), "utf8"));

const med = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const k = (n) => `${Math.round(n / 100) / 10}k`;
const secs = (ms) => `${Math.round(ms / 1000)}s`;

// 一题一臂一行（中位数）
const cells = new Map();
for (const r of rows) {
  const key = `${r.arm}|${r.qid}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push(r);
}
const qids = [...new Set(rows.map((r) => r.qid))].sort();
const arms = [...new Set(rows.map((r) => r.arm))].sort();

const lines = [];
const P = (s = "") => lines.push(s);

P(`# 同一题多遍取中位数（${path.relative(ROOT, runsDir)}）`);
P();
P(`${rows.length} 次运行 · ${qids.length} 题 × ${arms.length} 臂 · 每格 ${Math.round(rows.length / (qids.length * arms.length))} 遍`);
P();

P("## 每道题：中位 prompt tokens（正确率）");
P();
P(`| 题 | ${arms.map((a) => `臂 ${a}`).join(" | ")} |`);
P(`|---|${arms.map(() => "---").join("|")}|`);
for (const qid of qids) {
  const cols = arms.map((arm) => {
    const ts = cells.get(`${arm}|${qid}`) ?? [];
    if (!ts.length) return "—";
    return `${med(ts.map((t) => t.promptTokens))} (${Math.round(avg(ts.map((t) => (t.acc >= 1 ? 1 : 0))) * 100)}%)`;
  });
  P(`| ${qid} | ${cols.join(" | ")} |`);
}
P();

P("## 每臂合计（各格中位数再平均）");
P();
P("| 臂 | 每格中位 tokens | 中位 input | 中位 cacheRead | 计费等效 | 每格中位峰值上下文 | 每格中位轮次 | 每格中位耗时 | 正确率 |");
P("|---|---|---|---|---|---|---|---|---|");
for (const arm of arms) {
  const perCell = qids.map((qid) => cells.get(`${arm}|${qid}`)).filter(Boolean);
  const medOf = (field) => med(perCell.map((ts) => med(ts.map((t) => t[field] ?? 0))));
  const tok = medOf("promptTokens");
  const input = medOf("inputTokens");
  const cache = medOf("cacheReadTokens");
  const peak = medOf("peakContext");
  const turns = medOf("turns");
  const wall = medOf("wallMs");
  const acc = avg(perCell.map((ts) => avg(ts.map((t) => (t.acc >= 1 ? 1 : 0)))));
  // 计费等效：input + 0.1 × cacheRead（多数网关缓存读约 1/10 价）
  const billed = Math.round(input + 0.1 * cache);
  P(`| ${arm} | ${tok.toLocaleString()} | ${input.toLocaleString()} | ${cache.toLocaleString()} | ${billed.toLocaleString()} | ${k(peak)} | ${turns} | ${secs(wall)} | ${Math.round(acc * 100)}% |`);
}
P();
P(`_峰值为 prompt tokens 单轮最大值；正确率按每题「期望关键词是否全部出现」计。_`);

const text = `${lines.join("\n")}\n`;
if (outFile) {
  fs.writeFileSync(path.resolve(ROOT, outFile), text, "utf8");
  console.log(`written -> ${outFile}`);
}
console.log(text);
