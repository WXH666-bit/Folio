import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { Store } from "./store.js";
import type { DocEntry } from "./types.js";

export const INDEX_VERSION = 2;
export const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export async function sourceHash(file: string): Promise<string> {
  return digest(await fs.readFile(file));
}

export interface Evidence {
  status: "ready" | "stale_index" | "source_missing" | "parse_failed" | "no_text" | "index_unavailable";
  warnings: string[];
  text: string;
}

/** Validate bytes, not just timestamps: same-size edits and restored mtimes count. */
export async function evidence(store: Store, entry: DocEntry): Promise<Evidence> {
  const fail = (status: Evidence["status"], message: string): Evidence => ({ status, warnings: [message], text: "" });
  if (entry.indexVersion !== INDEX_VERSION || !entry.contentHash || !entry.indexHash || !entry.revision) {
    return fail("stale_index", "legacy index; run folio index to rebuild before citing or editing");
  }
  let current: string;
  try { current = await sourceHash(entry.sourcePath); }
  catch { return fail("source_missing", "source is missing or unreadable; no evidence returned"); }
  if (current !== entry.contentHash) return fail("stale_index", "source changed; run folio index and locate the text again");
  let text: string;
  try { text = await fs.readFile(store.indexFile(entry.doc), "utf8"); }
  catch { return fail("index_unavailable", "index is missing or unreadable; run folio index --force"); }
  if (digest(text) !== entry.indexHash) return fail("stale_index", "index changed or is incomplete; reindex and retry");
  if (entry.warnings.some((w) => w.startsWith("parse failed:"))) return fail("parse_failed", entry.warnings.join("; "));
  if (entry.chars === 0) return fail("no_text", entry.kind === "pdf"
    ? "no extracted text; possible scan requiring OCR. This tool did not perform OCR. Other documents are not evidence for this file."
    : "no extracted text; this is not a successful search with zero matches");
  return { status: "ready", warnings: entry.warnings, text };
}

export async function requireEvidence(store: Store, entry: DocEntry, version?: string): Promise<Evidence> {
  if (version !== undefined && version !== entry.revision) throw new Error("stale_reference: document version changed; read again and use its current version");
  const result = await evidence(store, entry);
  if (result.status !== "ready") throw new Error(`${result.status}: ${result.warnings.join("; ")}`);
  return result;
}

export interface IndexLine { label: string; line: number; unit: number; text: string; }
export function indexLines(text: string): IndexLine[] {
  let last = "", unit = -1, line = 0;
  return text.split("\n").filter(Boolean).map((raw) => {
    const tab = raw.indexOf("\t");
    const label = raw.slice(0, tab);
    if (label !== last) { last = label; unit++; line = 0; }
    return { label, line: ++line, unit, text: raw.slice(tab + 1) };
  });
}
