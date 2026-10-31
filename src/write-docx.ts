/**
 * Block-level write-back for .docx.
 *
 * A docx is a zip of XML, and paragraphs are <w:p> elements in
 * word/document.xml. They never nest, so a rewrite can be surgical: find the
 * one paragraph whose text matches what the revision remembered, and replace
 * its runs with a single run that carries the first run's formatting. Styles,
 * headers, tables and images stay byte-identical.
 *
 * Two honest limits: a paragraph whose text appears twice is refused (a
 * block write cannot tell the two apart), and bookmarks or revision marks that
 * lived *inside* the edited paragraph are dropped when its runs are rebuilt.
 */
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const DOCUMENT_XML = "word/document.xml";

export interface BlockEdit {
  /** Caller's identifier, echoed back in the result. */
  id: string;
  /** The text as the index saw it — the revision's `before`. */
  before: string;
  text: string;
}

export interface BlockEditResult {
  applied: string[];
  conflicts: { id: string; why: string }[];
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Whitespace differs between the index and the raw XML; compare on the words. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Visible text of one <w:p> element, in run order. */
export function paragraphText(paragraph: string): string {
  const out: string[] = [];
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraph)) !== null) out.push(decodeXml(m[1]));
  return out.join("");
}

/** <w:p ...>…</w:p> or the self-closing <w:p/>. Never nested. */
const PARAGRAPH = /<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g;

function rebuild(paragraph: string, text: string): string {
  const open = /^<w:p\b[^>]*>/.exec(paragraph)?.[0] ?? "<w:p>";
  const inner = paragraph.slice(open.length, paragraph.lastIndexOf("</w:p>"));
  const pPr = /^\s*(<w:pPr>[\s\S]*?<\/w:pPr>)/.exec(inner)?.[1] ?? "";
  const firstRun = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/.exec(inner);
  const rPr = firstRun ? /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(firstRun[1])?.[0] ?? "" : "";
  return `${open}${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** Replace the text of paragraphs, matched by their current text. */
export async function applyDocxBlocks(file: string, edits: BlockEdit[], expectedHash?: string): Promise<BlockEditResult> {
  const original = await fs.readFile(file);
  const { digest, sourceHash } = await import("./evidence.js");
  const changed = (): BlockEditResult => ({ applied: [], conflicts: edits.map((e) => ({ id: e.id, why: "source changed during edit — read and propose again" })) });
  if (expectedHash && digest(original) !== expectedHash) return changed();
  const zip = await JSZip.loadAsync(original);
  const part = zip.file(DOCUMENT_XML);
  if (!part) throw new Error(`${path.basename(file)} has no ${DOCUMENT_XML} — not a Word file?`);
  let xml = await part.async("string");

  const result: BlockEditResult = { applied: [], conflicts: [] };

  for (const edit of edits) {
    const wanted = normalizeText(edit.before);
    if (!wanted) {
      result.conflicts.push({ id: edit.id, why: "the revision has no reference text to match" });
      continue;
    }
    PARAGRAPH.lastIndex = 0;
    const found: { start: number; end: number; source: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = PARAGRAPH.exec(xml)) !== null) {
      if (normalizeText(paragraphText(m[0])) === wanted) {
        found.push({ start: m.index, end: m.index + m[0].length, source: m[0] });
      }
    }
    if (found.length === 0) {
      result.conflicts.push({ id: edit.id, why: "no paragraph has that text any more — re-read the document" });
      continue;
    }
    if (found.length > 1) {
      result.conflicts.push({
        id: edit.id,
        why: `that text appears in ${found.length} paragraphs — a block edit cannot tell them apart`,
      });
      continue;
    }
    const target = found[0];
    xml = `${xml.slice(0, target.start)}${rebuild(target.source, edit.text)}${xml.slice(target.end)}`;
    result.applied.push(edit.id);
  }

  if (result.applied.length === 0) return result;

  zip.file(DOCUMENT_XML, xml);
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  if (await sourceHash(file) !== digest(original)) return changed();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, out);
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return result;
}
