#!/usr/bin/env node
/**
 * CLI.
 *
 * Two long-lived shapes, one short one:
 *   folio start        index once, then watch + serve MCP over stdio (the normal entry)
 *   folio watch        index once, then keep the index fresh (no MCP)
 *   folio index|search|page|list|report    one-shot, for humans
 *
 * Rule: stdout belongs to the MCP protocol. Every human-facing message in
 * `start`/`serve` goes to stderr.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { indexAll } from "./indexer.js";
import { formatApply, formatList, formatOutline, formatPage, formatRevisions, formatSearch } from "./format.js";
import { sectionAt } from "./outline.js";
import { addRevision, applyRevisions, listRevisions } from "./revisions.js";
import { readUnit, resolveDoc, searchDocs } from "./search.js";
import { buildReport } from "./report.js";
import { serve } from "./mcp.js";
import { Store } from "./store.js";
import { startWatcher } from "./watch.js";
import { runTool } from "./mcp.js";

interface Parsed {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [rawKey, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) {
        flags[rawKey] = inline;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[rawKey] = next;
          i += 1;
        } else {
          flags[rawKey] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  const command = positional.shift() ?? "help";
  return { command, positional, flags };
}

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function num(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function context(flags: Record<string, string | boolean>): Store {
  const root = path.resolve(str(flags, "root") ?? process.cwd());
  const home = path.resolve(str(flags, "home") ?? path.join(root, ".folio"));
  return new Store(root, home);
}

const HELP = `folio — page-tagged document search for agents

usage
  folio start                    index, then watch for changes and serve MCP over stdio
  folio watch                    index, then keep the index fresh
  folio serve                    serve MCP over stdio (index must exist)
  folio index [--force]          build or refresh the index
  folio list                     what is indexed
  folio outline [doc]            table of contents (headings + page)
  folio search "words" [--doc N] [--limit 20] [--regex]
  folio page <doc> [page] [--mode document|page|context|section] [--target p.12:L3]
  folio revise <doc> <target> "text" --version <version>   propose an edit
  folio revisions [doc]          review the proposal list
  folio apply <doc> [--ids ...]  commit proposals to a plain-text file (needs --allow-apply)
  folio report "words"           token cost: full read vs folio

flags
  --root <dir>   folder with the documents (default: cwd)
  --home <dir>   index location (default: <root>/.folio)
  --allow-apply  let folio_apply / folio apply write files (plain text only)
  --max-tokens N  search/page output budget, 512..16000 (o200k_base estimate)
  --cursor TEXT  continue search/page; preserve search query and doc scope
  --version ID   verify a reference's version on page/revise
  --before N --after N   context lines around a target (default 2 each)

wire it into a client
  { "mcpServers": { "folio": { "command": "folio", "args": ["start", "--root", "D:/contracts"] } } }
`;

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const store = context(flags);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;

    case "index": {
      const summary = await indexAll(store, store.root, { force: flags.force === true });
      const parts = [
        `${summary.indexed} indexed`,
        `${summary.skipped} unchanged`,
      ];
      if (summary.failed) parts.push(`${summary.failed} failed`);
      process.stdout.write(`${parts.join(" · ")} · ${summary.ms} ms\n`);
      for (const warning of summary.warnings) process.stdout.write(`  ! ${warning}\n`);
      if (summary.indexed === 0 && summary.skipped === 0) {
        process.stdout.write(
          `no supported files under ${store.root} (pdf, docx, pptx, xlsx, html, txt, md, csv)\n`,
        );
      }
      return;
    }

    case "list": {
      process.stdout.write(`${formatList(await store.load())}\n`);
      return;
    }

    case "search": {
      const query = positional.join(" ");
      const docArg = str(flags, "doc");
      const doc = docArg ? ((await resolveDoc(store, docArg)) ?? docArg) : undefined;
      process.stdout.write(`${await runTool(store, "folio_search", {
        query, limit: num(flags, "limit"), doc, regex: flags.regex === true,
        maxTokens: num(flags, "max-tokens"), cursor: str(flags, "cursor"),
      })}\n`);
      return;
    }

    case "outline": {
      const manifest = await store.load();
      const docArg = positional[0];
      if (!docArg) {
        const entries = Object.values(manifest.docs).sort((a, b) => a.doc.localeCompare(b.doc));
        if (entries.length === 0) {
          process.stdout.write("0 docs indexed — nothing to outline yet.\n");
          return;
        }
        process.stdout.write(`${entries.map((e) => `${e.doc} · ${e.outline.length} sections`).join("\n")}\n`);
        return;
      }
      const doc = (await resolveDoc(store, docArg)) ?? docArg;
      const entry = manifest.docs[doc];
      if (!entry) {
        process.stderr.write(`no document "${docArg}"\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${formatOutline(entry, { limit: num(flags, "limit") })}\n`);
      return;
    }

    case "revise": {
      const [docArg, target, ...rest] = positional;
      if (!docArg || !target || rest.length === 0) {
        process.stderr.write('usage: folio revise <doc> <target> "new text" [--reason "..."] [--insert]\n');
        process.exitCode = 1;
        return;
      }
      const doc = (await resolveDoc(store, docArg)) ?? docArg;
      const output = await runTool(store, "folio_revise", {
        doc,
        target,
        text: rest.join(" "),
        action: flags.insert === true ? "insert_after" : "replace",
        reason: str(flags, "reason") ?? "",
        version: str(flags, "version"),
      });
      process.stdout.write(`${output}\n`);
      return;
    }

    case "revisions": {
      const docArg = positional[0];
      const doc = docArg ? ((await resolveDoc(store, docArg)) ?? docArg) : undefined;
      process.stdout.write(`${formatRevisions(await listRevisions(store, doc), doc)}\n`);
      return;
    }

    case "apply": {
      const docArg = positional[0];
      if (!docArg) {
        process.stderr.write("usage: folio apply <doc> [--ids r1,r2] --allow-apply\n");
        process.exitCode = 1;
        return;
      }
      if (flags["allow-apply"] !== true) {
        process.stderr.write(
          "refusing to write: pass --allow-apply (edits are a proposal list until someone commits them)\n",
        );
        process.exitCode = 1;
        return;
      }
      const doc = (await resolveDoc(store, docArg)) ?? docArg;
      const ids = str(flags, "ids")?.split(",").map((s) => s.trim()).filter(Boolean);
      process.stdout.write(`${formatApply(await applyRevisions(store, doc, ids))}\n`);
      return;
    }

    case "page": {
      const [docArg, pageArg] = positional;
      if (!docArg) {
        process.stderr.write("usage: folio page <doc> [page]\n");
        process.exitCode = 1;
        return;
      }
      const doc = (await resolveDoc(store, docArg)) ?? docArg;
      process.stdout.write(`${await runTool(store, "folio_page", {
        doc, page: pageArg, mode: str(flags, "mode"), target: str(flags, "target"),
        before: num(flags, "before"), after: num(flags, "after"), maxTokens: num(flags, "max-tokens"),
        cursor: str(flags, "cursor"), version: str(flags, "version"),
      })}\n`);
      return;
    }

    case "report": {
      const query = positional.join(" ");
      if (!query) {
        process.stderr.write('usage: folio report "words"\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${await buildReport(store, query)}\n`);
      return;
    }

    case "watch": {
      const summary = await indexAll(store, store.root);
      process.stderr.write(`folio: ${summary.indexed} indexed, ${summary.skipped} unchanged\n`);
      const watcher = startWatcher(store, store.root, {
        ignoreInitial: true,
        onEvent: (event) => {
          process.stderr.write(`folio: ${event.action} ${event.doc}${event.note ? ` (${event.note})` : ""}\n`);
        },
      });
      await new Promise<void>((resolve) => {
        const stop = () => {
          void watcher.close().then(resolve);
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      });
      return;
    }

    case "serve": {
      const server = await serve(store, { allowWrite: flags["allow-apply"] === true });
      server.onclose = () => process.exit(0);
      return;
    }

    case "start": {
      await fs.mkdir(store.home, { recursive: true });
      const summary = await indexAll(store, store.root);
      process.stderr.write(
        `folio: ${summary.indexed} indexed, ${summary.skipped} unchanged, ${summary.ms} ms · watching ${store.root}\n`,
      );
      for (const warning of summary.warnings) process.stderr.write(`folio: ! ${warning}\n`);
      startWatcher(store, store.root, {
        ignoreInitial: true,
        onEvent: (event) => {
          if (event.action === "error") {
            process.stderr.write(`folio: error ${event.doc} ${event.note ?? ""}\n`);
          }
        },
      });
      const server = await serve(store, { allowWrite: flags["allow-apply"] === true });
      server.onclose = () => process.exit(0);
      return;
    }

    default:
      process.stderr.write(`unknown command "${command}"\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`folio: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
