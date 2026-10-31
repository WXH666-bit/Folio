/**
 * Store and lock regression test.
 *
 * Two names that sanitize to the same file, a manifest written while another
 * process reads it, a lock left behind by a crash — these are the failures that
 * only show up in the field, so they are pinned here.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withLock } from "../dist/lock.js";
import { Store, emptyManifest, sanitizeName, writeAtomic } from "../dist/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = path.join(here, "tmp", "store-state");

function assert(ok: boolean, message: string): void {
  if (!ok) {
    process.stderr.write(`FAIL ${message}\n`);
    process.exit(1);
  }
  process.stdout.write(`ok  ${message}\n`);
}

async function main(): Promise<void> {
  // --- sanitizeName -------------------------------------------------------
  assert(sanitizeName("合同A_主合同.pdf") === "合同A_主合同.pdf", "a clean name is left untouched");
  const slash = sanitizeName("a/b.pdf");
  const colon = sanitizeName("a:b.pdf");
  assert(slash !== colon, `names that collide after repair stay distinct (${slash} vs ${colon})`);
  assert(slash.endsWith(".pdf"), "the extension survives the repair");
  assert(sanitizeName("con.pdf").startsWith("_"), "a Windows reserved name is prefixed");
  const long = "章节".repeat(120) + ".pdf";
  const repaired = sanitizeName(long);
  assert(repaired.length <= 115, `a 240-char name is shortened (${repaired.length} chars)`);
  assert(sanitizeName(long) === repaired, "repair is deterministic");
  assert(!sanitizeName("report.").endsWith("."), "trailing dots are stripped");

  // --- manifest -----------------------------------------------------------
  await fs.rm(home, { recursive: true, force: true });
  const store = new Store(home, home);
  const empty = await store.load();
  assert(empty.version === 1 && Object.keys(empty.docs).length === 0, "a missing manifest loads as empty");

  empty.docs["x.txt"] = {
    doc: "x.txt",
    kind: "text",
    sourcePath: path.join(home, "x.txt"),
    size: 1,
    mtimeMs: 1,
    unitKind: "block",
    units: 1,
    tables: [],
    outline: [],
    lines: 1,
    chars: 1,
    indexedAt: new Date().toISOString(),
    warnings: [],
  };
  await store.save(empty);
  const loaded = await store.load();
  assert(Boolean(loaded.docs["x.txt"]), "a saved manifest loads back");
  assert(loaded.updatedAt !== null, "save stamps updatedAt");

  await fs.writeFile(store.manifestPath, "{ not json", "utf8");
  const recovered = await store.load();
  assert(Object.keys(recovered.docs).length === 0, "a corrupt manifest falls back to empty instead of throwing");

  // --- atomic write -------------------------------------------------------
  const target = path.join(home, "atomic.txt");
  await writeAtomic(target, "first");
  await writeAtomic(target, "second");
  assert((await fs.readFile(target, "utf8")) === "second", "atomic write replaces the content");
  const leftovers = (await fs.readdir(home)).filter((n) => n.endsWith(".tmp"));
  assert(leftovers.length === 0, `no temp files are left behind (${leftovers.join(",")})`);

  // --- lock ---------------------------------------------------------------
  const order: string[] = [];
  const slow = withLock(home, "index", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 60));
    order.push("a-end");
  });
  const fast = withLock(home, "index", async () => {
    order.push("b-start");
  });
  await Promise.all([slow, fast]);
  assert(order.join(",") === "a-start,a-end,b-start", `lock serializes writers (${order.join(",")})`);

  const reentrant = await withLock(home, "index", () => withLock(home, "index", async () => "nested"));
  assert(reentrant === "nested", "the same lock is re-entrant in one process");
  const locks = await fs.readdir(path.join(home, "locks")).catch(() => []);
  assert(locks.length === 0, `locks are released (${locks.join(",")})`);

  // A crashed holder leaves a file behind; it must not block forever.
  const stale = path.join(home, "locks", "index.lock");
  await fs.mkdir(path.dirname(stale), { recursive: true });
  await fs.writeFile(stale, "99999", "utf8");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(stale, old, old);
  const afterStale = await withLock(home, "index", async () => "ok");
  assert(afterStale === "ok", "a stale lock is broken");

  assert(emptyManifest(home).version === 1, "emptyManifest is shaped correctly");
  process.stdout.write("OK — store and lock\n");
}

main().catch((err) => {
  process.stderr.write(`FAIL ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
