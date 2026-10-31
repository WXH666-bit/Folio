/** Bounded, versioned retrieval shared by MCP and CLI. Cursors hold positions, never source text. */
import { countTokens } from "gpt-tokenizer";
import { digest, evidence, indexLines, type IndexLine } from "./evidence.js";
import { parseTarget } from "./revisions.js";
import { searchDocs } from "./search.js";
import type { Store } from "./store.js";

export function tokenBudget(value: unknown, fallback = 2000): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 512 || value > 16000) {
    throw new Error("maxTokens must be an integer from 512 to 16000 (o200k_base estimate, includes metadata)");
  }
  return value;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`expected integer ${min}..${max}`);
  return value;
}
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length > 4096 || !/^[\w-]+$/.test(value)) throw new Error("invalid cursor");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new Error("invalid cursor"); }
}
function bounded(text: string, budget: number): string {
  if (countTokens(text) <= budget) return text;
  throw new Error("output metadata exceeds maxTokens; increase the budget or narrow the document scope");
}
function warnings(values: string[]): string {
  if (!values.length) return "";
  // The count is never hidden. Re-read a scoped document for its complete warning list.
  return `warnings=${values.length}\n` + values.slice(0, 3).map((v) => `! ${v.slice(0, 350)}`).join("\n") +
    (values.length > 3 ? "\n! More document warnings: narrow doc to inspect; this result is not evidence for unreadable files." : "");
}
function prefix(text: string, length: number): string {
  // A cursor offset must never split a surrogate pair.
  if (length > 0 && /[\uD800-\uDBFF]/.test(text[length - 1])) length--;
  return text.slice(0, length);
}

export async function retrieveSearch(store: Store, args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return "empty query — pass words to search";
  const budget = tokenBudget(args.maxTokens);
  const limit = integer(args.limit, 20, 1, 200);
  const doc = args.doc === undefined ? undefined : String(args.doc);
  const regex = args.regex === true;
  const manifest = await store.load();
  const entries = Object.values(manifest.docs).filter((e) => !doc || e.doc.toLowerCase().includes(doc.toLowerCase()))
    .sort((a, b) => a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0);
  const scope = digest(JSON.stringify([query, doc ?? "", regex, entries.map((e) => [e.doc, e.revision])])).slice(0, 16);
  let after: { doc: string; line: number } | undefined;
  if (args.cursor !== undefined) {
    const c = decode(args.cursor);
    if (c.k !== "s" || c.s !== scope) throw new Error("stale_cursor: query, scope or document version changed; search again without cursor");
    if (typeof c.d !== "string" || !entries.some((e) => e.doc === c.d)) throw new Error("invalid cursor document");
    after = { doc: c.d, line: integer(c.l, -1, 0, Number.MAX_SAFE_INTEGER) };
    if (after.line < 0) throw new Error("invalid cursor position");
  }
  const result = await searchDocs(store, query, { limit, doc, regex, after,
    timeoutMs: args.timeoutMs === undefined ? undefined : integer(args.timeoutMs, 2000, 1, 30000) });
  if (args.cursor && result.unavailable) throw new Error("stale_cursor: source or index unavailable; reindex and restart the search");
  const notes = warnings(result.warnings);
  const header = `status=${result.complete ? (result.totalHits ? "ready" : "no_match") : "incomplete"} | ${result.totalHits}${result.timedOut ? "+" : ""} hits | ${result.docs} docs searched`;
  const cursorFor = (d: string, l: number) => encode({ k: "s", s: scope, d, l });
  const rows: string[] = [];
  let selected = 0;
  const footer = (n: number): string => {
    const last = result.hits[n - 1];
    const more = result.totalHits > n;
    const at = more && last ? { doc: last.doc, line: last.line } : result.timedOut ? result.resumeAfter ?? after : undefined;
    const next = at ? `next_cursor=${cursorFor(at.doc, at.line)}\nContinue folio_search with the same query/doc/regex and cursor.` : "";
    return [result.timedOut ? "scan incomplete: time budget reached; observed count is a lower bound" : "",
      result.unavailable ? `${result.unavailable} document(s) unavailable; no_match does not apply to them` : "",
      !entries.length ? "no documents match this scope — call folio_list" : "", notes, next].filter(Boolean).join("\n");
  };
  const render = (items: string[], n: number) => [header, ...items, footer(n)].filter(Boolean).join("\n");
  for (const hit of result.hits) {
    const lead = `${hit.doc}:${hit.label}:L${hit.lineInUnit} [version=${hit.version}] `;
    const location = regex ? -1 : hit.text.toLowerCase().indexOf(query.split(/\s+/)[0].toLowerCase());
    const start = Math.max(0, location - 120);
    let excerpt = hit.text.slice(start, start + 600);
    const clipped = start > 0 || excerpt.length < hit.text.length;
    let row = lead + (start ? "…" : "") + excerpt + (clipped ? "… [excerpt; expand with folio_page target]" : "");
    if (countTokens(render([...rows, row], selected + 1)) > budget) {
      if (selected) break;
      // Even a single very long hit must be retrievable within the budget.
      while (excerpt.length > 1 && countTokens(render([row], 1)) > budget) {
        excerpt = prefix(excerpt, Math.floor(excerpt.length / 2));
        row = lead + (start ? "…" : "") + excerpt + "… [excerpt; expand with folio_page target]";
      }
    }
    bounded(render([...rows, row], selected + 1), budget);
    rows.push(row); selected++;
  }
  return bounded(render(rows, selected), budget);
}

