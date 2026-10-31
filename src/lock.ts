/**
 * One writer at a time, across processes.
 *
 * Two things write the index: the watcher (its own process) and folio_apply
 * (inside the MCP server). A promise chain inside one process does nothing
 * about the other one, so the real serialization point has to be on disk. The
 * lock is a file: cheap, visible when it is stuck, and gone with the process.
 *
 * Re-entrancy matters here: applyRevisions holds the lock and then calls
 * indexOne, which wants the same lock. Nested calls on the same key in the same
 * process therefore pass straight through.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/** A lock older than this is assumed to belong to a dead process. */
const STALE_MS = 20_000;
/** How long to wait before giving up on a live holder. */
const WAIT_MS = 10_000;

const held = new AsyncLocalStorage<ReadonlySet<string>>();
const tails = new Map<string, Promise<void>>();

function lockFile(home: string, key: string): string {
  return path.join(home, "locks", `${key.replace(/[\\/:*?"<>|]/g, "_")}.lock`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function isStale(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return Date.now() - stat.mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

async function acquire(home: string, key: string): Promise<string> {
  const file = lockFile(home, key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const handle = await fs.open(file, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
      await handle.close();
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await isStale(file)) {
        await fs.rm(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`the index is busy (${file}) — another folio process is writing; try again`);
      }
      await sleep(25 + Math.random() * 40);
    }
  }
}

/**
 * Run `task` while holding the named lock.
 *
 * Serializes callers in this process (queue) and in other processes (file),
 * and lets the same key be re-entered from inside a held lock.
 */
export async function withLock<T>(home: string, key: string, task: () => Promise<T>): Promise<T> {
  const id = `${home}\u0000${key}`;
  if (held.getStore()?.has(id)) return task();

  const tail = tails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  tails.set(id, tail.then(() => mine));
  await tail;

  let file: string;
  try {
    file = await acquire(home, key);
  } catch (err) {
    release();
    throw err;
  }

  try {
    return await held.run(new Set([...(held.getStore() ?? []), id]), task);
  } finally {
    try { await fs.rm(file, { force: true }); }
    finally { release(); }
  }
}
