/**
 * Outline: the cheap map of a document.
 *
 * A model that can see "第十二条 付款条款 — p.12" does not have to guess
 * keywords: it searches inside one article instead of scanning thirty pages.
 * The outline costs a few hundred tokens and is extracted at index time, so it
 * is free at query time.
 *
 * Two sources, best first:
 *   1. PDF bookmarks — an author-made tree, if the file has one.
 *   2. Text patterns — 第X章 / 第X条 / 一、/ 12.1 headings.
 *
 * Nothing here is a summary. Every node is a verbatim heading plus the unit it
 * appears on, so the map can never drift from the document.
 */
import type { OutlineNode, Unit } from "./types.js";

const CHINESE_NUM = "[一二三四五六七八九十百千零〇两\\d]{1,6}";
const RE_CHAPTER = new RegExp(`^(第${CHINESE_NUM}[章篇部])`);
const RE_ARTICLE = new RegExp(`^(第${CHINESE_NUM}条)`);
const RE_APPENDIX = /^(附[录件]\s*[一二三四五六七八九十\d]{0,3})/;
const RE_CN_ENUM = new RegExp(`^([一二三四五六七八九十]{1,3})[、．.]\\s*(\\S.*)$`);
const RE_NUM_HEAD = /^(\d{1,2}(?:\.\d{1,2}){0,3})[\s\u3000]+(\S.*)$/;

/** A heading must be short and must not read like a sentence. */
function plausible(title: string): boolean {
  const t = title.trim();
  if (t.length === 0 || t.length > 60) return false;
  if (/[。；;！？!?]/.test(t)) return false;
  if (/^(见|参见|如下|其中)/.test(t)) return false;
  // A heading does not end a sentence, nor introduce a list.
  if (/[:：，,]$/.test(t)) return false;
  return true;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface Candidate {
  text: string;
  level: number;
  /** Numbered clause ("12.1", "1.10") — its depth is relative to its section. */
  numeric?: boolean;
  /** Number of dots in a numeric heading, i.e. how deep it nests. */
  dots?: number;
}

/** Turn one line into an outline candidate, or null. */
function candidateOf(line: string): Candidate | null {
  const text = clean(line);

  if (RE_APPENDIX.test(text)) {
    return plausible(text) ? { text, level: 1 } : null;
  }
  const chapter = RE_CHAPTER.exec(text);
  if (chapter) {
    return plausible(text) ? { text, level: 1 } : null;
  }
  const article = RE_ARTICLE.exec(text);
  if (article) {
    // "第十二条 付款条款" is a heading; "第十二条 甲方应…。" is body text and is
    // caught by plausible()'s sentence-punctuation check.
    return plausible(text) ? { text, level: 2 } : null;
  }
  const cn = RE_CN_ENUM.exec(text);
  if (cn) {
    return plausible(text) ? { text, level: 2 } : null;
  }
  const num = RE_NUM_HEAD.exec(text);
  if (num) {
    const dots = (num[1].match(/\./g) ?? []).length;
    const rest = num[2];
    // Numbered clauses are usually body text ("12.1 甲方应在…"), so only short
    // title-like tails qualify.
    if (!plausible(rest) || rest.length > 30) return null;
    return { text, level: 2 + dots, numeric: true, dots };
  }
  return null;
}

/** Strip the leading numbering so "3.1 X" and "3.2 X" can be compared. */
function stemOf(title: string): string {
  return title
    .replace(new RegExp(`^(第${CHINESE_NUM}[章篇部条]|\\d{1,2}(?:\\.\\d{1,2}){0,3}|[一二三四五六七八九十]{1,3}[、．.])[\\s\\u3000]*`), "")
    .trim();
}

/**
 * A table-of-contents page repeats every heading with its page number. Indexing
 * it would put "第十二条" on the contents page instead of on page 12, so such a
 * page is skipped and the real headings are picked up where they appear.
 */
function isToc(candidates: Candidate[]): boolean {
  if (candidates.length < 4) return false;
  const withPageNumber = candidates.filter((c) => /\s\d{1,3}$/.test(c.text)).length;
  return withPageNumber / candidates.length >= 0.6;
}

function fromText(units: Unit[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  const seen = new Set<string>();
  // Level of the enclosing 第X条 / 附件, so "12.6" nests under it rather than
  // jumping to an absolute depth.
  let sectionLevel = 0;

  units.forEach((unit, unitIndex) => {
    const candidates: { c: Candidate; lineIndex: number }[] = [];
    unit.lines.forEach((line, lineIndex) => {
      const c = candidateOf(line);
      if (c) candidates.push({ c, lineIndex });
    });
    if (isToc(candidates.map((entry) => entry.c))) return;

    for (const { c, lineIndex } of candidates) {
      // Running headers repeat on every page; the first occurrence wins.
      const key = `${c.level}|${c.text}`;
      if (seen.has(key)) continue;

      if (c.numeric) {
        const base = sectionLevel > 0 ? sectionLevel : 1;
        c.level = Math.min(base + (c.dots ?? 0), 4);
      } else if (out.length > 0 && c.level > out[out.length - 1].level + 1) {
        // A parent must not be more specific than its child.
        c.level = out[out.length - 1].level + 1;
      }

      // Numbered siblings that differ only by their number are one heading.
      let previousSameLevel: OutlineNode | undefined;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].level === c.level) {
          previousSameLevel = out[i];
          break;
        }
      }
      if (previousSameLevel && stemOf(previousSameLevel.title) === stemOf(c.text)) continue;

      seen.add(key);
      if (!c.numeric) sectionLevel = c.level;
      out.push({ label: unit.label, unit: unitIndex, level: c.level, title: c.text, line: lineIndex });
    }
  });

  return out;
}

