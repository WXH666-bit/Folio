/**
 * Core types.
 *
 * The unit of the whole design is a "unit": one page of a PDF, or one block of a
 * DOCX/plain-text file. Every line of the index carries its unit label, which is
 * what makes a grep hit self-citing.
 */

export type DocKind = "pdf" | "docx" | "text" | "pptx" | "xlsx" | "html";

/** A PDF page, a PPTX slide, an XLSX worksheet, or a block of flowing text. */
export type UnitKind = "page" | "block" | "slide" | "sheet";

/** One unit of a document: a page (PDF) or a block (DOCX/TXT). */
export interface Unit {
  /** e.g. "p.12" for PDF page 12, "¶37" for the 37th block of a docx. */
  label: string;
  lines: string[];
}

export interface ParsedDoc {
  kind: DocKind;
  units: Unit[];
  /** "page" for PDF, "slide" for PPTX, "sheet" for XLSX, "block" otherwise. */
  unitKind: UnitKind;
  /** Units that appear to contain a table (column gaps detected). */
  tables: string[];
  /** Outline taken from PDF bookmarks, when the file has one. */
  bookmarks?: OutlineNode[];
  /** Non-fatal problems worth surfacing (e.g. "no text layer"). */
  warnings: string[];
}

/** One heading of a document: verbatim text plus the unit it starts on. */
export interface OutlineNode {
  /** Unit label of the unit the heading appears on, e.g. "p.12". */
  label: string;
  /** 0-based index of that unit among the document's units. */
  unit: number;
  /** 1 = chapter, 2 = article, 3 = clause. */
  level: number;
  title: string;
  /** 0-based line index inside that unit, when the heading came from the text. */
  line?: number;
}

/** Per-document metadata kept in manifest.json. This is the cheap "first rung". */
export interface DocEntry {
  /** Source and extracted-index fingerprints. Missing fields require reindexing. */
  contentHash?: string;
  indexHash?: string;
  indexVersion?: number;
  revision?: string;
  doc: string;
  kind: DocKind;
  sourcePath: string;
  size: number;
  mtimeMs: number;
  unitKind: UnitKind;
  units: number;
  /** Units that look tabular — so a model knows where a table lives without reading. */
  tables: string[];
  /** Section map: a few hundred tokens that replace guessing keywords. */
  outline: OutlineNode[];
  lines: number;
  chars: number;
  indexedAt: string;
  warnings: string[];
}


export interface Manifest {
  version: 1;
  root: string;
  updatedAt: string | null;
  docs: Record<string, DocEntry>;
}

/** A single search hit. */
export interface Hit {
  version?: string;
  doc: string;
  label: string;
  line: number;
  /** 1-based position of the line inside its unit — this is the stable part. */
  lineInUnit?: number;
  text: string;
  /** Section breadcrumb ("第十二条 付款条款"), when the outline knows one. */
  section?: string;
}
