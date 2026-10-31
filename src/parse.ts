/**
 * Parsers: turn a document into units of page-tagged plain text.
 *
 * Design rule: never summarize, never drop. The output is a lossless-as-possible
 * transcription of what is on the page, plus the label that says which page.
 * Everything lossy happens later, at query time.
 */
import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import { flattenBookmarks } from "./outline.js";
import type { DocKind, OutlineNode, ParsedDoc, Unit } from "./types.js";
import { parsePptx, parseXlsx } from "./parse-office.js";

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const WORD = /[A-Za-z0-9\u00c0-\u024f]/;

export function detectKind(file: string): DocKind | null {
  switch (path.extname(file).toLowerCase()) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".pptx":
      return "pptx";
    case ".xlsx":
      return "xlsx";
    case ".html":
    case ".htm":
      return "html";
    case ".txt":
    case ".md":
    case ".csv":
    case ".log":
      return "text";
    default:
      return null;
  }
}

export async function parseFile(file: string, kind: DocKind): Promise<ParsedDoc> {
  if (kind === "pdf") return parsePdf(file);
  if (kind === "docx") return parseDocx(file);
  if (kind === "pptx") return parsePptx(file);
  if (kind === "xlsx") return parseXlsx(file);
  if (kind === "html") return parseHtml(file);
  return parseText(file);
}

/**
 * A unit is "probably a table" if it has column gaps (three spaces or more,
 * produced by joinRow when a run starts far from the previous one). Cheap
 * heuristic, but enough to tell a model "table is on p.7" without reading it.
 */
function looksTabular(lines: string[]): boolean {
  let wide = 0;
  for (const line of lines) {
    const gaps = (line.match(/ {3,}/g) ?? []).length;
    if (gaps >= 2) return true;
    if (gaps === 1) wide += 1;
  }
  return wide >= 2;
}

export function tablesOf(units: Unit[]): string[] {
  return units.filter((u) => looksTabular(u.lines)).map((u) => u.label);
}

/* ------------------------------------------------------------------ PDF --- */

