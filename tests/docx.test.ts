/**
 * DOCX write-back regression test.
 *
 * A block edit must change one paragraph and nothing else: same paragraph
 * count, same neighbours, still a file Word and mammoth can open.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import mammoth from "mammoth";
import { applyDocxBlocks, normalizeText, paragraphText } from "../dist/write-docx.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "付款条款_内部说明.docx");
const dir = path.join(here, "tmp", "docx-state");
const copy = path.join(dir, "doc.docx");

function assert(ok: boolean, message: string): void {
  if (!ok) {
    process.stderr.write(`FAIL ${message}\n`);
    process.exit(1);
  }
  process.stdout.write(`ok  ${message}\n`);
}

async function paragraphs(file: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const xml = await zip.file("word/document.xml")!.async("string");
  const out: string[] = [];
  const re = /<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const text = normalizeText(paragraphText(m[0]));
    if (text) out.push(text);
  }
  return out;
}

async function main(): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(fixture, copy);

  const before = await paragraphs(copy);
  assert(before.length >= 3, `the fixture has paragraphs to edit (got ${before.length})`);

  const target = before[1];
  const neighbour = before[2];
  const replacement = `${target}（按补充协议修订）`;

  const result = await applyDocxBlocks(copy, [{ id: "r1", before: target, text: replacement }]);
  assert(result.applied.includes("r1"), "the edit is applied");
  assert(result.conflicts.length === 0, `no conflicts (${JSON.stringify(result.conflicts)})`);

  const after = await paragraphs(copy);
  assert(after.length === before.length, `paragraph count is unchanged (${before.length} → ${after.length})`);
  assert(after[1] === replacement, `the target paragraph changed (got "${after[1]}")`);
  assert(after[2] === neighbour, "the next paragraph is untouched");
  assert(after[0] === before[0], "the previous paragraph is untouched");

  // Still a healthy docx for a reader that knows nothing about us.
  const extracted = await mammoth.extractRawText({ path: copy });
  assert(extracted.value.includes(replacement), "mammoth still reads the edited text");
  assert(extracted.value.includes(neighbour), "mammoth still reads the neighbouring text");

  // --- refusals -----------------------------------------------------------
  const stale = await applyDocxBlocks(copy, [{ id: "r2", before: "这句话不在文档里", text: "x" }]);
  assert(stale.applied.length === 0 && stale.conflicts[0]?.id === "r2", "text that is not there is a conflict");
  assert(!(await fs.readFile(copy)).equals(Buffer.alloc(0)), "a refused edit does not truncate the file");

  const unchanged = await paragraphs(copy);
  assert(unchanged.length === after.length, "a refused edit writes nothing");

  process.stdout.write("OK — docx write-back\n");
}

main().catch((err) => {
  process.stderr.write(`FAIL ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
