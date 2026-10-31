import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countTokens } from "gpt-tokenizer";
import { Store } from "../dist/store.js";
import { indexAll, indexOne } from "../dist/indexer.js";
import { runTool } from "../dist/mcp.js";
import { searchDocs } from "../dist/search.js";
import { formatSearch } from "../dist/format.js";
import { addRevision, applyRevisions } from "../dist/revisions.js";
import { withLock } from "../dist/lock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, "tmp");
await fs.mkdir(tmp, { recursive: true });
const dir = await fs.mkdtemp(path.join(tmp, "retrieval-"));
const root = path.join(dir, "docs");
await fs.mkdir(path.join(root, "nested"), { recursive: true });
const store = new Store(root, path.join(dir, "index"));
const write = (name: string, text: string) => fs.writeFile(path.join(root, name), text);
const tool = (name: string, args: Record<string, unknown>) => runTool(store, name, args, { allowWrite: true });
const read = (args: Record<string, unknown>) => tool("folio_page", args);
const search = (args: Record<string, unknown>) => tool("folio_search", args);
const version = (text: string) => /version=([a-f0-9]{16})/.exec(text)?.[1];
const cursor = (text: string) => /^next_cursor=(\S+)$/m.exec(text)?.[1];
let checks = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn(); console.log(`ok ${++checks}. ${name}`);
}

await write("small.md", "第一条 付款\n12.1 应在三十日内付款。\n补充条件：验收通过。\n12.2 逾期处理。\n其它内容。");
await write("nested/a.txt", "子目录证据 unique");
await write("nested_a.txt", "另一个文件 other");
await write("empty.txt", "");
await write("broken.docx", "not a zip");
await write("long.txt", "证据😀甲乙丙丁".repeat(600) + "结束");
await write("many.txt", Array.from({ length: 35 }, (_, i) => `项目${i} match 真实原文`).join("\n"));
await fs.copyFile(path.join(here, "ab", "corpus2", "政府_签到表_扫描件.pdf"), path.join(root, "scan.pdf"));
await indexAll(store, root);