interface Run {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function collectRuns(items: unknown[]): Run[] {
  const runs: Run[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const it = raw as {
      str?: unknown;
      transform?: unknown;
      width?: unknown;
      height?: unknown;
    };
    if (typeof it.str !== "string" || it.str.length === 0) continue;
    const tr = it.transform;
    if (!Array.isArray(tr) || tr.length < 6) continue;
    const x = Number(tr[4]);
    const y = Number(tr[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const h = Math.abs(Number(tr[3])) || Number(it.height) || 10;
    const w = Number(it.width) || 0;
    // PDFs that simulate bold by drawing the same run twice produce duplicates.
    const key = `${it.str}\u0000${Math.round(x)}\u0000${Math.round(y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runs.push({ str: it.str, x, y, w, h });
  }
  return runs;
}

function needsSpace(prev: string, next: string): boolean {
  if (!prev || !next) return false;
  if (WORD.test(prev) && WORD.test(next)) return true;
  return false;
}

/**
 * Rebuild one visual row.
 *
 * Whitespace runs are not emitted as text: their *width* is the gap between the
 * neighbouring words, and that width is the only signal that tells a table
 * column from a space. (PyMuPDF and Word both pad cells with wide space runs,
 * so a naive "skip spaces" rule turns a four-column table into one glued word.)
 */
function joinRow(row: Run[]): string {
  row.sort((a, b) => a.x - b.x);
  let out = "";
  let prevEnd: number | null = null;
  let height = 10;
  for (const r of row) {
    if (!r.str.trim()) continue;
    height = Math.max(height, r.h);
    const str = r.str.replace(/[\u00a0\s]+/g, " ");
    if (prevEnd !== null) {
      const gap = r.x - prevEnd;
      const avg = r.str.length > 0 && r.w > 0 ? r.w / r.str.length : height * 0.5;
      if (gap >= Math.max(20, height * 2)) out += "   "; // column break
      else if (gap > Math.max(1, avg * 0.25)) out += " ";
      else if (needsSpace(out.slice(-1), str[0])) out += " ";
    }
    out += str;
    prevEnd = r.x + r.w;
  }
  return out.replace(/\s+$/, "");
}

/**
 * Rebuild reading order from positioned runs: cluster by baseline into rows,
 * then order each row by x. This is the smallest thing that qualifies as
 * "layout restoration" — it is what makes a table row come out as one line
 * instead of one letter per line.
 */
function groupRows(runs: Run[]): string[] {
  if (runs.length === 0) return [];
  const heights = runs.map((r) => r.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 10;
  const tol = Math.max(1.5, median * 0.45);

  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Run[][] = [];
  let rowY = Number.NaN;
  for (const r of sorted) {
    if (rows.length === 0 || Math.abs(rowY - r.y) > tol) {
      rows.push([r]);
      rowY = r.y;
    } else {
      rows[rows.length - 1].push(r);
    }
  }
  return rows.map(joinRow).filter((s) => s.trim().length > 0);
}

export async function parsePdf(file: string): Promise<ParsedDoc> {
  const warnings: string[] = [];
  const bytes = new Uint8Array(await fs.readFile(file));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const task = pdfjs.getDocument({
    data: bytes,
    verbosity: 0,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  const doc = await task.promise;

  const units: Unit[] = [];
  let chars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = groupRows(collectRuns(content.items));
    for (const r of rows) chars += r.length;
    units.push({ label: `p.${p}`, lines: rows });
    page.cleanup();
  }
  const pageCount = doc.numPages;
  // Bookmarks, when the author made them, are the best outline available.
  const bookmarks = await readBookmarks(doc);
  // pdfjs v6 dropped PDFDocumentProxy.destroy(); the loading task owns teardown.
  await task.destroy().catch(() => undefined);

  if (chars < pageCount * 30) {
    warnings.push("text layer is almost empty — likely a scan, needs OCR (not in this version)");
  }
  return { kind: "pdf", units, unitKind: "page", tables: tablesOf(units), bookmarks, warnings };
}

/**
 * Read the PDF bookmark tree, resolving each destination to a page number.
 * Any bookmark whose destination cannot be resolved is simply dropped: a
 * partial map is still useful, a wrong page number is not.
 */
async function readBookmarks(doc: {
  getOutline: () => Promise<unknown[] | null>;
  getDestination: (name: string) => Promise<unknown>;
  getPageIndex: (ref: unknown) => Promise<number>;
}): Promise<OutlineNode[]> {
  let raw: unknown[] | null = null;
  try {
    raw = await doc.getOutline();
  } catch {
    return [];
  }
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const pageByItem = new Map<unknown, number>();
  async function resolve(items: unknown[]): Promise<void> {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const entry = item as { dest?: unknown; items?: unknown };
      const dest = entry.dest;
      if (dest !== undefined && dest !== null) {
        try {
          const target = typeof dest === "string" ? await doc.getDestination(dest) : dest;
          const ref = Array.isArray(target) ? target[0] : null;
          if (ref !== null && ref !== undefined) {
            pageByItem.set(item, (await doc.getPageIndex(ref)) + 1);
          }
        } catch {
          // Unresolvable destination — skip this node, keep the rest.
        }
      }
      if (Array.isArray(entry.items) && entry.items.length > 0) await resolve(entry.items);
    }
  }
  await resolve(raw);

  return flattenBookmarks(raw, (item) => pageByItem.get(item) ?? null).slice(0, 500);
}

/* ----------------------------------------------------------------- DOCX --- */

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function htmlToBlocks(html: string): string[] {
  // Keep table cells apart so a row does not collapse into one long word.
  const prepared = html.replace(/<\/t[dh]>/gi, "   ");
  const blocks: string[] = [];
  const re = /<(p|h[1-6]|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prepared)) !== null) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (text) blocks.push(text);
  }
  return blocks;
}

export async function parseDocx(file: string): Promise<ParsedDoc> {
  const warnings: string[] = [];
  const result = await mammoth.convertToHtml({ path: file });
  for (const msg of result.messages) {
    if (msg.type === "error" || msg.type === "warning") warnings.push(String(msg.message));
  }
  const blocks = htmlToBlocks(result.value);
  const units: Unit[] = blocks.map((text, i) => ({ label: `¶${i + 1}`, lines: [text] }));
  warnings.push("no fixed pages — ¶N is a block index, not a page number");
  return { kind: "docx", units, unitKind: "block", tables: tablesOf(units), warnings };
}

/* ----------------------------------------------------------------- TEXT --- */

export async function parseText(file: string): Promise<ParsedDoc> {
  const raw = await fs.readFile(file, "utf8");
  const lines = raw.split(/\r?\n/);
  const units: Unit[] = [];
  lines.forEach((line, i) => {
    const text = line.replace(/\s+/g, " ").trimEnd();
    if (text.trim()) units.push({ label: `¶${i + 1}`, lines: [text] });
  });
  return { kind: "text", units, unitKind: "block", tables: tablesOf(units), warnings: [] };
}

/* ----------------------------------------------------------------- HTML --- */

/**
 * HTML: paragraphs become lines, one block per line. Structural containers are
 * rewritten to <p> first so that a table row or a <div>-only page still yields
 * text instead of being silently dropped by the block pattern.
 */
export async function parseHtml(file: string): Promise<ParsedDoc> {
  const raw = await fs.readFile(file, "utf8");
  const body = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(\/?)(tr|div|section|article|blockquote|pre|figure)\b[^>]*>/gi, "<$1p>");
  const blocks = htmlToBlocks(body);
  const units: Unit[] = blocks.map((text, i) => ({ label: `¶${i + 1}`, lines: [text] }));
  return {
    kind: "html",
    units,
    unitKind: "block",
    tables: tablesOf(units),
    warnings: blocks.length ? [] : ["no readable text in html"],
  };
}

/* ----------------------------------------------------------------- MISC --- */

export function unitsToIndexText(units: Unit[]): { text: string; lines: number; chars: number } {
  const out: string[] = [];
  let chars = 0;
  for (const unit of units) {
    for (const line of unit.lines) {
      if (!line.trim()) continue;
      out.push(`${unit.label}\t${line}`);
      chars += line.length;
    }
  }
  return { text: out.join("\n") + (out.length ? "\n" : ""), lines: out.length, chars };
}
