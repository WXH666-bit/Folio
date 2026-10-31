/**
 * Parsers for the zip-container formats: PPTX and XLSX.
 *
 * Both are OOXML zips, so jszip is enough — no native module, no second
 * toolchain, and the same "never summarize" rule as the other parsers: slides
 * and rows are transcribed, formatting is not.
 */
import fs from "node:fs/promises";
import JSZip from "jszip";
import { tablesOf } from "./parse.js";
import type { ParsedDoc, Unit } from "./types.js";

/* ------------------------------------------------------------------ XML --- */

export function xmlDecode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function numOf(name: string): number {
  const m = /(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/* ----------------------------------------------------------------- PPTX --- */

/**
 * One unit per slide. Paragraphs become lines; table rows stay rows by joining
 * the cell runs of one `<a:tr>` with three spaces (same convention as PDF
 * tables, so the same "looks tabular" heuristic fires).
 */
export async function parsePptx(file: string): Promise<ParsedDoc> {
  const warnings: string[] = [];
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => numOf(a) - numOf(b));

  const units: Unit[] = [];
  for (let i = 0; i < names.length; i++) {
    const xml = await zip.file(names[i])!.async("string");
    const lines: string[] = [];
    for (const para of xml.match(/<a:p\b[\s\S]*?<\/a:p>|<a:p\b[^>]*\/>/g) ?? []) {
      const text = [...para.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
        .map((m) => xmlDecode(m[1]))
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (text) lines.push(text);
    }
    units.push({ label: `sl.${i + 1}`, lines: lines.length ? lines : ["(blank slide)"] });
  }

  if (units.length === 0) warnings.push("no slides found — the file may be a template or damaged");
  return { kind: "pptx", units, unitKind: "slide", tables: tablesOf(units), warnings };
}

/* ----------------------------------------------------------------- XLSX --- */

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

async function sharedStrings(zip: JSZip): Promise<string[]> {
  const entry = zip.file("xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = await entry.async("string");
  return (xml.match(/<si\b[\s\S]*?<\/si>/g) ?? []).map((si) =>
    [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1])).join(""),
  );
}

/** Sheet titles in workbook order, falling back to "Sheet1", "Sheet2"… */
async function sheetTitles(zip: JSZip): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const wb = zip.file("xl/workbook.xml");
  const rels = zip.file("xl/_rels/workbook.xml.rels");
  if (!wb) return map;
  const byRid = new Map<string, string>();
  if (rels) {
    const relXml = await rels.async("string");
    for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = /Id="([^"]+)"/.exec(m[0])?.[1];
      const target = /Target="([^"]+)"/.exec(m[0])?.[1];
      if (id && target) byRid.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
    }
  }
  const wbXml = await wb.async("string");
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(m[0])?.[1];
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    if (!name) continue;
    const target = rid ? byRid.get(rid) : undefined;
    if (target) map.set(target, xmlDecode(name));
  }
  return map;
}

/**
 * One unit per worksheet. Each non-empty row becomes a line, cells separated by
 * three spaces. Cell values are raw: numbers stay numbers, and dates stay Excel
 * serial numbers (with a warning) rather than being reinterpreted.
 */
export async function parseXlsx(file: string): Promise<ParsedDoc> {
  const warnings: string[] = [];
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const strings = await sharedStrings(zip);
  const titles = await sheetTitles(zip);
  const sheets = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => numOf(a) - numOf(b));

  const units: Unit[] = [];
  let sawDateSerial = false;
  for (let i = 0; i < sheets.length; i++) {
    const name = sheets[i];
    const xml = await zip.file(name)!.async("string");
    const lines: string[] = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      const cells: Array<{ col: number; text: string }> = [];
      for (const m of row.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = m[1];
        const body = m[2];
        const ref = /r="([A-Z]+\d+)"/i.exec(attrs)?.[1] ?? "A1";
        const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        let text: string;
        if (type === "s") text = strings[Number(raw)] ?? "";
        else if (type === "inlineStr") {
          text = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlDecode(x[1])).join("");
        } else text = xmlDecode(raw);
        // 44xxx is the Excel serial window for 2021-2024; anything there is
        // almost certainly a date the user will read as a date.
        if (type === "n" && /^4[0-9]{4}(\.\d+)?$/.test(text)) sawDateSerial = true;
        if (text.trim()) cells.push({ col: columnIndex(ref), text: text.replace(/\s+/g, " ").trim() });
      }
      if (cells.length === 0) continue;
      cells.sort((a, b) => a.col - b.col);
      lines.push(cells.map((c) => c.text).join("   "));
    }
    const label = titles.get(name) ?? `Sheet${i + 1}`;
    units.push({ label: `sh.${label}`, lines: lines.length ? lines : ["(empty sheet)"] });
  }

  if (sawDateSerial) warnings.push("date cells are raw Excel serial numbers, not dates");
  if (units.length === 0) warnings.push("no worksheets found");
  return { kind: "xlsx", units, unitKind: "sheet", tables: tablesOf(units), warnings };
}
