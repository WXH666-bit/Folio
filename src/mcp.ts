/**
 * Seven document tools. Reading uses version-checked indexes; applying a
 * revision requires explicit write enablement and refreshes the index.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { formatApply, formatList, formatOutline, formatRevisions } from "./format.js";
import { addRevision, applyRevisions, listRevisions } from "./revisions.js";
import { resolveDoc } from "./search.js";
import type { Store } from "./store.js";
import { evidence } from "./evidence.js";
import { retrieveRead, retrieveSearch } from "./retrieval.js";

const INSTRUCTIONS = [
  "Documents in the indexed folder are already parsed, with page numbers.",
  "Use folio_list / folio_outline / folio_search / folio_page instead of converting or dumping the files:",
  "Small files: folio_page with doc only reads the whole document within a token budget. Large files: search, then expand target with mode=context or section.",
  "partial results have next_cursor; pass it to the same tool to continue. maxTokens uses an o200k_base estimate including metadata, not the model's billing tokenizer.",
  "no_text/parse_failed/stale_index/incomplete are missing evidence, not proof of absence. Never use another document as evidence for an unreadable scan; Folio does not perform OCR.",
  "Every hit is citable as doc:page:line with version. Pass that version when expanding evidence or proposing edits; stale references require rereading.",
  "To change a document, propose with folio_revise and never rewrite the file yourself; folio_apply commits the list (text and docx, with a backup; pdfs are proposal-only).",
].join(" ");

const TOOLS = [
  {
    name: "folio_list",
    description:
      "List the documents in the indexed folder: kind, page count, which pages hold tables, how many sections. Call it first when you do not know what is on disk. Very cheap.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "folio_outline",
    description:
      "The table of contents of one document: verbatim headings (第X章 / 第X条 / 12.1 …) with the page each starts on. Call it before searching when you need to know where a topic lives, or when the words to search for are not obvious. Cheap.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "Document name. Omit to get one line per document instead of a full outline." },
        limit: { type: "integer", minimum: 1, maximum: 300, description: "Max headings to print, default 120." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "folio_search",
    description:
      "Search indexed documents for literal words; returns only the matching lines, each tagged doc:page. Multi-word queries are ANDed on the same line, so more words narrow. Prefer this over reading or converting a file.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Words to find, e.g. "付款 期限" or "12.1" or "违约金".' },
        doc: { type: "string", description: "Restrict to documents whose name contains this string." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max hits to return, default 20." },
        regex: { type: "boolean", description: "Treat the query as regular expressions." },
        maxTokens: { type: "integer", minimum: 512, maximum: 16000, description: "Output token budget including metadata, default 2000 (o200k_base estimate)." },
        cursor: { type: "string", description: "next_cursor from the previous result; keep query/doc/regex unchanged." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "folio_page",
    description:
      "Read versioned original text within a token budget. Small file: doc only. Expand a search hit: target + mode=context or section. Use next_cursor to continue partial output. Section boundaries are inferred; unknown boundaries are reported.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "Document name, as printed by folio_list or a search hit." },
        page: { type: "string", description: 'Page label: "12", "p.12", or "¶37".' },
        target: { type: "string", description: 'Exact citation position, e.g. "p.12:L3", "¶4:L1".' },
        mode: { type: "string", enum: ["document", "page", "context", "section"], description: "Default page when page/target is supplied; otherwise document." },
        before: { type: "integer", minimum: 0, maximum: 100, description: "Context lines before target, default 2." },
        after: { type: "integer", minimum: 0, maximum: 100, description: "Context lines after target, default 2." },
        version: { type: "string", description: "Version from the original search/read; refuses stale references." },
        maxTokens: { type: "integer", minimum: 512, maximum: 16000, description: "Output token budget including metadata, default 3000." },
        cursor: { type: "string", description: "next_cursor from folio_page; pass doc and cursor to continue." },
      },
      required: ["doc"],
      additionalProperties: false,
    },
  },
  {
    name: "folio_revise",
    description:
      "Propose one edit to a document line — it is recorded, not written. Give the citation of the line (p.12:L3 or ¶14:L1 from a search hit) and the new text. action=delete removes the line (plain text only). Refuses if the line does not exist. Use folio_revisions to review, folio_apply to commit.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "Document name." },
        target: { type: "string", description: 'Line citation: "p.12:L3" or "¶14:L1".' },
        text: {
          type: "string",
          description: "New text for that line (or the line to insert, with action=insert_after). Omit for action=delete.",
        },
        action: {
          type: "string",
          enum: ["replace", "insert_after", "delete"],
          description: "Default replace. delete is plain-text only.",
        },
        reason: { type: "string", description: "Why — shown to the human who reviews the list." },
        version: { type: "string", description: "Required version printed by the search/read that supplied target. Read again if stale." },
      },
      required: ["doc", "target", "version"],
      additionalProperties: false,
    },
  },
  {
    name: "folio_revisions",
    description:
      "The pending proposal list: what would change, on which line, and why. Nothing here has touched a file. Cheap.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "Restrict to one document." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "folio_apply",
    description:
      "Commit pending revisions — line by line for txt/md/csv, block by block for docx — with a backup first. Refuses pdfs, files outside the indexed folder, and lines that changed after the proposal (those come back as conflicts). Do not rewrite files yourself.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", description: "Document name (plain text or docx)." },
        ids: { type: "array", items: { type: "string" }, description: 'Only these revision ids, e.g. ["r1","r3"]. Default: all pending.' },
      },
      required: ["doc"],
      additionalProperties: false,
    },
  },
] as const;

export interface ToolOptions {
  /** Applying revisions writes files; it stays off unless the operator opts in. */
  allowWrite?: boolean;
}