/** Normalise a PDF bookmark tree into flat nodes. */
export function flattenBookmarks(
  items: unknown[],
  pageOf: (item: unknown) => number | null,
  depth = 1,
): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { title?: unknown; items?: unknown };
    const title = clean(String(item.title ?? ""));
    if (title) {
      const page = pageOf(item);
      if (page !== null && page >= 1) {
        out.push({ label: `p.${page}`, unit: page - 1, level: Math.min(depth, 4), title });
      }
    }
    if (Array.isArray(item.items) && item.items.length > 0) {
      out.push(...flattenBookmarks(item.items, pageOf, depth + 1));
    }
  }
  return out;
}

/**
 * Build the outline for a document. Bookmarks win when there are enough of
 * them; otherwise the text patterns do the work.
 */
export function extractOutline(units: Unit[], bookmarks?: OutlineNode[]): OutlineNode[] {
  if (bookmarks && bookmarks.length >= 3) {
    // Keep only nodes that point at a unit this document actually has.
    return bookmarks.filter((b) => b.unit >= 0 && b.unit < units.length);
  }
  return fromText(units);
}

const LEADING_NUMBER = /^\d{1,2}(?:\.\d{1,2}){0,3}/;

/**
 * Ancestor chain of the section that contains a unit, e.g. "第十二条 付款条款".
 *
 * The label granularity is a page, so several headings can start on the unit a
 * hit sits on. `text` (the hit or the first line of the page) disambiguates:
 * a heading whose own number matches the text wins, otherwise the first
 * heading of that unit is used — never a later one, which would name a section
 * that starts *after* the hit.
 */
export function sectionAt(
  outline: OutlineNode[],
  unitIndex: number,
  text = "",
  maxDepth = 3,
  lineInUnit?: number,
): string {
  if (!outline.length) return "";
  const prefix = LEADING_NUMBER.exec(text)?.[0] ?? "";
  let last = -1;
  let sameUnit: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const node = outline[i];
    if (node.unit > unitIndex) break;
    if (node.unit < unitIndex) {
      last = i;
      sameUnit = [];
    } else if (sameUnit.length === 0) {
      sameUnit.push(i);
    } else {
      sameUnit.push(i);
    }
  }

  let chosen = last;
  if (sameUnit.length > 0) {
    const exact = sameUnit.find((i) => {
      const own = LEADING_NUMBER.exec(outline[i].title)?.[0] ?? "";
      return prefix !== "" && own !== "" && own === prefix;
    });
    if (exact !== undefined) {
      chosen = exact;
    } else if (lineInUnit !== undefined) {
      // Several headings can share a page; the hit belongs to the last one that
      // starts at or before it, not to the first heading on the page.
      const atOrBefore = sameUnit.filter((i) => (outline[i].line ?? 0) <= lineInUnit);
      chosen = atOrBefore.length > 0 ? atOrBefore[atOrBefore.length - 1] : sameUnit[0];
    } else {
      chosen = sameUnit[0];
    }
  }
  if (chosen < 0) return "";

  const chain: OutlineNode[] = [outline[chosen]];
  let level = outline[chosen].level;
  for (let i = chosen - 1; i >= 0 && level > 1 && chain.length < maxDepth; i--) {
    if (outline[i].level < level) {
      chain.unshift(outline[i]);
      level = outline[i].level;
    }
  }
  return chain.map((n) => n.title).join(" > ");
}
