/**
 * 修改功能的验收测试。
 *
 * “改”是两段式的：agent 只能提案，人点头之后才落盘。这个文件逐条验证
 * 对外承诺——不点头不写、写了要备份、写完索引要跟上、过期提案要报冲突、
 * PDF 一律拒绝。任何一条挂掉，`folio_apply` 就不该放出去。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../dist/store.js";
import { indexAll } from "../dist/indexer.js";
import { resolveDoc, searchDocs } from "../dist/search.js";
import { addRevision, applyRevisions, listRevisions } from "../dist/revisions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "tmp", "revise-state");
const root = path.join(dir, "docs");
const home = path.join(dir, ".folio");
const note = path.join(root, "付款说明.md");
const pdfFile = "合同A_主合同.pdf";

const results: { n: number; name: string; detail: string; ok: boolean }[] = [];

function check(name: string, detail: string, ok: boolean): void {
  const n = results.length + 1;
  results.push({ n, name, detail, ok });
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${n}. ${name} — ${detail}\n`);
  if (!ok) {
    process.stderr.write(`revise.test: case ${n} failed\n`);
    process.exit(1);
  }
}

async function readNote(): Promise<string[]> {
  return (await fs.readFile(note, "utf8")).split("\n");
}

async function main(): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });

  const original = [
    "# 付款条款备注",
    "主合同 12.1：甲方应在验收后三十日内付款。",
    "主合同 12.3：逾期按日万分之五计违约金。",
    "补充协议 2.2：付款期限改为六十日。",
    "内部提醒：对外只用主合同口径。",
    "归档：2026-10",
  ];
  await fs.writeFile(note, `${original.join("\n")}\n`, "utf8");
  await fs.copyFile(path.join(here, "fixtures", "合同A_主合同.pdf"), path.join(root, "合同A_主合同.pdf"));

  const store = new Store(root, home);
  await store.init();
  await indexAll(store, root, {});
  const noteDoc = (await resolveDoc(store, "付款说明")) ?? "付款说明.md";
  const pdfDoc = (await resolveDoc(store, "合同A_主合同")) ?? "合同A_主合同.pdf";
  const beforeIndex = await readNote();

  // ---- 1. 提案不落盘 -------------------------------------------------
  const r1 = await addRevision(store, {
    doc: noteDoc,
    target: "¶2",
    text: "主合同 12.1：甲方应在验收后六十日内付款（依补充协议 2.2 调整）。",
    reason: "补充协议 2.2 把三十日改成了六十日",
  });
  const afterProposal = await readNote();
  check(
    "提案不落盘",
    `文件在提案后逐字未变（${afterProposal.join("").length} 字符相同=${afterProposal.join("\n") === beforeIndex.join("\n")}）`,
    r1.id === "r1" && afterProposal.join("\n") === beforeIndex.join("\n"),
  );

  // ---- 2. 清单里是待办，且记下了原文 --------------------------------
  const pending = await listRevisions(store, noteDoc);
  check(
    "清单可查、带原文",
    `状态=${pending[0].status} 原文=${pending[0].before.slice(0, 12)}…`,
    pending.length === 1 && pending[0].status === "pending" && pending[0].before === original[1],
  );

  // ---- 3. 再提一条不会覆盖前一条 ------------------------------------
  const r2 = await addRevision(store, {
    doc: noteDoc,
    target: "¶5",
    text: "内部提醒：对外只引用补充协议后的口径。",
  });
  const two = await listRevisions(store, noteDoc);
  check("多条提案并存", `${two.length} 条待办（${two.map((r) => r.id).join(", ")}）`, r2.id === "r2" && two.length === 2);

  // ---- 4. 没有 apply 就不会自己执行 ---------------------------------
  const stillRaw = await readNote();
  const untouched = stillRaw.join("\n") === beforeIndex.join("\n");
  check("没人点头就不执行", `文件仍未写入（${stillRaw[1].includes("三十日") ? "仍是三十日" : "已被改"}）`, untouched);

  // ---- 5. apply 之后文件真的变了 ------------------------------------
  const applied = await applyRevisions(store, noteDoc, ["r1"]);
  const afterApply = await readNote();
  check(
    "点头后写回",
    `applied=${applied.applied.join(",")}，第 2 行现为“${afterApply[1].slice(0, 20)}…”`,
    applied.applied.includes("r1") &&
      afterApply[1].includes("六十日") &&
      afterApply[1].includes("依补充协议") &&
      !afterApply[1].includes("三十日"),
  );

  // ---- 6. 写之前留了备份 --------------------------------------------
  const backupDir = path.join(home, "backup");
  const backups = await fs.readdir(backupDir).catch(() => [] as string[]);
  const backupText = backups.length ? await fs.readFile(path.join(backupDir, backups[0]), "utf8") : "";
  check(
    "写之前先备份",
    `${backups.length} 份备份，备份里仍是“三十日”=${backupText.includes("三十日")}`,
    backups.length === 1 && backupText.includes("三十日"),
  );

  // ---- 7. 写完索引立刻跟上 ------------------------------------------
  const hits = await searchDocs(store, "依补充协议", {});
  check(
    "索引自动重建",
    `搜“依补充协议”命中 ${hits.hits.length} 行（${hits.hits[0]?.label ?? "-"}）`,
    hits.hits.length >= 1 && hits.hits[0].label === "¶2",
  );

  // ---- 8. 同一条不会被写第二遍 --------------------------------------
  const again = await applyRevisions(store, noteDoc, ["r1"]);
  const afterAgain = await readNote();
  const backupsAgain = await fs.readdir(backupDir).catch(() => [] as string[]);
  check(
    "重复提交不重复写",
    `applied=${again.applied.length} 条、跳过 ${again.skipped.join(",") || "-"}，备份仍 ${backupsAgain.length} 份`,
    again.applied.length === 0 && again.skipped.includes("r1") && backupsAgain.length === 1 && afterAgain[1].includes("六十日"),
  );

  // ---- 9. 提案过期要报冲突，而不是乱改 ------------------------------
  await addRevision(store, { doc: noteDoc, target: "¶3", text: "主合同 12.3：逾期按日万分之三计违约金。" });
  const drift = (await readNote());
  drift[2] = "主合同 12.3：逾期按日万分之三计违约金（外部已改）。";
  await fs.writeFile(note, drift.join("\n"), "utf8");
  const stale = await applyRevisions(store, noteDoc);
  const afterStale = await readNote();
  check(
    "过期提案报冲突",
    `冲突 ${stale.conflicts.length} 条，文件保持外部版本=${afterStale[2].includes("外部已改")}`,
    stale.conflicts.length === 2 && stale.conflicts.every((c) => c.why.includes("changed")) && afterStale[2].includes("外部已改"),
  );

  // ---- 10. PDF 一律拒绝 ---------------------------------------------
  let pdfRefused = "";
  try {
    await applyRevisions(store, pdfDoc);
  } catch (err) {
    pdfRefused = err instanceof Error ? err.message : String(err);
  }
  check("PDF 只读", `拒绝理由=${pdfRefused.includes("is a pdf") ? "「文本层是排版产物」" : pdfRefused || "-"}`, pdfRefused.includes("is a pdf"));

  // ---- 汇总 ---------------------------------------------------------
  const report = {
    suite: "revise",
    generated: new Date().toISOString(),
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    cases: results,
  };
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`\nREVISE ${report.passed}/${report.total} ok\n`);
}

await main();
