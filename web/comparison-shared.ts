import type { Draft, FlowEvent, Stage } from "./shared.js";

export type Arm = "native" | "folio";
export type ArmStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";
export interface ComparedFile { id: string; name: string; kind: string; size: number; hash: string; sourceVersion?: string; }
export interface ComparisonEvent extends FlowEvent {
  comparisonId: string; arm: Arm; originalSeq: number; originalAt: string;
  returnedChars?: number; toolMs?: number; indexMs?: number;
  armStatus?: ArmStatus;
}
export interface FileChange { name: string; status: "unchanged" | "modified" | "deleted" | "added"; before?: string; after?: string; supported: boolean; }
export interface ArmResult {
  runId: string; status: ArmStatus; answer: string; error?: string; startedAt?: string; endedAt?: string;
  inputTokens: number; outputTokens: number; indexMs: number; confirmationMs: number;
  toolCalls: number; returnedChars: number; toolMs: number; changes: FileChange[];
  awaitingSince?: string;
}
export interface Comparison {
  id: string; title: string; message: string; createdAt: string; model: string; piVersion: "1.4.0";
  sourceWorkspace?: string; status: ArmStatus; files: ComparedFile[]; arms: Record<Arm, ArmResult>;
  events: ComparisonEvent[]; replayOnly?: boolean; demoKey?: string; sourceVersion: string;
  verification?: string; environment: string;
  downloads?: Partial<Record<Arm,Record<string,string>>>;
  recordingVersion?: string;
  runtime?: string;
}
export interface ComparisonSummary { id: string; title: string; createdAt: string; status: ArmStatus; replayOnly?: boolean; }
export interface Chapter { id: string; stage: Stage; visit: number; from: number; to: number; }
const stages: Stage[] = ["inbox","search","evidence","draft","approval","delivery"];
/** Presentation groups operations, never changes their original sequence or timestamps. */
export function chapters(events: ComparisonEvent[]): Chapter[] {
  const result: Chapter[]=[]; const visits=new Map<Stage,number>();
  for (const event of events) {
    if (!event.stage || !stages.includes(event.stage)) continue;
    const last=result.at(-1);
    if (last?.stage===event.stage) { last.to=event.seq; continue; }
    const visit=(visits.get(event.stage)??0)+1;visits.set(event.stage,visit);
    result.push({id:`${event.stage}-${event.seq}`,stage:event.stage,visit,from:event.seq,to:event.seq});
  }
  return result;
}
export function stageTotals(events: ComparisonEvent[], arm: Arm, stage: Stage) {
  const rows=events.filter(e=>e.arm===arm&&e.stage===stage);
  return { calls: rows.filter(e=>e.type==="tool_start").length, chars: rows.reduce((n,e)=>n+(e.returnedChars??0),0), ms: rows.reduce((n,e)=>n+(e.toolMs??0),0) };
}
export function statusAt(events:ComparisonEvent[],arm:Arm):ArmStatus {
  return events.findLast(e=>e.arm===arm&&e.armStatus)?.armStatus??(events.some(e=>e.arm===arm)?"running":"queued");
}
export function answerAt(events:ComparisonEvent[],arm:Arm):string {
  return events.filter(e=>e.arm===arm).reduce((text,e)=>e.type==="answer"?e.text??"":e.type==="answer_delta"?text+(e.text??""):text,"");
}
export const DEMO_TASKS = [
  { key:"pdf", title:"在 60 页里找到备份依据", message:"技术规范里的全量备份多久一次、保留多少天？请注明文件和页码。只查询，不修改文件。" },
  { key:"edit", title:"把报销期限改成 15 日", message:"把财税_报销制度.md 中报销期限从 30 日内改成 15 日内，只修改对应一行，保留其他全部内容。" },
  { key:"delete", title:"让作废记录退场", message:"删除技术_值班记录.csv 中事项为作废记录的那一整行，保留表头和其余所有记录。" },
] as const;