export async function runTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
  options: ToolOptions = {},
): Promise<string> {
  if (name === "folio_list") {
    return formatList(await store.load());
  }

  if (name === "folio_outline") {
    const manifest = await store.load();
    const docArg = args.doc === undefined || args.doc === "" ? undefined : String(args.doc);
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    if (!docArg) {
      const entries = Object.values(manifest.docs).sort((a, b) => a.doc.localeCompare(b.doc));
      if (entries.length === 0) return "0 docs indexed — nothing to outline yet.";
      return entries.map((e) => `${e.doc} · ${e.outline.length} sections`).join("\n");
    }
    const doc = (await resolveDoc(store, docArg)) ?? docArg;
    const entry = manifest.docs[doc];
    if (!entry) {
      return `no document "${docArg}" — call folio_list for the document list.`;
    }
    const checked = await evidence(store, entry);
    if (checked.status !== "ready") return `status=${checked.status} | ${entry.doc}\n${checked.warnings.join("\n")}`;
    return `${formatOutline(entry, { limit })}\nversion=${entry.revision}\n${checked.warnings.map((w) => `! ${w}`).join("\n")}`.trim();
  }

  if (name === "folio_revise") {
    if (typeof args.version !== "string" || !args.version) throw new Error("version_required: read/search the target and pass its version before proposing an edit");
    const docArg = String(args.doc ?? "");
    const doc = (await resolveDoc(store, docArg)) ?? docArg;
    const target = String(args.target ?? "");
    const raw = String(args.action ?? "replace");
    const action = raw === "insert_after" ? "insert_after" : raw === "delete" ? "delete" : "replace";
    const text = action === "delete" ? "" : String(args.text ?? "");
    if (action !== "delete" && !text) throw new Error("no text — pass the replacement text");
    const rev = await addRevision(store, { doc, target, text, action, version: args.version, reason: String(args.reason ?? "") });
    const after = action === "delete" ? "(line removed)" : `+ "${rev.text}"`;
    return `proposed ${rev.id} — ${rev.doc}:${rev.target} ${rev.action} [version=${rev.version}]\n  - "${rev.before}"\n  ${after}\nnot written yet: review with folio_revisions, commit with folio_apply.`;
  }

  if (name === "folio_revisions") {
    const docArg = args.doc === undefined ? undefined : String(args.doc);
    const doc = docArg ? ((await resolveDoc(store, docArg)) ?? docArg) : undefined;
    return formatRevisions(await listRevisions(store, doc), doc);
  }

  if (name === "folio_apply") {
    if (!options.allowWrite) {
      return "apply is disabled — the operator must start folio with --allow-apply. The proposal list is ready; hand it to a human instead of rewriting files.";
    }
    const docArg = String(args.doc ?? "");
    const doc = (await resolveDoc(store, docArg)) ?? docArg;
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : undefined;
    return formatApply(await applyRevisions(store, doc, ids));
  }

  if (name === "folio_search") {
    const query = String(args.query ?? "");
    const docArg = args.doc === undefined ? undefined : String(args.doc);
    const doc = docArg ? ((await resolveDoc(store, docArg)) ?? docArg) : undefined;
    return retrieveSearch(store, { ...args, query, doc });
  }

  if (name === "folio_page") {
    const docArg = String(args.doc ?? "");
    const doc = (await resolveDoc(store, docArg)) ?? docArg;
    return retrieveRead(store, doc, args);
  }

  throw new Error(`unknown tool: ${name}`);
}

export async function serve(
  store: Store,
  options: { version?: string; allowWrite?: boolean } = {},
): Promise<Server> {
  const server = new Server(
    { name: "folio", version: options.version ?? "0.1.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as never }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const text = await runTool(store, name, (args ?? {}) as Record<string, unknown>, {
        allowWrite: options.allowWrite,
      });
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `folio error: ${message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
