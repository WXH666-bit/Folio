/**
 * Indexer: walk the folder, parse what is parseable, write the index.
 *
 * Incremental by (size, mtime). A failed parse still produces a manifest entry,
 * so `folio_list` can say "this file did not parse" instead of silently showing
 * fewer documents than exist on disk.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { withLock } from "./lock.js";
import { extractOutline } from "./outline.js";
import { detectKind, parseFile } from "./parse.js";
import type { Store } from "./store.js";
import type { DocEntry } from "./types.js";
import { INDEX_VERSION, sourceHash } from "./evidence.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "vendor", "__pycache__"]);

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function docName(file: string, root: string): string {
  const rel = path.relative(root, file);
  return (rel && !rel.startsWith("..") ? rel : path.basename(file)).split(path.sep).join("/");
}

export async function walkFiles(root: string, home: string): Promise<string[]> {
  const out: string[] = [];
  async function step(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isInside(full, home)) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        await step(full);
      } else if (entry.isFile()) {
        if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
        if (detectKind(full)) out.push(full);
      }
    }
  }
  await step(root);
  return out;
}

export async function indexOne(store: Store, file: string, root: string): Promise<DocEntry> {
  // Single writer: the watcher process and folio_apply both land here.
  return withLock(store.home, "index", () => indexOneUnlocked(store, file, root));
}

async function indexOneUnlocked(store: Store, file: string, root: string): Promise<DocEntry> {
  const kind = detectKind(file);
  if (!kind) throw new Error(`unsupported file: ${file}`);

  const stat = await fs.stat(file);
  const doc = docName(file, root);
  const base: DocEntry = {
    doc,
    kind,
    sourcePath: file,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    unitKind: kind === "pdf" ? "page" : "block",
    units: 0,
    tables: [],
    outline: [],
    lines: 0,
    chars: 0,
    indexedAt: "",
    warnings: [],
    contentHash: await sourceHash(file),
    indexVersion: INDEX_VERSION,
  };

  try {
    const parsed = await parseFile(file, kind);
    if (await sourceHash(file) !== base.contentHash) throw new Error("source changed during parsing; retry indexing");
    base.unitKind = parsed.unitKind;
    base.tables = parsed.tables;
    base.outline = extractOutline(parsed.units, parsed.bookmarks);
    base.warnings = parsed.warnings;
    return await store.writeDoc(base, parsed.units);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    base.warnings = [`parse failed: ${message}`];
    return await store.writeDoc(base, []);
  }
}

export interface IndexSummary {
  indexed: number;
  skipped: number;
  failed: number;
  docs: string[];
  warnings: string[];
  ms: number;
}

export async function indexAll(
  store: Store,
  root: string,
  options: { force?: boolean } = {},
): Promise<IndexSummary> {
  const started = Date.now();
  // One lock for the whole pass: a watcher event landing mid-scan would
  // otherwise interleave two manifest writes.
  return withLock(store.home, "index", () => indexAllUnlocked(store, root, options, started));
}

async function indexAllUnlocked(
  store: Store,
  root: string,
  options: { force?: boolean },
  started: number,
): Promise<IndexSummary> {
  const files = await walkFiles(root, store.home);
  const manifest = await store.load();
  const summary: IndexSummary = { indexed: 0, skipped: 0, failed: 0, docs: [], warnings: [], ms: 0 };

  for (const file of files) {
    const doc = docName(file, root);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    const known = manifest.docs[doc];
    if (!options.force && known && known.indexVersion === INDEX_VERSION && known.revision && known.units > 0 &&
        !known.warnings.some((w) => w.startsWith("parse failed:")) &&
        known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.contentHash === await sourceHash(file)) {
      summary.skipped += 1;
      continue;
    }
    const entry = await indexOne(store, file, root);
    summary.indexed += 1;
    summary.docs.push(entry.doc);
    if (entry.units === 0) summary.failed += 1;
    for (const w of entry.warnings) summary.warnings.push(`${entry.doc}: ${w}`);
  }

  // Drop entries whose files are gone.
  const present = new Set(files.map((f) => docName(f, root)));
  const latest = await store.load();
  for (const doc of Object.keys(latest.docs)) {
    if (!present.has(doc)) {
      await store.removeDoc(doc);
    }
  }

  summary.ms = Date.now() - started;
  return summary;
}
