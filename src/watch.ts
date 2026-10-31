/**
 * Watcher: keeps the index honest while the agent is not looking.
 *
 * This is the "推一次" half of the design. It runs as its own long-lived
 * process, so parsing never happens on a tool call and never on the MCP host's
 * startup path. Silence is the default: events go to stderr, not into the
 * model's context.
 */
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { indexOne, isInside } from "./indexer.js";
import { detectKind } from "./parse.js";
import type { Store } from "./store.js";

export interface WatchEvent {
  action: "indexed" | "removed" | "error";
  doc: string;
  note?: string;
}

export interface Watcher {
  watcher: FSWatcher;
  close(): Promise<void>;
}

export function docName(file: string, root: string): string {
  const rel = path.relative(root, file);
  return (rel && !rel.startsWith("..") ? rel : path.basename(file)).split(path.sep).join("/");
}

export function startWatcher(
  store: Store,
  root: string,
  options: { ignoreInitial?: boolean; onEvent?: (event: WatchEvent) => void } = {},
): Watcher {
  const emit = options.onEvent ?? (() => undefined);
  const home = store.home;

  const watcher = watch(root, {
    ignoreInitial: options.ignoreInitial ?? true,
    ignored: (candidate: string) => {
      if (path.basename(candidate).startsWith(".")) return true;
      return isInside(candidate, home);
    },
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });

  // Serialize writes: two concurrent index passes would race on manifest.json.
  let chain: Promise<void> = Promise.resolve();
  const serial = (task: () => Promise<void>): void => {
    chain = chain.then(task).catch(() => undefined);
  };

  const handleUpsert = (file: string): void => {
    if (!detectKind(file)) return;
    serial(async () => {
      try {
        const entry = await indexOne(store, file, root);
        emit({ action: "indexed", doc: entry.doc, note: `${entry.units} units` });
      } catch (err) {
        emit({ action: "error", doc: docName(file, root), note: err instanceof Error ? err.message : String(err) });
      }
    });
  };

  watcher.on("add", handleUpsert);
  watcher.on("change", handleUpsert);
  watcher.on("unlink", (file: string) => {
    if (!detectKind(file)) return;
    const doc = docName(file, root);
    serial(async () => {
      const manifest = await store.load();
      const key =
        manifest.docs[doc] !== undefined
          ? doc
          : Object.keys(manifest.docs).find((name) => manifest.docs[name].sourcePath === file);
      if (key) {
        await store.removeDoc(key);
        emit({ action: "removed", doc: key });
      }
    });
  });
  watcher.on("error", (err: unknown) => {
    emit({ action: "error", doc: "", note: String(err) });
  });

  return { watcher, close: () => watcher.close() };
}
