/**
 * Search: literal (or regex) matching over the page-tagged index.
 *
 * Deliberately dumb. No embeddings, no ranking model, no chunking. Multi-term
 * queries are AND over the same line, which is what makes "付款 违约金" narrow
 * instead of drift.
 */
import path from "node:path";
import { sectionAt } from "./outline.js";
import type { Store } from "./store.js";
import type { Hit, OutlineNode } from "./types.js";
import { evidence, requireEvidence } from "./evidence.js";

export interface SearchOptions {
  limit?: number;
  doc?: string;
  regex?: boolean;
  /** Wall-clock budget for the whole scan, in milliseconds. */
  timeoutMs?: number;
  after?: { doc: string; line: number };
}

export interface SearchResult {
  hits: Hit[];
  totalHits: number;
  docs: number;
  lines: number;
  terms: string[];
  ms: number;
  /** True when the scan stopped early because the budget ran out. */
  timedOut: boolean;
  warnings: string[];
  unavailable: number;
  matchedDocs: number;
  complete: boolean;
  resumeAfter?: { doc: string; line: number };
}

/** A regex is only ever run against this much of a line. */
const REGEX_LINE_CAP = 4_000;
const DEFAULT_BUDGET_MS = 2_000;

export async function searchDocs(
  store: Store,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
  const raw = query.trim();
  const terms = raw.split(/\s+/).filter(Boolean);

  const manifest = await store.load();
  const result: SearchResult = { hits: [], totalHits: 0, docs: 0, lines: 0, terms, ms: 0, timedOut: false,
    warnings: [], unavailable: 0, matchedDocs: 0, complete: true };

  if (terms.length === 0) return result;

  const started = Date.now();
  const budget = Math.max(50, options.timeoutMs ?? DEFAULT_BUDGET_MS);
  const outOfTime = (): boolean => Date.now() - started > budget;

  const filter = options.doc?.trim().toLowerCase() ?? "";
  const patterns = options.regex
    ? terms.map((t) => {
        // A pathological pattern can hang the whole server; the index lines are
        // short, so a long regex is a sign of a mistake, not of a real query.
        if (t.length > 200) throw new Error(`regex too long (${t.length} chars, max 200)`);
        try {
          return new RegExp(t, "i");
        } catch {
          return new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        }
      })
    : null;
  const needles = options.regex ? [] : terms.map((t) => t.toLowerCase());

  for (const entry of Object.values(manifest.docs).sort((a, b) => a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0)) {
    const doc = entry.doc;
    if (filter && !doc.toLowerCase().includes(filter)) continue;
    if (options.after && doc < options.after.doc) continue;
    result.matchedDocs++;
    result.resumeAfter ??= options.after ?? { doc, line: 0 };
    if (outOfTime()) {
      result.timedOut = true;
      break;
    }
    const checked = await evidence(store, entry);
    result.warnings.push(...checked.warnings.map((w) => `${doc} [${checked.status}]: ${w}`));
    if (checked.status !== "ready") {
      result.unavailable++;
      continue;
    }
    const lines = checked.text.split("\n");
    result.docs += 1;
    const outline: OutlineNode[] = manifest.docs[doc]?.outline ?? [];
    let unitIndex = -1;
    let lastLabel = "";
    let lineInUnit = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Checked in batches: a per-line Date.now() would cost more than the match.
      if ((i & 255) === 0 && outOfTime()) {
        result.timedOut = true;
        break;
      }
      if (!line) continue;
      result.lines += 1;

      const tab = line.indexOf("\t");
      const label = tab > 0 ? line.slice(0, tab) : "";
      const body = tab > 0 ? line.slice(tab + 1) : line;
      if (!body) continue;
      if (patterns && body.length > REGEX_LINE_CAP) {
        result.complete = false;
        const warning = `${doc}: regex only checked the first ${REGEX_LINE_CAP} characters of long lines; use literal search or read the source range`;
        if (!result.warnings.includes(warning)) result.warnings.push(warning);
      }
      // The index is written unit by unit, so the n-th label change is the
      // n-th unit — which is exactly how outline nodes address themselves.
      if (label !== lastLabel) {
        unitIndex += 1;
        lastLabel = label;
        lineInUnit = 0;
      }
      lineInUnit += 1;
      if (options.after?.doc === doc && i + 1 <= options.after.line) continue;
      result.resumeAfter = { doc, line: i + 1 };

      const matched = patterns
        ? patterns.every((re) => re.test(body.length > REGEX_LINE_CAP ? body.slice(0, REGEX_LINE_CAP) : body))
        : needles.every((n) => body.toLowerCase().includes(n));
      if (!matched) continue;

      result.totalHits += 1;
      if (result.hits.length < limit) {
        const hit: Hit = { doc, label, line: i + 1, lineInUnit, text: body, version: entry.revision };
        const section = sectionAt(outline, Math.max(unitIndex, 0), body, 3, lineInUnit);
        if (section) hit.section = section;
        result.hits.push(hit);
      }
    }
    if (result.timedOut) break;
  }

  result.ms = Date.now() - started;
  result.complete = result.complete && !result.timedOut && result.unavailable === 0;
  return result;
}

/** Read one unit (page/slide/sheet/block) of one document. */
export async function readUnit(
  store: Store,
  doc: string,
  label: string,
): Promise<{ doc: string; label: string; lines: string[]; totalUnits: number } | null> {
  const entry = (await store.load()).docs[doc];
  if (!entry) return null;
  const { text } = await requireEvidence(store, entry);
  const lines = text.split("\n");
  const bare = /^(p\.|¶|sl\.|sh\.)/.test(label) ? null : label;
  const candidates = bare ? ["p.", "¶", "sl.", "sh."].map((prefix) => `${prefix}${bare}`) : [label];

  for (const candidate of candidates) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const unitLabel = line.slice(0, tab);
      seen.add(unitLabel);
      if (unitLabel === candidate) out.push(line.slice(tab + 1));
    }
    if (out.length) return { doc, label: candidate, lines: out, totalUnits: seen.size };
  }
  return null;
}

/** Resolve a partial document name to a real one (so the model can write "合同A"). */
export async function resolveDoc(store: Store, doc: string): Promise<string | null> {
  const manifest = await store.load();
  const names = Object.keys(manifest.docs);
  const exact = names.find((n) => n === doc);
  if (exact) return exact;
  const lower = doc.toLowerCase();
  const partial = names.filter((n) => n.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  const stem = names.filter((n) => path.parse(n).name.toLowerCase() === lower);
  if (stem.length === 1) return stem[0];
  return null;
}
