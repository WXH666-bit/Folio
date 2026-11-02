export type Stage = "inbox" | "search" | "evidence" | "draft" | "approval" | "delivery";
export const STAGES: { id: Stage; title: string; subtitle: string; number: string }[] = [
  { id: "inbox", title: "收件台", subtitle: "把文档交给小π", number: "01" },
  { id: "search", title: "检索室", subtitle: "从文件里寻找线索", number: "02" },
  { id: "evidence", title: "证据台", subtitle: "每个结论都有出处", number: "03" },
  { id: "draft", title: "改稿台", subtitle: "先提建议，不动原文", number: "04" },
  { id: "approval", title: "确认印章", subtitle: "最后一笔，由你决定", number: "05" },
  { id: "delivery", title: "出件口", subtitle: "带着结果，准备出发", number: "06" },
];
export type DocumentKind = "pdf" | "docx" | "text" | "pptx" | "xlsx" | "html";
export type EditAction = "replace" | "insert_after" | "delete";
export interface DocumentInfo {
  id: string; name: string; kind: DocumentKind; size: number; uploadedAt: string;
  status: "ready" | "no_text" | "parse_failed" | "index_unavailable";
  warnings: string[]; units: number; unitKind: "page" | "block" | "slide" | "sheet";
  version?: string; editableActions: EditAction[];
}
export interface WorkspaceInfo { id: string; name: string; demo: boolean; documents: DocumentInfo[]; }
export interface ModelSettings { baseUrl: string; model: string; hasKey: boolean; }
export interface Reference {
  docId: string; doc: string; label: string; line: number; target: string; version: string; text: string;
}
export interface Draft {
  id: string; doc: string; docId: string; target: string; action: EditAction; before: string; text: string;
  reason: string; version?: string; status: "pending" | "applied" | "conflict" | "discarded";
  canApply: boolean;
}
export type RunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";
export interface FlowEvent {
  seq: number; runId: string; at: string; type: string; stage?: Stage;
  state?: "running" | "done" | "error" | "waiting"; message?: string; detail?: string;
  toolCallId?: string; tool?: string; args?: Record<string, unknown>; references?: Reference[];
  text?: string; inputTokens?: number; outputTokens?: number;
}
export interface RunInfo {
  id: string; workspaceId: string; kind: "task" | "upload"; message: string; createdAt: string;
  status: RunStatus; answer: string; error?: string; events: FlowEvent[];
  inputTokens: number; outputTokens: number;
  revisionKeys: { doc: string; id: string }[];
  outcome?: "answer" | "proposals" | "written" | "discarded" | "partial";
}
export interface Preview { doc: DocumentInfo; text: string; labels: string[]; label: string; truncated: boolean; lines: { label: string; line: number; text: string }[]; }
export const ACCEPT = ".pdf,.docx,.pptx,.xlsx,.html,.htm,.txt,.md,.csv,.log";
export const EXAMPLES = [
  { title: "找一条有出处的答案", text: "技术规范里的全量备份多久一次、保留多少天？请注明文件和页码。", kind: "query" },
  { title: "给报销制度改个稿", text: "把《财税_报销制度》里的报销时限从 30 日内改成 15 日内。先生成修改建议，等我确认后写回。", kind: "edit" },
  { title: "让作废记录退场", text: "找出《技术_值班记录》中的作废记录，提出删除这一整行的修改建议，等我确认。", kind: "delete" },
];