await test("small document in one call, with accurate version and line references", async () => {
  const output = await read({ doc: "small.md" });
  assert.match(output, /status=complete/); assert.ok(version(output));
  assert.match(output, /small.md:¶5:L1/); assert.match(output, /三十日/);
});
await test("context crosses physical text units without losing citations", async () => {
  const output = await read({ doc: "small.md", target: "¶2:L1", mode: "context", before: 1, after: 1 });
  assert.match(output, /¶1:L1/); assert.match(output, /¶3:L1/); assert.doesNotMatch(output, /¶4:L1/);
});
await test("complete numbered clause includes conditions but excludes the next clause", async () => {
  const output = await read({ doc: "small.md", target: "¶3:L1", mode: "section" });
  assert.match(output, /12.1/); assert.match(output, /验收通过/); assert.doesNotMatch(output, /12.2/);
});
await test("unknown section boundary is reported rather than invented", async () => {
  assert.match(await read({ doc: "nested/a.txt", target: "¶1:L1", mode: "section" }), /section_boundary_unknown/);
});
await test("Markdown section expansion includes every row and stops at the next heading", async () => {
  await write("headings.md", "# Manual\n## Levels\nP0 emergency\nP1 urgent\nP2 routine\n## Other\nnot part of levels");
  await indexOne(store, path.join(root, "headings.md"), root);
  const output = await read({ doc: "headings.md", target: "¶3:L1", mode: "section" });
  assert.match(output, /P0 emergency/); assert.match(output, /P2 routine/);
  assert.doesNotMatch(output, /not part of levels|section_boundary_unknown/);
});
await test("sanitized index filenames still cite the original document and expand correctly", async () => {
  const output = await search({ query: "unique" });
  assert.match(output, /nested\/a.txt:¶1:L1/);
  assert.match(await read({ doc: "nested/a.txt", version: version(output) }), /unique/);
});
await test("empty and scanned documents return no_text, never made-up OCR", async () => {
  assert.match(await read({ doc: "empty.txt" }), /status=no_text/);
  const output = await read({ doc: "scan.pdf", page: "1" });
  assert.match(output, /status=no_text/); assert.match(output, /did not perform OCR/);
  assert.match(await search({ query: "人名", doc: "scan.pdf" }), /no_text/);
});
await test("parser failures, missing document and genuine no-match remain distinct", async () => {
  assert.match(await read({ doc: "broken.docx" }), /status=parse_failed/);
  assert.match(await read({ doc: "absent" }), /status=not_found/);
  assert.match(await search({ doc: "small.md", query: "不存在XYZ" }), /status=no_match/);
  assert.match(await search({ doc: "absent", query: "不存在XYZ" }), /no documents match/);
});
await test("zero-hit timeout remains explicitly incomplete in all formatters", async () => {
  const result = await searchDocs(store, "不存在XYZ", { doc: "small.md" });
  result.timedOut = true; result.complete = false;
  assert.match(formatSearch("不存在XYZ", result), /scan stopped/);
  assert.doesNotMatch(formatSearch("不存在XYZ", result), /^no hits/);
});
await test("scan budget can expire with no matches and still supply a continuation", async () => {
  const realNow = Date.now; let tick = 0;
  Date.now = () => tick++ * 100;
  try {
    const output = await search({ query: "absent", doc: "small.md", timeoutMs: 1 });
    assert.match(output, /status=incomplete/); assert.ok(cursor(output));
  } finally { Date.now = realNow; }
});
await test("oversized lines paginate exactly, within budget, including emoji", async () => {
  let next: string | undefined; let reconstructed = ""; let calls = 0;
  do {
    const output = await read({ doc: "long.txt", maxTokens: 512, ...(next ? { cursor: next } : {}) });
    assert.ok(countTokens(output) <= 512);
    assert.doesNotMatch(output, /\uFFFD/);
    const row = output.split("\n").find((l) => l.startsWith("long.txt:¶1:L1"));
    assert.ok(row); reconstructed += row!.replace(/^long.txt:¶1:L1(?: \[char=\d+\])?  /, "").replace(/ \[fragment\]$/, "");
    next = cursor(output); assert.ok(++calls < 100);
  } while (next);
  assert.equal(reconstructed, await fs.readFile(path.join(root, "long.txt"), "utf8"));
  assert.ok(calls > 1);
});
await test("search pagination preserves all hits without duplicates", async () => {
  let next: string | undefined; const cites: string[] = [];
  do {
    const output = await search({ query: "match", doc: "many.txt", limit: 4, maxTokens: 512, ...(next ? { cursor: next } : {}) });
    assert.ok(countTokens(output) <= 512);
    cites.push(...[...output.matchAll(/^many.txt:(¶\d+:L1)/gm)].map((m) => m[1]));
    next = cursor(output); assert.ok(cites.length <= 35);
  } while (next);
  assert.equal(cites.length, 35); assert.equal(new Set(cites).size, 35);
});
await test("long search hit is an explicitly marked excerpt with a readable target", async () => {
  const output = await search({ query: "结束", doc: "long.txt", maxTokens: 512 });
  assert.match(output, /结束/); assert.match(output, /excerpt/); assert.ok(countTokens(output) <= 512);
});
await test("regex clipping cannot masquerade as complete absence", async () => {
  const output = await search({ query: "结束", doc: "long.txt", regex: true });
  assert.match(output, /status=incomplete/); assert.match(output, /first 4000/);
});
await test("cursor cannot be reused for a different query or document", async () => {
  const s = await search({ query: "match", doc: "many.txt", limit: 1 });
  await assert.rejects(search({ query: "other", doc: "many.txt", cursor: cursor(s) }), /stale_cursor/);
  const r = await read({ doc: "long.txt", maxTokens: 512 });
  await assert.rejects(read({ doc: "small.md", cursor: cursor(r) }), /stale_cursor/);
  await assert.rejects(read({ doc: "small.md", cursor: "bad" }), /invalid cursor/);
});
await test("same-size same-mtime source edits invalidate evidence and rebuild incrementally", async () => {
  const file = path.join(root, "nested/a.txt"), stat = await fs.stat(file);
  const old = await read({ doc: "nested/a.txt" });
  await write("nested/a.txt", "子目录证据 change"); await fs.utimes(file, stat.atime, stat.mtime);
  assert.match(await read({ doc: "nested/a.txt" }), /status=stale_index/);
  const indexed = await indexAll(store, root);
  assert.ok(indexed.docs.includes("nested/a.txt"));
  assert.match(await read({ doc: "nested/a.txt", version: version(old) }), /stale_reference/);
});
await test("old read and search cursors reject after reindexing", async () => {
  const s = await search({ query: "match", doc: "many.txt", limit: 1 });
  const r = await read({ doc: "long.txt", maxTokens: 512 });
  await fs.appendFile(path.join(root, "many.txt"), "\nnew match"); await indexOne(store, path.join(root, "many.txt"), root);
  await fs.appendFile(path.join(root, "long.txt"), "new"); await indexOne(store, path.join(root, "long.txt"), root);
  await assert.rejects(search({ query: "match", doc: "many.txt", cursor: cursor(s) }), /stale_cursor/);
  await assert.rejects(read({ doc: "long.txt", cursor: cursor(r) }), /stale_cursor/);
});
await test("legacy index is reported and upgraded without requiring --force", async () => {
  const manifest = await store.load(); delete manifest.docs["small.md"].indexVersion; await store.save(manifest);
  assert.match(await read({ doc: "small.md" }), /legacy index/);
  assert.ok((await indexAll(store, root)).docs.includes("small.md"));
  assert.match(await read({ doc: "small.md" }), /status=complete/);
});
await test("damaged index cannot supply apparently valid evidence", async () => {
  await fs.appendFile(store.indexFile("small.md"), "¶999\tinjected\n");
  assert.match(await read({ doc: "small.md" }), /status=stale_index/);
  assert.doesNotMatch(await search({ query: "injected", doc: "small.md" }), /¶999/);
  await indexOne(store, path.join(root, "small.md"), root);
});
await test("missing source and missing index have distinct statuses", async () => {
  await write("vanish.txt", "x"); await indexOne(store, path.join(root, "vanish.txt"), root); await fs.unlink(path.join(root, "vanish.txt"));
  assert.match(await read({ doc: "vanish.txt" }), /status=source_missing/);
  await fs.unlink(store.indexFile("nested_a.txt"));
  assert.match(await read({ doc: "nested_a.txt" }), /status=index_unavailable/);
});
await test("MCP rejects unversioned proposals and binds valid proposals", async () => {
  await assert.rejects(tool("folio_revise", { doc: "small.md", target: "¶2", text: "new" }), /version_required/);
  const output = await read({ doc: "small.md" });
  const proposed = await tool("folio_revise", { doc: "small.md", target: "¶2", text: "12.1 六十日。", version: version(output) });
  assert.match(proposed, /proposed/); assert.match(proposed, /version=/);
});
await test("editing an unrelated line also invalidates an old proposal", async () => {
  const file = path.join(root, "small.md");
  await fs.appendFile(file, "\n外部新增"); await indexOne(store, file, root);
  const before = await fs.readFile(file, "utf8");
  const applied = await applyRevisions(store, "small.md");
  assert.equal(applied.applied.length, 0); assert.equal(applied.conflicts.length, 1);
  assert.equal(await fs.readFile(file, "utf8"), before); assert.equal(applied.backup, null);
});
await test("real insert/delete/replace batch uses original positions and keeps backup", async () => {
  await write("batch.txt", "甲\n乙\n丙\n丁\n戊"); await indexOne(store, path.join(root, "batch.txt"), root);
  const v = version(await read({ doc: "batch.txt" }));
  await addRevision(store, { doc: "batch.txt", target: "¶1", action: "insert_after", text: "新增", version: v });
  await addRevision(store, { doc: "batch.txt", target: "¶3", action: "delete", version: v });
  await addRevision(store, { doc: "batch.txt", target: "¶5", text: "新戊", version: v });
  const result = await applyRevisions(store, "batch.txt");
  assert.equal(result.applied.length, 3);
  assert.equal(await fs.readFile(path.join(root, "batch.txt"), "utf8"), "甲\n新增\n乙\n丁\n新戊");
  assert.equal(await fs.readFile(result.backup!, "utf8"), "甲\n乙\n丙\n丁\n戊");
  assert.notEqual(version(await read({ doc: "batch.txt" })), v);
});
await test("a writer started while a lock is held must queue (not falsely reenter)", async () => {
  const order: string[] = []; let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>((r) => entered = r), hold = new Promise<void>((r) => release = r);
  const first = withLock(store.home, "test", async () => { entered(); await hold; order.push("first"); });
  await ready;
  const second = withLock(store.home, "test", async () => { order.push("second"); });
  release(); await Promise.all([first, second]); assert.deepEqual(order, ["first", "second"]);
});
await test("invalid budget and cursor range fail without reading unbounded output", async () => {
  await assert.rejects(read({ doc: "small.md", maxTokens: 1 }), /maxTokens/);
  const v = version(await read({ doc: "small.md" }));
  const bad = Buffer.from(JSON.stringify({ k: "r", d: "small.md", v, b: -1, e: 900, o: 0 })).toString("base64url");
  await assert.rejects(read({ doc: "small.md", cursor: bad }), /integer|cursor/);
});
console.log(`RETRIEVAL ${checks}/${checks} passed`);
