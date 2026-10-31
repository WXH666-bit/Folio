import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { summarize, scoreRec } from "./ab/stat.mjs";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "tmp");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(fs.mkdtempSync(path.join(dir, "stat-")), "events.jsonl");
const message = (stopReason, text, extra = {}) => ({ type: "message_end", message: {
  role: "assistant", stopReason, content: [{ type: "text", text }], ...extra,
} });
const events = [message("toolUse", "扫描件，准备继续读取"), message("error", "", { errorMessage: "HTTP 429" })];
fs.writeFileSync(file, events.map(JSON.stringify).join("\n"));
let result = summarize(file);
assert.equal(result.answer, ""); assert.equal(result.completed, false); assert.equal(result.rateLimited, true);
assert.equal(scoreRec({ ...result, expectKeys: ["扫描"] }).acc, 0);
events.push(message("stop", "扫描件没有文本层，无法确认出席人数。"));
events.push({ type: "tool_execution_start", toolName: "mcp__folio__folio_page", args: { doc: "x", page: "1" } });
events.push({ type: "tool_execution_start", toolName: "mcp__folio__folio_page", args: { page: "1", doc: "x" } });
fs.writeFileSync(file, events.map(JSON.stringify).join("\n"));
result = summarize(file);
assert.equal(result.completed, true); assert.equal(result.retrievalCalls, 2); assert.equal(result.repeatedReads, 1);
assert.equal(scoreRec({ ...result, expectKeys: ["扫描"] }).acc, 1);
console.log("OK — benchmark final-answer, rate-limit and repeated-read regression (8 assertions)");
