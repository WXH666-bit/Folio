/**
 * Revisions: edits as a proposal list, not as a write.
 *
 * A document is evidence. The one thing this tool must never do is quietly
 * change it. So an edit is a record — "on p.12 line 3, this sentence should
 * become that one" — kept in its own file next to the index, and applied only
 * when someone asks twice: once to write it into the list (`folio_revise`),
 * once to commit the list (`folio_apply`).
 *
 * Plain text is written line by line and DOCX block by block — both from a
 * proposal list, both to a backup first. A PDF stays proposal-only: its text
 * layer is a layout artifact, so "editing" it would mean re-typesetting.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { indexOne, isInside } from "./indexer.js";
import { withLock } from "./lock.js";
import { sanitizeName, writeAtomic } from "./store.js";
import type { Store } from "./store.js";
import type { DocEntry } from "./types.js";
import { applyDocxBlocks, type BlockEdit } from "./write-docx.js";
import { digest, requireEvidence, sourceHash } from "./evidence.js";

export interface Revision {
  version?: string;
  contentHash?: string;
  id: string;
  doc: string;
  /** Unit label plus line within the unit, e.g. "p.12:L3" or "¶14:L1". */
  target: string;
  action: RevisionAction;
  /** What the line said when the proposal was made. Used to detect drift. */
  before: string;
  text: string;
  reason: string;
  status: "pending" | "applied" | "conflict";
  created: string;
  appliedAt?: string;
}

export interface ParsedTarget {
  label: string;
  line: number;
}

/** "p.12:L3" · "p12" · "¶14" · "sl.6:L1" · "sh.台账:L4" — the citation format we print. */
export function parseTarget(target: string): ParsedTarget | null {
  const m =
    /^\s*(?:(p)\.?\s*(\d+)|¶\s*(\d+)|(sl)\.\s*(\d+)|(sh)\.\s*([^:：\s]+?))\s*(?:[:：]\s*L\s*(\d+))?\s*$/i.exec(
      target,
    );
  if (!m) return null;
  let label: string;
  let unit: number;
  if (m[1]) {
    unit = Number(m[2]);
    label = `p.${unit}`;
  } else if (m[3]) {
    unit = Number(m[3]);
    label = `¶${unit}`;
  } else if (m[4]) {
    unit = Number(m[5]);
    label = `sl.${unit}`;
  } else {
    unit = 0;
    label = `sh.${m[7]}`;
  }
  const line = m[8] ? Number(m[8]) : 1;
  if (m[1] || m[3] || m[4]) {
    if (!Number.isFinite(unit) || unit < 1) return null;
  }
  if (!Number.isFinite(line) || line < 1) return null;
  return { label, line };
}

function revisionsDir(store: Store): string {
  return path.join(store.home, "revisions");
}

function revisionsFile(store: Store, doc: string): string {
  return path.join(revisionsDir(store), `${sanitizeName(doc)}.jsonl`);
}

/** Append-only log; the last line for an id wins, so status changes never rewrite history. */
async function readLog(file: string): Promise<Revision[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, Revision>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rev = JSON.parse(line) as Revision;
      if (rev.id) byId.set(rev.id, rev);
    } catch {
      // A torn last line (crash mid-write) is ignored, the rest still loads.
    }
  }
  return [...byId.values()];
}

