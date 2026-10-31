// 把 pi --mode json 的 jsonl 提炼成一行统计。
//
// 关键点：pi 的 `agent_end` 每轮都会发一次（一次工具调用 = 一个 agent_end），
// 只有最后一个 agent_end 里才有最终回答；而 `message_end` 是每个消息一条，
// 带完整 usage/durationMs，所以统计一律走 message_end。
import fs from "node:fs";

export function summarize(file) {
  const evs = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      evs.push(JSON.parse(line));
    } catch {}
  }

  const tools = [];
  const reads = new Set();
  let retrievalCalls = 0, repeatedReads = 0;
  let turns = 0;
  let retries = 0;
  let system = null;
  const assistant = [];

  for (const e of evs) {
    if (e.type === "tool_execution_start") {
      tools.push({ name: e.toolName, args: e.args });
      if (/folio_(search|page|outline|list)/.test(e.toolName)) {
        retrievalCalls++;
        const key = e.toolName + JSON.stringify(e.args, Object.keys(e.args ?? {}).sort());
        if (reads.has(key)) repeatedReads++;
        reads.add(key);
      }
    }
    else if (e.type === "turn_end") turns++;
    else if (e.type === "auto_retry_start") retries++;
    else if (e.type === "message_end") {
      const m = e.message;
      if (!m) continue;
      if (m.role === "system") system = m;
      if (m.role === "assistant") assistant.push(m);
    }
  }

  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let peak = 0;
  const stopReasons = [];
  for (const m of assistant) {
    const u = m.usage ?? {};
    for (const k of Object.keys(sum)) sum[k] += u[k] ?? 0;
    peak = Math.max(peak, (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
    if (m.stopReason) stopReasons.push(m.stopReason);
  }

  // An intermediate "let me inspect it" is not a final answer. In particular,
  // an HTTP 429 after a tool call must not score as a successful scan refusal.
  const final = assistant.at(-1);
  const completed = final?.stopReason === "stop";
  const answer = completed ? (final.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("") : "";

  const durationMs = assistant.reduce((a, m) => a + (m.durationMs ?? 0), 0);
  const systemChars = (system?.content ?? "").length;
  const systemToolTokens = 0;

  return {
    file,
    turns,
    toolCalls: tools.length,
    retrievalCalls,
    repeatedReads,
    tools,
    retries,
    promptTokens: sum.input + sum.cacheRead + sum.cacheWrite,
    inputTokens: sum.input,
    cacheReadTokens: sum.cacheRead,
    outputTokens: sum.output,
    reasoningTokens: sum.reasoning,
    peakContext: peak,
    durationMs,
    systemChars,
    systemSections: system?.sections ?? null,
    systemTools: (system?.toolsAdded ?? []).map((t) => t.name ?? t),
    stopReasons,
    answer,
    completed,
    rateLimited: assistant.some((m) => m.stopReason === "error" && /429|请求数限制/.test(m.errorMessage ?? "")),
  };
}

// 打分前先归一化：空格/全角标点/「第 12 页」与「p.12」视为同一种引用
export function norm(s) {
  return String(s ?? "")
    // markdown emphasis would otherwise hide "第 **45** 页" from every check below
    .replace(/[*_`]+/g, "")
    .replace(/[\u3000\s]+/g, "")
    .replace(/[，,]/g, "")
    .replace(/第([0-9０-９]+)页/g, (_, n) => "p." + n.replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10)))
    .replace(/\b[pP]\.?\s*([0-9]+)\b/g, "p.$1")
    .replace(/[（）()【】\[\]「」"'"']/g, "");
}

export function scoreRec(rec) {
  const a = norm(rec.answer);
  const keys = rec.expectKeys ?? [];
  const hit = keys.filter((k) => a.includes(norm(k)));
  return { hit, acc: keys.length ? hit.length / keys.length : 0, empty: !String(rec.answer ?? "").trim() };
}

if (process.argv[1] && process.argv[1].endsWith("stat.mjs")) {
  for (const f of process.argv.slice(2)) {
    const s = summarize(f);
    console.log(
      `${s.file}\n  turns=${s.turns} tools=${s.toolCalls} prompt=${s.promptTokens} (in=${s.inputTokens} cache=${s.cacheReadTokens}) out=${s.outputTokens} peak=${s.peakContext} sysChars=${s.systemChars} ${Math.round(s.durationMs / 1000)}s\n  tools: ${s.systemTools.join(",")}\n  answer: ${s.answer.slice(0, 200).replace(/\n/g, " ")}`,
    );
  }
}
