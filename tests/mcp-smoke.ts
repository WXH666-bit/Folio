/**
 * End-to-end smoke test.
 *
 * Starts the real thing (`node dist/cli.js start`), talks to it over real MCP
 * stdio, and checks the two claims that matter:
 *   1. a search returns page-tagged lines a model can cite
 *   2. the watcher picks up an added file and drops a deleted one, with nobody
 *      asking it to
 *
 * Run: npm run build && npx tsx tests/mcp-smoke.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const run = path.join(here, "tmp", "run");
const fixtures = path.join(here, "fixtures");

const log = (...args: unknown[]): void => {
  process.stdout.write(`${args.join(" ")}\n`);
};
const fail = (message: string): never => {
  process.stderr.write(`FAIL ${message}\n`);
  process.exit(1);
};
const assert = (ok: boolean, message: string): void => {
  if (!ok) fail(message);
};

async function rmrf(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

async function copyFixtures(names: string[]): Promise<void> {
  for (const name of names) {
    await fs.copyFile(path.join(fixtures, name), path.join(run, name));
  }
}

async function textOf(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const block = content.find((c) => c.type === "text");
  return block?.text ?? "";
}

const FIXTURES = ["合同A_主合同.pdf", "合同B_补充协议.pdf", "付款条款_内部说明.docx"];

async function main(): Promise<void> {
  await rmrf(run);
  await fs.mkdir(run, { recursive: true });
  await copyFixtures(FIXTURES);

  // --- start the server ----------------------------------------------------
  const entry = path.join(repo, "dist", "cli.js");
  await fs.access(entry).catch(() => fail("dist/cli.js missing — run `npm run build` first"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "start", "--root", run, "--home", path.join(run, ".folio")],
    stderr: "pipe",
  });
  const client = new Client({ name: "folio-smoke", version: "0.0.0" });
  await client.connect(transport);
  log("connected over stdio");

  try {
    // --- tools -------------------------------------------------------------
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    log(`tools: ${names.join(", ")}`);
    assert(
      JSON.stringify(names) ===
        JSON.stringify([
          "folio_apply",
          "folio_list",
          "folio_outline",
          "folio_page",
          "folio_revise",
          "folio_revisions",
          "folio_search",
        ]),
      `unexpected tools: ${names.join(",")}`,
    );

    // --- list --------------------------------------------------------------
    const list = await textOf(client, "folio_list", {});
    log(`\n--- folio_list ---\n${list}`);
    assert(list.includes("3 docs"), "folio_list should report 3 docs");
    assert(list.includes("合同A_主合同.pdf"), "folio_list should name the contract");
    assert(/tables\s+p\.\d+/.test(list), "folio_list should point at the table page");

    // --- search ------------------------------------------------------------
    const search = await textOf(client, "folio_search", { query: "万分之" });
    log(`\n--- folio_search "万分之" ---\n${search}`);
    assert(search.includes("p.12"), "search should hit 12.3 on p.12");
    assert(search.includes("12.3"), "search text should carry the clause number");
    assert(search.includes("合同B_补充协议.pdf:p.2"), "search should hit the amendment too");

    const narrowed = await textOf(client, "folio_search", { query: "万分之", doc: "合同B" });
    assert(
      narrowed.split("\n").filter((l) => l.includes(":p.") || l.includes(":¶")).length === 1,
      'doc: "合同B" should narrow to one hit',
    );

    const regex = await textOf(client, "folio_search", { query: "\\b12\\.1\\b", regex: true });
    assert(regex.includes("合同A_主合同.pdf:p.12"), "regex search should still find 12.1");
    assert(!regex.includes("12.10"), "word-boundary regex should not return 12.10");

    const miss = await textOf(client, "folio_search", { query: "不存在的词汇xyz" });
    log(`\n--- miss ---\n${miss}`);
    assert(miss.startsWith("status=no_match"), "a completed search with no matches should say so plainly");

    // --- page --------------------------------------------------------------
    const page = await textOf(client, "folio_page", { doc: "合同A", page: "12" });
    log(`\n--- folio_page 合同A 12 ---\n${page.slice(0, 400)}`);
    assert(page.includes("第十二条"), "p.12 should contain the clause heading");
    assert(page.includes("三十（30）"), "p.12 should contain the original payment term");
    assert(page.includes("万分之五"), "p.12 should contain the original penalty rate");

    const noPage = await textOf(client, "folio_page", { doc: "合同A", page: "999" });
    assert(noPage.includes("no 999"), "a missing page should explain itself");

    // --- watcher: add a file ------------------------------------------------
    log("\n--- watcher: add ---");
    const extra = path.join(run, "补充协议_第二份.pdf");
    await fs.copyFile(path.join(fixtures, "合同B_补充协议.pdf"), extra);
    let added = false;
    for (let i = 0; i < 60; i++) {
      const now = await textOf(client, "folio_list", {});
      if (now.includes("4 docs")) {
        added = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(added, "watcher did not pick up the added file within 15s");
    log("added file was indexed without a tool call");

    // --- watcher: delete a file ---------------------------------------------
    log("\n--- watcher: delete ---");
    await fs.rm(extra);
    let removed = false;
    for (let i = 0; i < 60; i++) {
      const now = await textOf(client, "folio_list", {});
      if (now.includes("3 docs")) {
        removed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(removed, "watcher did not drop the deleted file within 15s");
    log("deleted file was dropped from the index");

    // --- outline -------------------------------------------------------------
    log("\n--- folio_outline 合同A ---");
    const outline = await textOf(client, "folio_outline", { doc: "合同A" });
    log(outline.split("\n").slice(0, 6).join("\n"));
    assert(outline.includes("第十二条"), "outline should carry the clause heading");
    assert(/p\.12/.test(outline), "outline should point at p.12");
    assert(outline.split("\n").length > 20, "outline should list more than a handful of headings");

    const outlineAll = await textOf(client, "folio_outline", {});
    assert(outlineAll.includes("合同B"), "outline without a doc should summarize every document");

    // --- revisions: propose, review, gated apply -----------------------------
    log("\n--- revisions ---");
    const notePath = path.join(run, "备注.md");
    await fs.writeFile(notePath, "付款方式：三十日。\n逾期利率：万分之五。\n", "utf8");
    for (let i = 0; i < 60; i++) {
      const now = await textOf(client, "folio_list", {});
      if (now.includes("4 docs")) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const noteRead = await textOf(client, "folio_page", { doc: "备注" });
    const noteVersion = /version=([a-f0-9]+)/.exec(noteRead)?.[1];
    assert(!!noteVersion, "small-file read supplies a version");
    const proposed = await textOf(client, "folio_revise", {
      version: noteVersion,
      doc: "备注",
      target: "¶1:L1",
      text: "付款方式：六十日。",
      reason: "对齐补充协议",
    });
    log(proposed);
    assert(proposed.includes("proposed r1"), "revise should allocate r1");
    assert(proposed.includes("付款方式：三十日"), "revise should quote the line being replaced");

    const pending = await textOf(client, "folio_revisions", { doc: "备注" });
    assert(pending.includes("r1") && pending.includes("pending"), "the list should show one pending proposal");

    const blocked = await textOf(client, "folio_apply", { doc: "备注" });
    assert(blocked.includes("disabled"), "apply must be off unless the operator opts in");

    const badTarget = await textOf(client, "folio_revise", { doc: "备注", target: "¶9:L1", text: "x", version: noteVersion });
    assert(badTarget.includes("no line"), "a bogus target should be refused");
    await fs.rm(notePath);

    // --- docx: propose, then commit through the gate ------------------------
    // The operator opted in for this second server only, so the first one keeps
    // proving that a default install cannot write anything.
    log("\n--- docx apply (second server, --allow-apply) ---");
    const writerTransport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, "start", "--root", run, "--home", path.join(run, ".folio"), "--allow-apply"],
      stderr: "pipe",
    });
    const writer = new Client({ name: "folio-smoke-writer", version: "0.0.0" });
    await writer.connect(writerTransport);
    try {
      const found = await textOf(writer, "folio_search", { query: "操作口径", doc: "付款条款" });
      const cite = /付款条款_内部说明\.docx:(¶\d+)(?::L\d+)?/.exec(found);
      assert(cite !== null, `the docx should be searchable with a block citation (${found})`);

      const proposal = await textOf(writer, "folio_revise", {
        version: /version=([a-f0-9]+)/.exec(found)?.[1],
        doc: "付款条款",
        target: cite![1],
        text: "本文档为内部说明，已经法务审阅。",
        reason: "smoke: docx block write",
      });
      log(proposal);
      assert(proposal.includes("proposed"), "a docx revision should be recorded, not written");

      const committed = await textOf(writer, "folio_apply", { doc: "付款条款" });
      log(committed);
      assert(committed.includes("applied"), `apply should commit the docx block (${committed})`);
      assert(committed.includes("backup"), "a backup should be named");

      const reread = await textOf(writer, "folio_search", { query: "已经法务审阅" });
      assert(reread.includes("付款条款_内部说明.docx"), "the docx is reindexed right after the write");

      const pdf = await textOf(writer, "folio_apply", { doc: "合同A" });
      assert(/pdf|nothing applied/.test(pdf), "a pdf is still never written");
    } finally {
      await writer.close().catch(() => undefined);
    }

    log("\nOK — all smoke checks passed");
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