async function append(file: string, rev: Revision): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(rev)}\n`, "utf8");
}

export async function listRevisions(store: Store, doc?: string): Promise<Revision[]> {
  let files: string[];
  if (doc) {
    files = [revisionsFile(store, doc)];
  } else {
    try {
      files = (await fs.readdir(revisionsDir(store))).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(revisionsDir(store), f));
    } catch {
      return [];
    }
  }
  const all: Revision[] = [];
  for (const file of files) all.push(...(await readLog(file)));
  return all.sort((a, b) => (a.doc === b.doc ? a.id.localeCompare(b.id, undefined, { numeric: true }) : a.doc.localeCompare(b.doc)));
}

/** The text of one line of the index, which is what a revision points at. */
export async function readIndexLine(
  store: Store,
  doc: string,
  target: ParsedTarget,
): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(store.indexFile(doc), "utf8");
  } catch {
    return null;
  }
  let seen = 0;
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    if (line.slice(0, tab) !== target.label) continue;
    seen += 1;
    if (seen === target.line) return line.slice(tab + 1);
  }
  return null;
}

export type RevisionAction = "replace" | "insert_after" | "delete";

export async function addRevision(
  store: Store,
  input: {
    doc: string;
    target: string;
    action?: RevisionAction;
    text?: string;
    reason?: string;
    version?: string;
  },
): Promise<Revision> {
  return withLock(store.home, "index", () => addRevisionUnlocked(store, input));
}

async function addRevisionUnlocked(store: Store, input: {
  doc: string; target: string; action?: RevisionAction; text?: string; reason?: string; version?: string;
}): Promise<Revision> {
  const action = input.action ?? "replace";
  const text = action === "delete" ? "" : (input.text ?? "").trim();
  if (action !== "delete" && !text) {
    throw new Error("a replace/insert revision needs `text` — what should the line say instead?");
  }
  const parsed = parseTarget(input.target);
  if (!parsed) {
    throw new Error(`bad target "${input.target}" — use the citation form the tools print, e.g. p.12:L3 or ¶14`);
  }
  const manifest = await store.load();
  const entry = manifest.docs[input.doc];
  if (!entry) throw new Error(`no document "${input.doc}" — call folio_list`);
  await requireEvidence(store, entry, input.version);
  if (action === "delete" && entry.unitKind !== "block") {
    throw new Error(
      `delete is only supported for plain-text documents — "${entry.doc}" is a ${entry.kind} file (${entry.unitKind} units)`,
    );
  }

  const before = await readIndexLine(store, input.doc, parsed);
  if (before === null) {
    throw new Error(`no line ${parsed.label}:L${parsed.line} in "${input.doc}"`);
  }
  const existing = await listRevisions(store, input.doc);
  const nextNumber =
    existing.reduce((max, r) => Math.max(max, Number(r.id.replace(/^r/, "")) || 0), 0) + 1;
  const revision: Revision = {
    id: `r${nextNumber}`,
    doc: input.doc,
    target: `${parsed.label}:L${parsed.line}`,
    action,
    before,
    text,
    reason: input.reason ?? "",
    status: "pending",
    created: new Date().toISOString(),
    version: entry.revision,
    contentHash: entry.contentHash,
  };
  await append(revisionsFile(store, input.doc), revision);
  return revision;
}

export interface ApplyResult {
  doc: string;
  applied: string[];
  conflicts: { id: string; why: string }[];
  skipped: string[];
  backup: string | null;
  /** Set when the file was written but reindexing failed — the index is stale. */
  indexWarning?: string;
}

async function backupFile(store: Store, doc: string): Promise<string> {
  const dir = path.join(store.home, "backup");
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${sanitizeName(doc)}.${stamp}.bak`);
}

/** Line-level replace for plain text: read whole, edit, write whole. */
async function writeTextFile(
  store: Store,
  entry: DocEntry,
  chosen: Revision[],
  result: ApplyResult,
): Promise<void> {
  const original = await fs.readFile(entry.sourcePath, "utf8");
  if (chosen.some((rev) => rev.contentHash !== digest(original))) {
    result.conflicts.push(...chosen.map((rev) => ({ id: rev.id, why: "source changed before write — read and propose again" })));
    return;
  }
  const lines = original.split("\n");
  const before = [...lines];

  // Positions are relative to the proposal's version. Work backwards so an
  // insertion/deletion cannot shift a later edit to another source line.
  const used = new Set<string>();
  for (const rev of [...chosen].sort((a, b) => Number(parseTarget(b.target)?.label.slice(1)) - Number(parseTarget(a.target)?.label.slice(1)))) {
    if (used.has(rev.target)) {
      result.conflicts.push({ id: rev.id, why: "multiple edits target the same line; propose one combined change" });
      continue;
    }
    used.add(rev.target);
    const parsed = parseTarget(rev.target);
    if (!parsed) {
      result.conflicts.push({ id: rev.id, why: `unreadable target ${rev.target}` });
      continue;
    }
    // ¶N is the N-th physical line for text files (see parseText).
    const index = Number(parsed.label.replace(/^[p¶]+\.?/, "")) - 1;
    const current = lines[index];
    if (current === undefined) {
      result.conflicts.push({ id: rev.id, why: `${rev.target} no longer exists` });
      continue;
    }
    if (current.replace(/\s+/g, " ").trim() !== rev.before.trim()) {
      result.conflicts.push({
        id: rev.id,
        why: "the line changed after this revision was proposed — re-read the file and propose again",
      });
      continue;
    }
    if (rev.action === "delete") lines.splice(index, 1);
    else if (rev.action === "insert_after") lines.splice(index + 1, 0, rev.text);
    else lines[index] = rev.text;
    result.applied.push(rev.id);
  }

  if (result.applied.length === 0) return;
  if (await sourceHash(entry.sourcePath) !== digest(original)) {
    result.conflicts.push(...result.applied.map((id) => ({ id, why: "source changed during edit — read and propose again" })));
    result.applied = [];
    return;
  }
  const backup = await backupFile(store, entry.doc);
  await writeAtomic(backup, before.join("\n"));
  await writeAtomic(entry.sourcePath, lines.join("\n"));
  result.backup = backup;
}

