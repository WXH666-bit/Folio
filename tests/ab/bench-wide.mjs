/**
 * Renders the "wider corpus" section of bench.html straight from the run data,
 * so the page cannot drift from report-wide.md.
 *
 *   node tests/ab/bench-wide.mjs [--runs tests/ab/runs-wide2]
 *
 * Replaces whatever sits between <!-- WIDE:BEGIN --> and <!-- WIDE:END -->.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const RUNS = path.resolve(ROOT, arg("runs", "tests/ab/runs-wide2"));
const QFILE = path.resolve(ROOT, arg("qfile", "tests/ab/questions2.json"));
const HTML = path.resolve(ROOT, arg("html", "bench.html"));
const ARMS = ["A", "B", "C"];

const fmt = (n) => (n ? n.toLocaleString("en-US") : "—");
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const rows = [];
for (const arm of ARMS) {
  let names = [];
  try {
    names = await fs.readdir(path.join(RUNS, arm));
  } catch {}
  for (const n of names) {
    if (!n.endsWith(".json") || n === "summary.json") continue;
    const rec = JSON.parse(await fs.readFile(path.join(RUNS, arm, n), "utf8"));
    rows.push(rec);
  }
}
if (!rows.length) throw new Error(`no runs under ${RUNS}`);

const qdoc = JSON.parse(await fs.readFile(QFILE, "utf8"));
const qs = Array.isArray(qdoc) ? qdoc : qdoc.questions;

const byKey = new Map();
for (const r of rows) {
  const k = `${r.arm}|${r.qid}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(r);
}

const data = qs.map((q) => {
  const cell = (arm) => {
    const recs = byKey.get(`${arm}|${q.id}`) ?? [];
    if (!recs.length) return { v: 0, bad: false, fileBad: false };
    return {
      v: median(recs.map((r) => r.promptTokens)),
      bad: recs.some((r) => r.acc < 1),
      fileBad: recs.some((r) => r.fileCheck && !r.fileCheck.pass),
    };
  };
  return {
    name: q.q.length > 46 ? q.q.slice(0, 44) + "…" : q.q,
    tag: q.kind,
    a: cell("A"),
    b: cell("B"),
    c: cell("C"),
    write: q.verify ? q.verify.file : "",
  };
});

const max = Math.max(...data.flatMap((d) => [d.a.v, d.b.v, d.c.v]));
const sum = (k) => data.reduce((s, d) => s + d[k].v, 0);
const pctTxt = (a, b) => {
  if (!a || !b) return "—";
  const saved = 1 - b / a;
  return (saved >= 0 ? "节省 " : "多花 ") + Math.abs(Math.round(saved * 100)) + "%";
};

const bar = (d, key) => {
  const ratio = max ? (d[key].v / max) * 100 : 0;
  const mark = d[key].bad ? `<span class="bad" title="这一轮答错了">✻</span>` : "";
  const fileBad = d[key].fileBad ? `<span class="bad" title="文件没被真正改动">✗</span>` : "";
  return `<td data-arm="${key.toUpperCase()}"><div class="arm__num">${fmt(d[key].v)}${mark}${fileBad}</div>
      <div class="track"><div class="bar bar--${key}" style="width:${ratio.toFixed(2)}%"></div></div></td>`;
};

const writeOK = (arm) => {
  const recs = rows.filter(
    (r) => r.arm === arm && (qs.find((q) => q.id === r.qid)?.verify ?? false),
  );
  if (!recs.length) return "—";
  return `${recs.filter((r) => r.fileCheck?.pass).length}/${recs.length}`;
};

const body = data
  .map(
    (d) => `      <tr><td><div class="q">${esc(d.name)}<small>${esc(d.tag)}${
      d.write ? ` · 校验 ${esc(d.write)}` : ""
    }</small></div></td>
      ${bar(d, "a")}${bar(d, "b")}${bar(d, "c")}
      <td class="save">${pctTxt(d.a.v, d.b.v)}<i>B 对 A</i></td></tr>`,
  )
  .join("\n");

const section = `<!-- WIDE:BEGIN -->
<section class="band" id="wide">
  <div class="section-head">
    <h2>换一批更杂的文档</h2>
    <p class="note">26 份文件 · 6 个领域 · 8 种格式 · 16 题</p>
  </div>
  <p class="lede">上一张表是 3 份合同。这一张是 26 份：PDF（含 60 页规范、扫描件）、docx、pptx、xlsx、csv、md、html，横跨六个行业。其中 6 道题要求<b>真的改文件</b>，判定不看答案看磁盘。结论和上面不一样——<b>省不省取决于目标内容有多难拿到，不取决于文件多少</b>。</p>

  <table class="ledger ledger--wide">
    <colgroup>
      <col style="width:36%" /><col style="width:17.5%" /><col style="width:17.5%" /><col style="width:17.5%" /><col style="width:11.5%" />
    </colgroup>
    <thead>
      <tr><th>问题</th><th>A 老办法</th><th>B 加索引</th><th>C 绕一圈</th><th>B 省下</th></tr>
    </thead>
    <tbody>
${body}
    </tbody>
    <tfoot>
      <tr><td>十六题中位（合计）</td><td>${fmt(sum("a"))}</td><td>${fmt(sum("b"))}</td><td>${fmt(
        sum("c"),
      )}</td><td class="save">${pctTxt(sum("a"), sum("b"))}</td></tr>
      <tr><td>写类题真的改动了文件</td><td>${writeOK("A")}</td><td>${writeOK("B")}</td><td>${writeOK(
        "C",
      )}</td><td class="save"></td></tr>
    </tfoot>
  </table>
  <p class="note" style="margin-top:14px">读法：30 页 PDF、60 页规范、跨文件对照——这类题 B 省 43%～81%；<b>几百字节的 md / csv 反而 B 更贵</b>，因为老办法一次 grep 就够了，而索引要付固定的工具开销。合计 B 略高于 A（+10%），差距全在“文档长不长”上。　✻ 至少一次答错　✗ 文件没被真正改动　条形按本表最大值（${fmt(
    max,
  )}）同尺度。</p>
</section>
<!-- WIDE:END -->`;

const html = await fs.readFile(HTML, "utf8");
const re = /<!-- WIDE:BEGIN -->[\s\S]*?<!-- WIDE:END -->/;
if (!re.test(html)) throw new Error("markers not found in bench.html");
await fs.writeFile(HTML, html.replace(re, section), "utf8");
console.log(`section written · max=${fmt(max)} · sumA=${fmt(sum("a"))} sumB=${fmt(sum("b"))} sumC=${fmt(sum("c"))}`);
