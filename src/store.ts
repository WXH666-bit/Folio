/**
 * The index store.
 *
 * Layout:
 *   <home>/manifest.json      per-doc metadata — the cheap "what is in here" rung
 *   <home>/index/<doc>.txt    one page-tagged text file per document
 *
 * The index text is the only thing search touches. The original file stays the
 * single source of truth: the index can be deleted and rebuilt at any time.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { unitsToIndexText } from "./parse.js";
import type { DocEntry, Manifest, Unit } from "./types.js";
import { digest } from "./evidence.js";

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_STEM = 100;

/**
 * A file name that is safe on every platform we claim to run on.
 *
 * Three things go wrong with the obvious version: "a/b.pdf" and "a:b.pdf" both
 * become "a_b.pdf" (two documents, one index file), a 200-character name is
 * silently unusable on NTFS, and "con.pdf" cannot be created on Windows at all.
 * Names that need no repair are returned untouched, so existing indexes keep
 * working; repaired ones get a short hash of the original, which is what makes
 * them unique again.
 */
export function sanitizeName(doc: string): string {
  const base = doc
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "_")
    .replace(/[. ]+$/, "");
  const reserved = RESERVED.test(base);
  const tooLong = base.length > MAX_STEM + 20;
  if (!reserved && !tooLong && base === doc) return base;

  const hash = createHash("sha1").update(doc).digest("hex").slice(0, 8);
  const ext = path.extname(base);
  const keepExt = ext.length > 1 && ext.length < 16;
  const stem = (keepExt ? base.slice(0, -ext.length) : base).slice(0, MAX_STEM) || "doc";
  return `${reserved ? "_" : ""}${stem}-${hash}${keepExt ? ext : ""}`;
}

/** Write a text file so a crash leaves either the old content or the new one, never half. */
export async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  // Windows hands out EPERM/EBUSY for a rename onto a file an antivirus scanner
  // or another reader has open for a moment. Retrying turns a random 1-in-30
  // "parse failed" into a non-event; the tmp file is still cleaned up on give-up.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt >= 4) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export function emptyManifest(root: string): Manifest {
  return { version: 1, root, updatedAt: null, docs: {} };
}

export class Store {
  constructor(
    readonly root: string,
    readonly home: string,
  ) {}

  get manifestPath(): string {
    return path.join(this.home, "manifest.json");
  }

  get indexDir(): string {
    return path.join(this.home, "index");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.indexDir, { recursive: true });
  }

  async load(): Promise<Manifest> {
    try {
      const raw = await fs.readFile(this.manifestPath, "utf8");
      const parsed = JSON.parse(raw) as Manifest;
      if (!parsed || typeof parsed !== "object" || !parsed.docs) throw new Error("bad manifest");
      if (!parsed.docs || Array.isArray(parsed.docs)) throw new Error("bad docs");
      // Manifests written by an older version lack newer fields; fill them in
      // rather than failing, so an upgrade never forces a full re-index.
      for (const entry of Object.values(parsed.docs)) {
        entry.tables ??= [];
        entry.outline ??= [];
        entry.warnings ??= [];
      }
      return parsed;
    } catch {
      return emptyManifest(this.root);
    }
  }

  async save(manifest: Manifest): Promise<void> {
    manifest.root = this.root;
    manifest.updatedAt = new Date().toISOString();
    await this.init();
    await writeAtomic(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  indexFile(doc: string): string {
    return path.join(this.indexDir, `${sanitizeName(doc)}.txt`);
  }

  async writeDoc(entry: DocEntry, units: Unit[]): Promise<DocEntry> {
    const { text, lines, chars } = unitsToIndexText(units);
    entry.lines = lines;
    entry.chars = chars;
    entry.units = units.length;
    entry.indexedAt = new Date().toISOString();
    entry.indexHash = digest(text);
    entry.revision = digest(`${entry.indexVersion}:${entry.contentHash}:${entry.indexHash}`).slice(0, 16);
    await this.init();
    await writeAtomic(this.indexFile(entry.doc), text);
    const manifest = await this.load();
    manifest.docs[entry.doc] = entry;
    await this.save(manifest);
    return entry;
  }

  async removeDoc(doc: string): Promise<void> {
    await fs.rm(this.indexFile(doc), { force: true });
    const manifest = await this.load();
    if (manifest.docs[doc]) {
      delete manifest.docs[doc];
      await this.save(manifest);
    }
  }

  async indexFiles(): Promise<string[]> {
    try {
      const names = await fs.readdir(this.indexDir);
      return names.filter((n) => n.endsWith(".txt")).map((n) => path.join(this.indexDir, n));
    } catch {
      return [];
    }
  }
}
