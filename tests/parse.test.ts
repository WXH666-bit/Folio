/**
 * Parser regression test.
 *
 * The whole product rests on one claim: the index says what the page says,
 * where the page says it. A layout regression breaks that silently (the text
 * is still there, just glued together or on the wrong page), so every property
 * the tools rely on gets asserted here against the built code.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexAll } from "../dist/indexer.js";
import { readUnit, searchDocs } from "../dist/search.js";
import { Store } from "../dist/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "fixtures");
const home = path.join(here, "tmp", "parse-state");

function assert(ok: boolean, message: string): void {
  if (!ok) {
    process.stderr.write(`FAIL ${message}\n`);
    process.exit(1);
  }
  process.stdout.write(`ok  ${message}\n`);
}

async function main(): Promise<void> {
  await fs.rm(home, { recursive: true, force: true });
  const store = new Store(root, home);
  const summary = await indexAll(store, root, { force: true });
  const manifest = await store.load();

  assert(summary.indexed === 3, `3 documents are indexed (got ${summary.indexed})`);
  assert(summary.failed === 0, "nothing failed to parse");

  const a = manifest.docs["合同A_主合同.pdf"];
  assert(Boolean(a), "the main contract is in the manifest");
  assert(a.units === 30, `the main contract has 30 pages (got ${a.units})`);
  assert(a.chars > 5000, `the main contract has real text (${a.chars} chars, not a scan)`);
  assert(a.tables.includes("p.7"), `the payment table is on p.7 (got ${a.tables.join(",")})`);
  assert(a.warnings.length === 0, "no warnings for a text PDF");

  // A table row must keep its column gaps; if joinRow regresses the cells fuse
  // into one run-on string and nobody can tell where a column started.
  const p7 = await readUnit(store, "合同A_主合同.pdf", "p.7");
  const header = p7.lines.find((l) => l.includes("支付节点")) ?? "";
  const dataRow = p7.lines.find((l) => l.includes("558,000.00") && l.includes("30%")) ?? "";
  assert(header.includes("比例"), "the p.7 table header mentions 支付节点 比例");
  assert(/ {3,}/.test(header), "the p.7 table header keeps a column gap (three spaces)");
  assert(/ {3,}/.test(dataRow), "the p.7 data row keeps its column gaps");

  // 12.1 is the clause the whole fixture is built around: right page, right text.
  const p12 = await readUnit(store, "合同A_主合同.pdf", "p.12");
  assert(p12.label === "p.12", "p.12 reads back as p.12");
  assert(p12.lines.some((l) => l.includes("第十二条 付款条款")), "p.12 holds the clause heading");
  assert(p12.lines.some((l) => l.includes("三十（30）")), "p.12 holds the 30-day payment term");

  const found = await searchDocs(store, "12.1 三十");
  assert(found.hits.length > 0, "searching for the clause text finds it");
  assert(found.hits[0].label === "p.12", `the hit is on p.12 (got ${found.hits[0]?.label})`);
  assert(Boolean(found.hits[0].section), "the hit carries its section path");

  // The outline must address pages with the same numbers the text uses.
  const clause12 = a.outline.find((n) => n.title.includes("第十二条"));
  assert(Boolean(clause12), "the outline has 第十二条");
  assert(clause12 !== undefined && clause12.unit === 11, `第十二条 points at page 12 (unit ${clause12?.unit})`);

  // Table-of-contents pages repeat the headings, which used to pull entries to
  // p.2; the outline entry must be the one that starts a real page.
  const first = a.outline.find((n) => n.title.includes("第一条"));
  assert(first !== undefined && first.unit >= 2, `第一条 starts on a body page (unit ${first?.unit})`);

  const b = manifest.docs["合同B_补充协议.pdf"];
  assert(b.units === 2, "the amendment has 2 pages");
  const b2 = await readUnit(store, "合同B_补充协议.pdf", "p.2");
  assert(b2.lines.some((l) => l.includes("六十（60）日内")), "the amendment quotes the new 60-day term verbatim");
  assert(b2.lines.some((l) => l.includes("万分之三")), "the amendment quotes the new penalty rate verbatim");

  // Several headings share p.2 of the amendment; a hit must be attributed to the
  // heading above it, not to the first heading on the page.
  const nested = await searchDocs(store, "万分之三");
  assert(
    nested.hits.some((h) => h.section?.includes("具体变更")),
    `a hit is attributed to its own section (got ${nested.hits.map((h) => h.section).join(" / ")})`,
  );

  const docx = manifest.docs["付款条款_内部说明.docx"];
  assert(docx.unitKind === "block", "a docx is indexed in blocks, not pages");
  assert(docx.warnings.some((w) => w.includes("no fixed pages")), "the docx warning explains ¶N");

  process.stdout.write("\nOK — parser regression passed\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
