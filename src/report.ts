/**
 * The honesty device.
 *
 * The claim this project makes is "the same answer for a fraction of the
 * tokens". A claim like that is worth nothing until it is measured, so
 * `folio report` measures it on your own documents: what a full read would
 * cost, what folio actually returns, and the ratio — caveats included.
 */
import fs from "node:fs/promises";
import { countTokens } from "gpt-tokenizer";
import { formatPage, formatSearch } from "./format.js";
import { readUnit, searchDocs } from "./search.js";
import type { Store } from "./store.js";

/** Count display columns (CJK is two) so columns line up in a monospace view. */
function widthOf(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch)
      ? 2
      : 1;
  }
  return w;
}

function left(s: string, width: number): string {
  return s + " ".repeat(Math.max(1, width - widthOf(s)));
}

function right(s: string, width: number): string {
  return " ".repeat(Math.max(0, width - widthOf(s))) + s;
}

function n(x: number): string {
  return x.toLocaleString("en-US");
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "n/a";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

async function docBody(store: Store, doc: string): Promise<string> {
  let text: string;
  try {
    text = await fs.readFile(store.indexFile(doc), "utf8");
  } catch {
    return "";
  }
  return text
    .split("\n")
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab > 0 ? line.slice(tab + 1) : line;
    })
    .filter(Boolean)
    .join("\n");
}

export async function buildReport(store: Store, query: string): Promise<string> {
  const manifest = await store.load();
  const docs = Object.values(manifest.docs).sort((a, b) => a.doc.localeCompare(b.doc));
  if (docs.length === 0) {
    return "nothing indexed yet — run `folio index` (or `folio start`) in the folder first.";
  }

  const out: string[] = [];
  out.push(`folio report · query "${query}"`);
  out.push(`root  ${manifest.root}`);
  out.push(`index ${store.home}`);

  // --- what a full read costs ------------------------------------------------
  const rows: Array<{ doc: string; shape: string; tokens: number }> = [];
  let full = 0;
  for (const entry of docs) {
    const body = await docBody(store, entry.doc);
    const tokens = body ? countTokens(body) : 0;
    full += tokens;
    rows.push({
      doc: entry.doc,
      shape:
        entry.unitKind === "page"
          ? `${entry.units}p`
          : entry.unitKind === "slide"
            ? `${entry.units} sl`
            : entry.unitKind === "sheet"
              ? `${entry.units} sh`
              : `${entry.units} blk`,
      tokens,
    });
  }
  const nameWidth = Math.max(...rows.map((r) => widthOf(r.doc)), widthOf("total")) + 3;

  out.push("");
  out.push("baseline — the whole corpus, as an agent would have to read it");
  for (const row of rows) {
    out.push(`  ${left(row.doc, nameWidth)}${right(row.shape, 6)}${right(n(row.tokens), 10)} tok`);
  }
  out.push(`  ${left("total", nameWidth)}${right("", 6)}${right(n(full), 10)} tok`);

  // --- what folio costs -----------------------------------------------------
  const search = await searchDocs(store, query, { limit: 20 });
  const searchText = formatSearch(query, search);
  const searchTokens = countTokens(searchText);

  let pageTokens = 0;
  let pageLabel = "";
  let pageText = "";
  const first = search.hits[0];
  if (first) {
    const unit = await readUnit(store, first.doc, first.label);
    if (unit) {
      pageLabel = `${unit.doc}:${unit.label}`;
      pageText = formatPage(unit.doc, unit.label, unit.lines, unit.totalUnits);
      pageTokens = countTokens(pageText);
    }
  }

  const costRows = [
    { label: `folio_search "${query}"`, note: `${search.totalHits} hits`, tokens: searchTokens },
  ];
  if (pageLabel) costRows.push({ label: `+ folio_page ${pageLabel}`, note: "1 unit", tokens: pageTokens });
  const labelWidth = Math.max(...costRows.map((r) => widthOf(r.label))) + 3;

  out.push("");
  out.push("this query");
  for (const row of costRows) {
    out.push(`  ${left(row.label, labelWidth)}${right(row.note, 8)}${right(n(row.tokens), 8)} tok`);
  }

  out.push("");
  out.push("  --- exactly what comes back ---");
  for (const line of `${searchText}${pageText ? `\n${pageText}` : ""}`.split("\n")) {
    if (line) out.push(`  | ${line}`);
  }

  // --- the ratio ------------------------------------------------------------
  const searchOnly = searchTokens;
  const searchPlusPage = searchTokens + pageTokens;
  out.push("");
  out.push("occupancy — what sits in the context window while the agent works");
  out.push(`  ${left("read the corpus", 22)}${right(n(full), 10)} tok   ${pct(full, full)}`);
  out.push(`  ${left("search only", 22)}${right(n(searchOnly), 10)} tok   ${pct(searchOnly, full)}`);
  if (pageLabel) {
    out.push(`  ${left("search + one page", 22)}${right(n(searchPlusPage), 10)} tok   ${pct(searchPlusPage, full)}`);
  }

  out.push("");
  out.push("scaling — input tokens over a session are turns × the above");
  const perTurn = pageLabel ? searchPlusPage : searchOnly;
  for (const turns of [1, 5, 15, 40]) {
    out.push(
      `  ${left(`${turns} turn${turns > 1 ? "s" : ""}`, 12)}${right(n(full * turns), 12)} vs ${n(perTurn * turns)}`,
    );
  }

  // --- what the table hides --------------------------------------------------
  let indexBytes = 0;
  for (const file of await store.indexFiles()) {
    try {
      indexBytes += (await fs.stat(file)).size;
    } catch {
      /* ignore */
    }
  }
  out.push("");
  out.push("notes");
  out.push(
    `  index on disk: ${(indexBytes / 1024).toFixed(0)} KB for ${docs.length} docs — built once, in a separate process,`,
  );
  out.push("  not on the model's clock.");
  out.push("  tokens counted with o200k_base over the extracted text. Both sides use the same counter, so the");
  out.push("  ratio is meaningful even though DeepSeek's tokenizer differs by a few percent in absolute terms.");
  out.push("  the baseline is the cost of *having the document in context at all*; asked a yes/no question about");
  out.push("  a clause, a full read pays the entire price before it can answer.");
  out.push("  folio does not make answers better, only cheaper — and only for questions about words that appear");
  out.push("  in the text. A task that genuinely needs the whole document read still needs it read.");

  return out.join("\n");
}