function sectionRange(lines: IndexLine[], anchor: number, outline: { unit: number; line?: number; level: number }[]): [number, number] | null {
  const clause = (text: string) => /^(\d+(?:\.\d+)+)(?:\s|[、．])/u.exec(text.trim())?.[1];
  const boundary = (text: string) => /^(?:第[一二三四五六七八九十百\d]+[条章]|#{1,6}\s|[一二三四五六七八九十]+、)/u.test(text.trim());
  for (let i = anchor; i >= 0; i--) {
    const number = clause(lines[i].text);
    if (number) {
      const depth = number.split(".").length;
      let end = i + 1;
      while (end < lines.length) {
        const next = clause(lines[end].text);
        if (boundary(lines[end].text) || (next && next.split(".").length <= depth)) break;
        end++;
      }
      if (anchor < end) return [i, end];
      break;
    }
    if (boundary(lines[i].text)) break;
  }
  const markdown = lines.flatMap((l, at) => {
    const match = /^(#{1,6})\s+/.exec(l.text.trim());
    return match ? [{ unit: l.unit, line: l.line - 1, level: match[1].length, at }] : [];
  });
  const heads = [...markdown, ...outline.map((n) => ({ ...n, at: lines.findIndex((l) => l.unit === n.unit && l.line >= (n.line ?? 0) + 1) }))]
    .filter((n) => n.at >= 0).sort((a, b) => a.at - b.at);
  const head = heads.filter((h) => h.at <= anchor).at(-1);
  if (!head) return null;
  const next = heads.find((h) => h.at > head.at && h.level <= head.level);
  return [head.at, next?.at ?? lines.length];
}

export async function retrieveRead(store: Store, doc: string, args: Record<string, unknown>): Promise<string> {
  const budget = tokenBudget(args.maxTokens, 3000);
  const entry = (await store.load()).docs[doc];
  if (!entry) return bounded(`status=not_found | no document "${doc}" — call folio_list`, budget);
  if (args.version !== undefined && args.version !== entry.revision) return "status=stale_reference | document changed; read again without the old version and locate the text again";
  const checked = await evidence(store, entry);
  if (checked.status !== "ready") return bounded(`status=${checked.status} | ${doc}\n${warnings(checked.warnings)}`, budget);
  const all = indexLines(checked.text);
  let begin = 0, end = all.length, offset = 0, scope = "document", note = "";
  if (args.cursor !== undefined) {
    const c = decode(args.cursor);
    if (c.k !== "r" || c.d !== doc || c.v !== entry.revision) throw new Error("stale_cursor: document version changed; read again without cursor");
    begin = integer(c.b, -1, 0, all.length - 1);
    end = integer(c.e, -1, 1, all.length);
    if (begin < 0 || end <= begin) throw new Error("invalid cursor range");
    offset = integer(c.o, 0, 0, all[begin].text.length - 1);
    if (offset && /[\uDC00-\uDFFF]/.test(all[begin].text[offset])) throw new Error("invalid cursor character boundary");
    scope = "continuation";
  } else {
    const mode = String(args.mode ?? (args.page === undefined && args.target === undefined ? "document" : "page"));
    if (!["document", "page", "context", "section"].includes(mode)) throw new Error("mode must be document, page, context or section");
    scope = mode;
    if (mode !== "document") {
      const target = args.target === undefined ? null : parseTarget(String(args.target));
      if (args.target !== undefined && !target) throw new Error("invalid target; use p.12:L3 or ¶14:L1");
      const requested = target?.label ?? String(args.page ?? "");
      if (!requested) throw new Error("page or target is required for this mode");
      const candidates = /^(p\.|¶|sl\.|sh\.)/.test(requested) ? [requested] : ["p.", "¶", "sl.", "sh."].map((p) => p + requested);
      const anchor = all.findIndex((l) => candidates.includes(l.label) && l.line === (target?.line ?? integer(args.line, 1, 1, Number.MAX_SAFE_INTEGER)));
      if (anchor < 0) return bounded(`status=not_found | no ${requested}${target ? `:L${target.line}` : ""} in "${doc}"\n${warnings(checked.warnings)}`, budget);
      if (mode === "page") {
        begin = all.findIndex((l) => l.label === all[anchor].label);
        end = begin + all.filter((l) => l.label === all[anchor].label).length;
      } else if (mode === "section") {
        const range = sectionRange(all, anchor, entry.outline);
        if (range) [begin, end] = range;
        else { begin = Math.max(0, anchor - 2); end = Math.min(all.length, anchor + 3); note = "section_boundary_unknown: returning nearby lines, not a claimed complete clause"; }
      } else {
        begin = Math.max(0, anchor - integer(args.before, 2, 0, 100));
        end = Math.min(all.length, anchor + integer(args.after, 2, 0, 100) + 1);
      }
    }
  }
  const header = `${doc} [version=${entry.revision}] | scope=${scope}`;
  const notes = [note, warnings(checked.warnings)].filter(Boolean).join("\n");
  const footer = (at: number, off: number) => at < end
    ? `status=partial\nnext_cursor=${encode({ k: "r", d: doc, v: entry.revision, b: at, e: end, o: off })}\nContinue folio_page with doc and cursor; fragments are not complete lines.`
    : "status=complete (requested range only)";
  const render = (rows: string[], at: number, off: number) => [header, notes, ...rows, footer(at, off)].filter(Boolean).join("\n");
  const rows: string[] = [];
  let at = begin, off = offset;
  while (at < end) {
    const row = all[at];
    const remaining = row.text.slice(off);
    const lead = `${doc}:${row.label}:L${row.line}${off ? ` [char=${off}]` : ""}  `;
    if (countTokens(render([...rows, lead + remaining], at + 1, 0)) <= budget) {
      rows.push(lead + remaining); at++; off = 0; continue;
    }
    if (rows.length) break;
    let lo = 0, hi = remaining.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const part = prefix(remaining, mid);
      if (countTokens(render([lead + part + " [fragment]"], at, off + part.length)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    const part = prefix(remaining, lo);
    if (!part) throw new Error("maxTokens too small for document metadata; increase budget");
    rows.push(lead + part + " [fragment]"); off += part.length; break;
  }
  return bounded(render(rows, at, off), budget);
}
