// Extract review material and verify complete file edits, without another model call.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const root = path.resolve(import.meta.dirname,"../..");
const at=process.argv.indexOf("--runs");
const runs = path.resolve(root,at<0?"tests/tmp/native-comparison-2026-10-31-guarded":process.argv[at+1]);
const source = path.join(root,"tests/ab/corpus2");
const spec = JSON.parse(fs.readFileSync(path.join(root,"tests/ab/questions-native.json"),"utf8"));
const rows = JSON.parse(fs.readFileSync(path.join(runs,fs.existsSync(path.join(runs,"summary.json"))?"summary.json":"progress.json"),"utf8"));
const hash = p=>createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const canonical = text=>text.replace(/\r\n/g,"\n").trimEnd();
const reviews = rows.map(r=>{
  const q = spec.questions.find(q=>q.id===r.qid);
  let writeIntegrity = null;
  if(q.verify){
    const original = canonical(fs.readFileSync(path.join(source,q.verify.file),"utf8"));
    let expected;
    if(r.qid==="q11-update-md") expected=original.replace("30 日内","15 日内");
    else if(r.qid==="q12-insert-md") expected=original+"\nP6 供应商演练告警，不进入真实告警统计。";
    else if(r.qid==="q13-delete-csv") expected=original.split("\n").filter(line=>!line.startsWith("2025-09-04,")).join("\n");
    let actual = canonical(fs.readFileSync(path.join(r.workDir,q.verify.file),"utf8"));
    // Markdown permits an empty line before the appended paragraph; content must
    // otherwise match the entire expected file, rather than a few keywords.
    if(r.qid==="q12-insert-md") actual=actual.replace(/\n+(?=P6 供应商演练告警，不进入真实告警统计。$)/,"\n");
    const unrelatedChanges = fs.readdirSync(source).filter(f=>f!==q.verify.file).filter(f=>!fs.existsSync(path.join(r.workDir,f))||hash(path.join(source,f))!==hash(path.join(r.workDir,f)));
    writeIntegrity={expectedWholeFile:actual===expected,unrelatedDocumentsUnchanged:unrelatedChanges.length===0,unrelatedChanges,
      pass:actual===expected&&unrelatedChanges.length===0};
  }
  return {key:`${r.arm}|${r.qid}|${r.run}`,arm:r.arm,qid:r.qid,run:r.run,
    verdict:!r.completed||r.code!==0?"incomplete":"pending",citation:"pending",note:"",writeIntegrity,
    answer:r.answer,promptTokens:r.promptTokens,outputTokens:r.outputTokens,toolCalls:r.toolCalls,tools:r.tools};
});
fs.writeFileSync(path.join(runs,"review-material.json"),JSON.stringify(reviews,null,2)+"\n");
console.log(JSON.stringify(reviews.map(({answer,tools,...r})=>r),null,2));
