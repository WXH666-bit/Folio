/**
 * Wide-corpus report: medians per (arm, question) over N repeats.
 *
 * Unlike report.mjs this keeps write tasks visible: a write question also gets a
 * file check column, because "answered correctly" is not the same as "the file
 * really changed". A run whose file check failed counts as wrong.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const RUNS = path.resolve(ROOT, arg("runs", "tests/ab/runs-wide"));
const QFILE = path.resolve(ROOT, arg("qfile", "tests/ab/questions2.json"));
const OUT = path.resolve(ROOT, arg("out", "tests/ab/report-wide.md"));
const ARMS = arg("arms", "A,B,C").split(",");

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const fmt = (n) => n.toLocaleString("en-US");
const pct = (a, b) => (b === 0 ? "—" : `${Math.round((1 - a / b) * 100)}%`);

async function loadArm(arm) {
  const dir = path.join(RUNS, arm);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return new Map();
  }
  const byQ = new Map();
  for (const n of names) {
    if (!n.endsWith(".json") || n === "summary.json") continue;
    const rec = JSON.parse(await fs.readFile(path.join(dir, n), "utf8"));
    const qid = rec.qid ?? n.replace(/-\d+\.json$|\.json$/, "").replace(/-r\d+$/, "");
    if (!byQ.has(qid)) byQ.set(qid, []);
    byQ.get(qid).push(rec);
  }
  return byQ;
}

async function main() {
  const doc = JSON.parse(await fs.readFile(QFILE, "utf8"));
  const qs = Array.isArray(doc) ? doc : doc.questions;
  const byArm = new Map();
  for (const arm of ARMS) byArm.set(arm, await loadArm(arm));

  const lines = [];
  lines.push(`# 宽语料结果（${qs.length} 题 × ${ARMS.length} 臂，取中位数）`);
  lines.push("");
  lines.push(`语料：\`tests/ab/corpus2\`（26 份 / 6 领域 / 8 种格式）　题库：\`${path.relative(ROOT, QFILE)}\``);
  lines.push("");
  const head = ["题", "类型", ...ARMS, "B 省下", "文件校验"];
  lines.push(`| ${head.join(" | ")} |`);
  lines.push(`|${head.map(() => "---").join("|")}|`);

  const totals = new Map(ARMS.map((a) => [a, []]));
  const pass = new Map(ARMS.map((a) => [a, { ok: 0, n: 0 }]));

  for (const q of qs) {
    const cells = [];
    const meds = {};
    for (const arm of ARMS) {
      const recs = byArm.get(arm).get(q.id) ?? [];
      if (!recs.length) {
        cells.push("—");
        continue;
      }
      const m = median(recs.map((r) => r.promptTokens));
      meds[arm] = m;
      totals.get(arm).push(m);
      const marks = [];
      if (recs.some((r) => r.acc < 1)) marks.push("✻");
      if (recs.some((r) => r.fileCheck && !r.fileCheck.pass)) marks.push("✗");
      cells.push(`${fmt(m)}${marks.join("")}`);
    }
    const write = q.verify ? `真写盘 ${q.verify.contains?.length ?? 0} 条` : "";
    if (q.verify) {
      for (const arm of ARMS) {
        const recs = byArm.get(arm).get(q.id) ?? [];
        for (const r of recs) {
          pass.get(arm).n++;
          if (r.fileCheck?.pass) pass.get(arm).ok++;
        }
      }
    }
    const a = meds[ARMS[0]];
    const b = meds["B"];
    lines.push(
      `| ${q.q} | ${q.kind} | ${cells.join(" | ")} | ${a && b ? pct(b, a) : "—"} | ${write} |`,
    );
  }

  lines.push("");
  lines.push("## 合计（各题中位数之和）");
  lines.push("");
  lines.push(`| | ${ARMS.join(" | ")} |`);
  lines.push(`|${["---", ...ARMS.map(() => "---")].join("|")}|`);
  lines.push(`| token | ${ARMS.map((a) => fmt(totals.get(a).reduce((x, y) => x + y, 0))).join(" | ")} |`);
  lines.push(
    `| 写类题真写盘 | ${ARMS.map((a) => {
      const p = pass.get(a);
      return p.n ? `${p.ok}/${p.n}` : "—";
    }).join(" | ")} |`,
  );

  await fs.writeFile(OUT, lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
  console.log(`\n-> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
