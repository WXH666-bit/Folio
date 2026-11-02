/**
 * Output formatting.
 *
 * Everything the tool returns is meant to be read by a model and quoted back to
 * a human, so: no JSON, one hit per line, `doc:page` as the citation, and the
 * cheapest possible header. Token count is a feature, not an accident.
 */
import type { SearchResult } from "./search.js";
import type { ApplyResult, Revision } from "./revisions.js";
import type { DocEntry, Manifest } from "./types.js";

function k(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function unitWord(entry: DocEntry, n: number): string {
  switch (entry.unitKind) {
    case "page":
      return `${n}p`;
    case "slide":
      return `${n} sl`;
    case "sheet":
      return `${n} sh`;
    default:
      return `${n} blk`;
  }
}

export function docLine(entry: DocEntry): string {
  const parts = [entry.doc, entry.kind];
  if (entry.units > 0) parts.push(unitWord(entry, entry.units));
  if (entry.tables.length) {
    const shown = entry.tables.slice(0, 6).join(",");
    parts.push(`tables ${shown}${entry.tables.length > 6 ? ",…" : ""}`);
  }
  if (entry.outline.length) parts.push(`${entry.outline.length} sec`);
  if (entry.units === 0) parts.push("NOT INDEXED");
  parts.push(`${k(entry.chars)} chars`);
  return parts.join(" · ");
}

export function formatList(manifest: Manifest): string {
  const entries = Object.values(manifest.docs).sort((a, b) => a.doc.localeCompare(b.doc));
  if (entries.length === 0) {
    return "0 docs indexed — start `folio start` in the folder that holds the documents, or `folio index` once.";
  }
  const totals = entries.reduce(
    (acc, e) => {
      acc.units += e.units;
      acc.lines += e.lines;
      acc.chars += e.chars;
      return acc;
    },
    { units: 0, lines: 0, chars: 0 },
  );
  const header = `${entries.length} docs · ${totals.units} units · ${k(totals.lines)} lines · ${k(totals.chars)} chars`;
  // Warnings live on their own lines at the end: one occurrence, not one per hit.
  const warnings = entries
    .filter((e) => e.warnings.length > 0)
    .map((e) => `! ${e.doc}: ${e.warnings[0]}`);
  return [header, ...entries.map(docLine), ...warnings].join("\n");
}

export function formatSearch(query: string, result: SearchResult): string {
  if (result.terms.length === 0) return 'empty query — pass some words, e.g. "付款 违约"';
  if (result.totalHits === 0) {
    const scope = result.docs > 0 ? `${result.docs} docs / ${k(result.lines)} lines searched` : "nothing indexed yet";
    return [`${result.complete ? "no hits" : "incomplete search; no matches observed"} for "${query}" (${scope})`,
      result.timedOut ? `(scan stopped after ${result.ms}ms — search incomplete)` : "",
      ...result.warnings.map((w) => `! ${w}`)].filter(Boolean).join("\n");
  }
  const header = `${result.totalHits} hits · ${result.docs} docs / ${k(result.lines)} lines`;
  const lines: string[] = [];
  // Print the section only when it changes: a hit line stays one-hit-per-line,
  // and the reader gets a free table of contents.
  let lastSection = "";
  for (const h of result.hits) {
    const section = h.section ?? "";
    if (section && section !== lastSection) {
      lines.push(`  [${section}]`);
      lastSection = section;
    }
    lines.push(`${h.doc}:${h.label}${h.lineInUnit ? `:L${h.lineInUnit}` : ""}  ${collapse(h.text.trim())}${h.version ? ` [version=${h.version}]` : ""}`);
  }
  const shown = result.hits.length;
  const footer =
    result.totalHits > shown
      ? `…${result.totalHits - shown} more — add a word, or pass doc:"<name>" / regex:false`
      : null;
  // A partial scan must say so: otherwise "no more hits" is a lie the reader
  // cannot detect from the output alone.
  const cut = result.timedOut ? `(scan stopped after ${result.ms}ms — narrow the query)` : null;
  return [header, ...lines, footer, cut, ...result.warnings.map((w) => `! ${w}`)].filter(Boolean).join("\n");
}

/** Render the outline: one heading per line, indented by level. */
export function formatOutline(entry: DocEntry, options: { limit?: number } = {}): string {
  const limit = Math.min(options.limit ?? 120, 300);
  const head = `${entry.doc} · ${entry.outline.length} sections${entry.outline.length ? " · verbatim headings with their unit" : ""}`;
  if (entry.outline.length === 0) {
    return `${head}\n(no headings found — the document has no bookmarks and no 第X条 / 12.1 style headings)`;
  }
  const rows = entry.outline.slice(0, limit).map((n) => {
    const indent = "  ".repeat(Math.max(0, n.level - 1));
    return `${indent}${n.label}  ${n.title}`;
  });
  const more = entry.outline.length > limit ? [`…${entry.outline.length - limit} more`] : [];
  return [head, ...rows, ...more].join("\n");
}

export function formatPage(
  doc: string,
  label: string,
  lines: string[],
  totalUnits: number,
  section?: string,
): string {
  const unitNo = label.replace(/^[p¶]+\.?/, "");
  const head = `${doc}:${label}${totalUnits > 1 ? ` · unit ${unitNo} of ${totalUnits}` : ""}${section ? ` · ${section}` : ""}`;
  return [head, ...lines.map((l) => l.trimEnd())].join("\n");
}

/** Collapse runs of spaces in a hit so a table row doesn't blow up the line. */
function collapse(text: string): string {
  return text.replace(/ {2,}/g, "  ");
}

function clip(text: string, max = 70): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The proposal list. Nothing here has touched a file yet. */
export function formatRevisions(revisions: Revision[], doc?: string): string {
  if (revisions.length === 0) {
    return doc
      ? `no revisions proposed for "${doc}" — edit nothing, propose with folio_revise`
      : "no revisions proposed yet";
  }
  const pending = revisions.filter((r) => r.status === "pending").length;
  const head = `${revisions.length} revisions · ${pending} pending${doc ? ` · ${doc}` : ""}`;
  const rows = revisions.map((r) => {
    const mark = r.status === "pending" ? "·" : r.status === "applied" ? "✓" : r.status === "discarded" ? "× discarded" : "!";
    const arrow =
      r.action === "insert_after"
        ? `+after: ${clip(r.text)}`
        : r.action === "delete"
          ? `- "${clip(r.before)}" (delete)`
          : `- "${clip(r.before)}" + "${clip(r.text)}"`;
    return `${mark} ${r.id} ${r.doc}:${r.target}  ${arrow}${r.reason ? `  — ${r.reason}` : ""}`;
  });
  return [head, ...rows].join("\n");
}

export function formatApply(result: ApplyResult): string {
  const parts: string[] = [];
  if (result.applied.length > 0) {
    parts.push(`applied ${result.applied.join(",")} to ${result.doc}`);
    if (result.backup) parts.push(`backup ${result.backup}`);
  }
  if (result.applied.length === 0) parts.push(`nothing applied to ${result.doc}`);
  for (const c of result.conflicts) parts.push(`conflict ${c.id}: ${c.why}`);
  if (result.skipped.length > 0) parts.push(`already settled: ${result.skipped.join(",")}`);
  if (result.indexWarning) parts.push(`! file written but the index did not refresh: ${result.indexWarning} — run folio index --force`);
  return parts.join("\n");
}
