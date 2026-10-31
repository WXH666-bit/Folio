// 读 tests/ab/runs/<arm>/<qid>.json，重新打分并输出 markdown 表。
//   node tests/ab/report.mjs            # 全部
//   node tests/ab/report.mjs --out x.md
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { norm, scoreRec } from "./stat.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? path.resolve(ROOT, process.argv[i + 1]) : dflt;
};
const RUNS = opt("runs", path.join(ROOT, "tests", "ab", "runs"));
const QFILE = opt("qfile", path.join(ROOT, "tests", "ab", "questions.json"));

const ARM_LABEL = {
  A: "A 原生 bash+python",
  B: "B folio direct",
  C: "C folio codemode",
};

function load() {
  const spec = JSON.parse(fs.readFileSync(QFILE, "utf8"));
  const keyById = new Map(spec.questions.map((q) => [q.id, q.expectKeys ?? []]));
  const rows = [];
  for (const arm of fs.readdirSync(RUNS)) {
    const dir = path.join(RUNS, arm);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (keyById.has(rec.qid)) rec.expectKeys = keyById.get(rec.qid);
      rows.push({ ...rec, ...scoreRec(rec) });
    }
  }
  return rows;
}

const rows = load();
if (!rows.length) {
  console.log("no runs found");
  process.exit(0);
}

const qids = [...new Set(rows.map((r) => r.qid))].sort();
const arms = [...new Set(rows.map((r) => r.arm))].sort();
const get = (arm, qid) => rows.find((r) => r.arm === arm && r.qid === qid);

const f = (n) => (n >= 1000 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n)));
const sec = (ms) => (ms / 1000).toFixed(0) + "s";

let md = "";
md += `# Folio 三臂对比（pi ${"1.4.0"} · deepseek-v4-flash-0731 · thinking=off）\n\n`;
md += `口径：prompt tokens = 该轮所有请求 input + cacheRead + cacheWrite 之和（即模型真正读过的 token 总量）；peak = 单次请求最大上下文。\n\n`;

for (const qid of qids) {
  const first = get(arms[0], qid);
  if (!first) continue;
  md += `## ${qid} · ${first.kind}\n\n> ${first.qid === qid ? "" : ""}${first.expects ?? ""}\n\n`;
  md += `| 臂 | 命中 | 正确率 | 轮次 | 工具调用 | prompt tok | peak ctx | 耗时 | 空答 |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const arm of arms) {
    const r = get(arm, qid);
    if (!r) {
      md += `| ${ARM_LABEL[arm] ?? arm} | - | - | - | - | - | - | - | - |\n`;
      continue;
    }
    md += `| ${ARM_LABEL[arm] ?? arm} | ${r.hit.join(" ")} | ${(r.acc * 100).toFixed(0)}% | ${r.turns} | ${r.toolCalls} | ${f(r.promptTokens)} | ${f(r.peakContext)} | ${sec(r.wallMs)} | ${r.empty ? "是" : ""} |\n`;
  }
  md += `\n`;
}

// 汇总
md += `## 汇总\n\n| 臂 | 题数 | 平均正确率 | input | cacheRead | prompt 合计 | 计费等效* | 平均轮次 | 平均耗时 | 平均工具调用 |\n|---|---|---|---|---|---|---|---|---|---|\n`;
const agg = {};
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
for (const arm of arms) {
  const rs = rows.filter((r) => r.arm === arm);
  const sum = (k) => rs.reduce((a, r) => a + (r[k] ?? 0), 0);
  const mean = (k) => sum(k) / rs.length;
  agg[arm] = {
    n: rs.length,
    acc: mean("acc"),
    input: sum("inputTokens"),
    cache: sum("cacheReadTokens"),
    tok: sum("promptTokens"),
    weighted: sum("inputTokens") + 0.1 * sum("cacheReadTokens"),
    turns: mean("turns"),
    wall: mean("wallMs"),
    tools: mean("toolCalls"),
    medTok: med(rs.map((r) => r.promptTokens ?? 0)),
  };
  md += `| ${ARM_LABEL[arm] ?? arm} | ${rs.length} | ${(agg[arm].acc * 100).toFixed(0)}% | ${f(agg[arm].input)} | ${f(agg[arm].cache)} | ${f(agg[arm].tok)} | ${f(agg[arm].weighted)} | ${agg[arm].turns.toFixed(1)} | ${sec(agg[arm].wall)} | ${agg[arm].tools.toFixed(1)} |\n`;
}
md += `\n\\* 计费等效 = input + 0.1 × cacheRead（按多数网关 cache 读约 1/10 价估）。中位数 prompt tok：${arms.map((a) => `${a} ${f(agg[a].medTok)}`).join(" / ")}。\n\n`;

if (agg.A && (agg.B || agg.C)) {
  md += `## 相对 A 的变化\n\n| 臂 | prompt 合计 | 计费等效 | 轮次 | 耗时 | 正确率 |\n|---|---|---|---|---|---|\n`;
  for (const arm of arms.filter((a) => a !== "A")) {
    const x = agg[arm];
    md += `| ${ARM_LABEL[arm]} | ×${(x.tok / agg.A.tok).toFixed(2)} | ×${(x.weighted / agg.A.weighted).toFixed(2)} | ×${(x.turns / agg.A.turns).toFixed(2)} | ×${(x.wall / agg.A.wall).toFixed(2)} | ${(x.acc * 100).toFixed(0)}% vs ${(agg.A.acc * 100).toFixed(0)}% |\n`;
  }
  md += `\n`;
}

const outIdx = process.argv.indexOf("--out");
const target = outIdx >= 0 ? process.argv[outIdx + 1] : path.join(ROOT, "tests", "ab", "report.md");
fs.writeFileSync(target, md, "utf8");
console.log(md);
console.log(`\nwritten -> ${target}`);
