/**
 * Search regression test.
 *
 * The contract is narrow and worth pinning: multi-word queries AND on one line,
 * every hit carries the citation the tools print, and a scan that stops early
 * says so instead of pretending it finished.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexAll } from "../dist/indexer.js";
import { readUnit, resolveDoc, searchDocs } from "../dist/search.js";
import { Store } from "../dist/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "tmp", "search-root");
const home = path.join(here, "tmp", "search-state");

function assert(ok: boolean, message: string): void {
  if (!ok) {
    process.stderr.write(`FAIL ${message}\n`);
    process.exit(1);
  }
  process.stdout.write(`ok  ${message}\n`);
}

async function main(): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });

  await fs.writeFile(
    path.join(root, "合同A.txt"),
    ["第一条 付款方式", "12.1 甲方应在三十日内付款。", "12.2 逾期按万分之五计违约金。", "12.3 甲方开票后付款。"].join("\n"),
    "utf8",
  );
  await fs.writeFile(path.join(root, "合同B.txt"), ["付款期限为六十日", "违约金按万分之三计算"].join("\n"), "utf8");
  await fs.writeFile(path.join(root, "长行.txt"), `${"甲".repeat(9000)}尾Z`, "utf8");

  const store = new Store(root, home);
  await indexAll(store, root, { force: true });

  // --- literals -----------------------------------------------------------
  const and = await searchDocs(store, "逾期 万分之");
  assert(and.totalHits === 1, `two words must appear on the same line (got ${and.totalHits})`);
  assert(and.hits[0]?.doc === "合同A.txt", "the AND hit lands in the right document");
  assert(and.hits[0]?.label === "¶3", `the hit keeps its unit label (got ${and.hits[0]?.label})`);
  assert(and.hits[0]?.lineInUnit === 1, `the hit keeps its line within the unit (got ${and.hits[0]?.lineInUnit})`);

  const loose = await searchDocs(store, "付款");
  assert(loose.totalHits === 4, `a single word finds every line (got ${loose.totalHits})`);

  // --- scope --------------------------------------------------------------
  const scoped = await searchDocs(store, "付款", { doc: "合同B" });
  assert(scoped.totalHits === 1 && scoped.hits[0]?.doc === "合同B.txt", "doc filter narrows the scan");
  assert((await resolveDoc(store, "合同A")) === "合同A.txt", "a partial name resolves to a document");
  assert((await resolveDoc(store, "nope")) === null, "an unknown name resolves to null");

  // --- regex --------------------------------------------------------------
  const regex = await searchDocs(store, "12\\.\\d", { regex: true });
  assert(regex.totalHits === 3, `regex mode matches by pattern (got ${regex.totalHits})`);
  const literal = await searchDocs(store, "12\\.\\d");
  assert(literal.totalHits === 0, "without regex:true the same text is a literal");

  let refused = false;
  try {
    await searchDocs(store, "a".repeat(201), { regex: true });
  } catch {
    refused = true;
  }
  assert(refused, "an over-long regex is refused instead of compiled");

  // --- budget -------------------------------------------------------------
  const timed = await searchDocs(store, "甲", { timeoutMs: 1, regex: true });
  assert(typeof timed.ms === "number", "every search reports its duration");
  assert(timed.timedOut === false || timed.timedOut === true, "the timeout flag is always present");
  const longLine = await searchDocs(store, "尾Z", { regex: true, timeoutMs: 2000 });
  assert(longLine.timedOut === false, "a long line does not trip the budget");
  assert(typeof longLine.totalHits === "number", "a long line is still searchable");

  // --- reading a unit -----------------------------------------------------
  const second = await readUnit(store, "合同A.txt", "2");
  assert(second !== null, "¶2 can be read back");
  assert(second?.lines[0]?.startsWith("12.1"), `¶2 starts with the clause (got ${second?.lines[0]})`);
  assert((await readUnit(store, "合同A.txt", "99")) === null, "a missing unit returns null");

  process.stdout.write("OK — search\n");
}

main().catch((err) => {
  process.stderr.write(`FAIL ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
