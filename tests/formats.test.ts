/**
 * Format coverage: every parser must produce units a cite can point at.
 *
 * Uses the generated corpus (tests/ab/corpus2) so the assertions are about real
 * bytes rather than hand-made strings: pptx slides, xlsx sheets, html blocks,
 * and a scan-only PDF that must fail honestly.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectKind, parseFile } from "../src/parse.js";
import { parseXlsx } from "../src/parse-office.js";
import { indexAll } from "../src/indexer.js";
import { Store } from "../src/store.js";
import { readUnit, searchDocs } from "../src/search.js";
import { addRevision, applyRevisions } from "../src/revisions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const CORPUS = path.join(ROOT, "tests", "ab", "corpus2");
const TMP = path.join(ROOT, "tests", "tmp", "formats-state");

let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
}
const file = (name: string): string => path.join(CORPUS, name);

async function main(): Promise<void> {
  // --- extension dispatch -------------------------------------------------
  ok("detect .pptx", detectKind("a.pptx") === "pptx");
  ok("detect .xlsx", detectKind("a.xlsx") === "xlsx");
  ok("detect .html", detectKind("a.html") === "html");
  ok("detect .htm", detectKind("a.htm") === "html");
  ok("detect .pdf", detectKind("a.pdf") === "pdf");
  ok("reject .png", detectKind("a.png") === null);

  // --- pptx: one unit per slide ------------------------------------------
  const deck = await parseFile(file("培训_课程大纲.pptx"), "pptx");
  ok("pptx unitKind", deck.unitKind === "slide", deck.unitKind);
  ok("pptx 12 slides", deck.units.length === 12, String(deck.units.length));
  ok("pptx labels sl.N", deck.units[5].label === "sl.6", deck.units[5].label);
  ok("pptx slide 6 = 数据脱敏", deck.units[5].lines.join(" ").includes("数据脱敏"));

  // --- xlsx: one unit per sheet, rows as lines ---------------------------
  const book = await parseFile(file("财税_支出台账.xlsx"), "xlsx");
  ok("xlsx unitKind", book.unitKind === "sheet", book.unitKind);
  ok("xlsx sheet label", book.units[0].label === "sh.2025支出台账", book.units[0].label);
  const bigRow = book.units[0].lines.find((l) => l.includes("4280000"));
  ok("xlsx big row found", Boolean(bigRow));
  ok("xlsx row keeps columns apart", Boolean(bigRow && / {3,}/.test(bigRow)), bigRow ?? "");
  ok("xlsx date warning", book.warnings.some((w) => w.includes("serial")));

  // --- shared strings: a text cell must not become an index --------------
  const names = await parseFile(file("培训_学员名单.xlsx"), "xlsx");
  const hasName = names.units[0].lines.some((l) => l.startsWith("1   李娜   技术部"));
  ok("xlsx shared string decoded", hasName, names.units[0].lines[1] ?? "");

  // --- html ---------------------------------------------------------------
  const page = await parseFile(file("技术_接口文档.html"), "html");
  ok("html unitKind", page.unitKind === "block", page.unitKind);
  ok("html keeps 100 rps", page.units.some((u) => u.lines.join(" ").includes("100 rps")));
  ok("html drops script", !page.units.some((u) => u.lines.join(" ").includes("<script")));

  // --- scan-only PDF must warn, not invent text ---------------------------
  const scan = await parseFile(file("政府_签到表_扫描件.pdf"), "pdf");
  ok("scan pdf has pages", scan.units.length === 2, String(scan.units.length));
  ok("scan pdf warns OCR", scan.warnings.some((w) => w.includes("OCR")));

  // --- an index over the whole corpus, then cite into the new formats -----
  await fs.rm(TMP, { recursive: true, force: true });
  const store = new Store(CORPUS, path.join(TMP, ".folio"));
  await store.init();
  const summary = await indexAll(store, CORPUS, { force: true });
  ok("indexed 26 docs", summary.indexed >= 26, String(summary.indexed));

  const slide = await readUnit(store, "培训_课程大纲.pptx", "6");
  ok("bare 6 resolves to sl.6", Boolean(slide && slide.label === "sl.6"), slide?.label ?? "null");
  ok("slide text", Boolean(slide && slide.lines.join(" ").includes("数据脱敏")));

  const row = await readUnit(store, "财税_支出台账.xlsx", "sh.2025支出台账");
  ok("sheet label cite", Boolean(row && row.lines.some((l) => l.includes("4280000"))));

  const hits = await searchDocs(store, "数据脱敏", {});
  ok("search finds pptx", hits.hits.some((h) => h.doc === "培训_课程大纲.pptx" && h.label === "sl.6"));

  const xlHits = await searchDocs(store, "设备采购", {});
  ok("search finds xlsx", xlHits.hits.some((h) => h.doc === "财税_支出台账.xlsx"));

  // --- delete action: plain text only, and it really removes the line -----
  const doc = path.join(CORPUS, "技术_值班记录.csv");
  const before = await fs.readFile(doc, "utf8");
  const rev = await addRevision(store, {
    doc: "技术_值班记录.csv",
    target: "¶5:L1",
    action: "delete",
    reason: "作废记录",
  });
  ok("delete revision recorded", rev.action === "delete" && rev.text === "");
  let refused = false;
  try {
    await addRevision(store, { doc: "医疗_门诊病历.pdf", target: "p.1:L1", action: "delete" });
  } catch {
    refused = true;
  }
  ok("delete refused for pdf", refused);

  await applyRevisions(store, "技术_值班记录.csv", [rev.id]);
  const after = await fs.readFile(doc, "utf8");
  ok("delete removed the row", before.includes("2025-09-04") && !after.includes("2025-09-04"));
  ok("delete kept the other rows", after.includes("2025-09-05"));
  await fs.writeFile(doc, before, "utf8");

  // --- a zip container must never be rewritten as text --------------------
  const deckRev = await addRevision(store, {
    doc: "培训_课程大纲.pptx",
    target: "sl.6:L1",
    action: "replace",
    text: "数据脱敏（改）",
    reason: "验收：只允许出意见",
  });
  const deckBytes = await fs.readFile(file("培训_课程大纲.pptx"));
  let deckRefused = "";
  try {
    await applyRevisions(store, "培训_课程大纲.pptx", [deckRev.id]);
  } catch (err) {
    deckRefused = String(err).slice(0, 160);
  }
  const deckAfter = await fs.readFile(file("培训_课程大纲.pptx"));
  ok("pptx proposal is allowed", deckRev.status === "pending");
  ok("pptx apply refused", deckRefused.includes("would corrupt"), deckRefused);
  ok("pptx bytes untouched", Buffer.compare(deckBytes, deckAfter) === 0);

  console.log(`\n${failures === 0 ? "OK" : "FAILED"} — ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