/** Block-level replace for docx: wording changes, layout does not. */
async function writeDocxFile(
  store: Store,
  entry: DocEntry,
  chosen: Revision[],
  result: ApplyResult,
): Promise<void> {
  const edits: BlockEdit[] = [];
  for (const rev of chosen) {
    if (rev.action !== "replace") {
      result.conflicts.push({
        id: rev.id,
        why: `${rev.action} is not supported for docx — a new or removed paragraph needs Word's numbering and style context; change the wording instead`,
      });
      continue;
    }
    edits.push({ id: rev.id, before: rev.before, text: rev.text });
  }
  if (edits.length === 0) return;

  const backup = await backupFile(store, entry.doc);
  await fs.copyFile(entry.sourcePath, backup);
  const outcome = await applyDocxBlocks(entry.sourcePath, edits, chosen[0].contentHash);
  result.applied.push(...outcome.applied);
  result.conflicts.push(...outcome.conflicts);
  if (outcome.applied.length > 0) result.backup = backup;
  else await fs.rm(backup, { force: true });
}

/**
 * Commit pending revisions.
 *
 * Refusals, all deliberate: a PDF (no editable line model), a file outside the
 * indexed folder, or a line that changed since the proposal was written.
 */
export async function applyRevisions(
  store: Store,
  docArg: string,
  ids?: string[],
): Promise<ApplyResult> {
  return withLock(store.home, "index", () => applyRevisionsUnlocked(store, docArg, ids));
}

async function applyRevisionsUnlocked(store: Store, docArg: string, ids?: string[]): Promise<ApplyResult> {
  const manifest = await store.load();
  const entry = manifest.docs[docArg];
  if (!entry) throw new Error(`no document "${docArg}" — call folio_list`);
  if (entry.kind === "pdf") {
    throw new Error(
      `${docArg} is a pdf — its text layer is a layout artifact, so a rewrite would drop the layout. Use folio_revise and hand the list to a human.`,
    );
  }
  if (!isInside(entry.sourcePath, store.root)) {
    throw new Error(`${entry.sourcePath} is outside ${store.root} — refusing to write`);
  }

  const wanted = await listRevisions(store, docArg);
  const chosen = wanted.filter(
    (r) => r.status === "pending" && (ids === undefined || ids.length === 0 || ids.includes(r.id)),
  );
  const result: ApplyResult = { doc: docArg, applied: [], conflicts: [], skipped: [], backup: null };
  // Already-committed revisions are reported even when there is nothing left to
  // do: "nothing happened" and "nothing to do because it is already applied"
  // are different answers, and callers cannot tell them apart otherwise.
  result.skipped = wanted.filter((r) => r.status !== "pending").map((r) => r.id);
  if (chosen.length === 0) return result;

  // One writer at a time across processes: otherwise the watcher reindexes the
  // file while it is still half-written, and two manifest saves interleave.
  await withLock(store.home, "index", async () => {
    const currentHash = await sourceHash(entry.sourcePath);
    const valid = chosen.filter((rev) => {
      if (rev.contentHash && rev.version && rev.contentHash === currentHash && rev.version === entry.revision) return true;
      result.conflicts.push({ id: rev.id, why: "document version changed or proposal is unversioned — read again and propose a new revision" });
      return false;
    });
    if (entry.kind === "docx") { if (valid.length) await writeDocxFile(store, entry, valid, result); }
    else if (entry.kind === "text") { if (valid.length) await writeTextFile(store, entry, valid, result); }
    else {
      // pptx / xlsx are zip containers and html's index is extracted text: in all
      // three the index line numbers do not map back onto source lines, so writing
      // "the line at ¶7" would slice the file at the wrong place.
      throw new Error(
        `${docArg} is a ${entry.kind} — the index is extracted text, not source lines, so a rewrite would corrupt the file. Revise it and hand the list to a human.`,
      );
    }

    if (result.applied.length === 0 && result.conflicts.length === 0) return;

    if (result.applied.length > 0) {
      // The file on disk just changed, so the index must follow immediately:
      // otherwise the next search quotes text that is no longer there.
      try {
        await indexOne(store, entry.sourcePath, store.root);
      } catch (err) {
        result.indexWarning = err instanceof Error ? err.message : String(err);
      }
    }

    const now = new Date().toISOString();
    for (const rev of chosen) {
      if (result.applied.includes(rev.id)) {
        await append(revisionsFile(store, docArg), { ...rev, status: "applied", appliedAt: now });
      } else if (result.conflicts.some((c) => c.id === rev.id)) {
        // Recorded, not dropped: otherwise the same stale revision is re-reported
        // on every apply, which looks like a bug rather than a decision.
        await append(revisionsFile(store, docArg), { ...rev, status: "conflict", appliedAt: now });
      }
    }
  });

  return result;
}
