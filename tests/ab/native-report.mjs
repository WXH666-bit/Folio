// Generate an offline HTML report only from complete measured runs and reviewed outcomes.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { summarize } from "./stat.mjs";
const root=path.resolve(import.meta.dirname,"../..");
const at=process.argv.indexOf("--runs");
const runs=path.resolve(root,at<0?"tests/tmp/native-comparison-2026-10-31-guarded":process.argv[at+1]);
const manifest=JSON.parse(fs.readFileSync(path.join(runs,"manifest.json"),"utf8"));
const raw=JSON.parse(fs.readFileSync(path.join(runs,"summary.json"),"utf8"));
const spec=JSON.parse(fs.readFileSync(path.join(root,"tests/ab/questions-native.json"),"utf8"));
const expected={
  "q1-locate":"全量备份每周一次，保留 90 天；技术规范第 45 页。",
  "q4-summarize":"正式告警 P0–P4 共五级，最低 P4；P5 是演练标记，不计入真实告警统计。",
  "q9-scan":"五人：赵主任、陈默、王恺、李萌、刘倩。两页内容相同，不能重复计人数。",
  "q11-update-md":"报销制度第 7 行将 30 日内改为 15 日内，其他内容保持一致。",
  "q12-insert-md":"在原第 17–18 行的第四节末尾追加指定 P6 文字，原有内容完整保留。",
  "q13-delete-csv":"只删除原第 5 行的 2025-09-04 作废记录，保留表头及其他四条记录。"
};
const reviewDoc=JSON.parse(fs.readFileSync(path.join(root,"tests/ab/native-review.json"),"utf8"));
assert.equal(reviewDoc.runId,manifest.startedAt,"Manual reviews belong to a different run; review the new answers instead of reusing grades");
const audit=reviewDoc.reviews;
assert.equal(audit.length,36,"all outcomes must be manually reviewed");
assert.equal(new Set(audit.map(r=>r.key)).size,36,"duplicate manual review key");
const material=JSON.parse(fs.readFileSync(path.join(runs,"review-material.json"),"utf8"));
const pilot=[];
for(const name of ["native-comparison-2026-10-31","native-comparison-2026-10-31-final"]){const pilotRoot=path.join(root,"tests/tmp",name);for(const arm of ["A","B"]){const dir=path.join(pilotRoot,arm);if(!fs.existsSync(dir))continue;for(const file of fs.readdirSync(dir).filter(f=>f.endsWith(".jsonl"))){const r=summarize(path.join(dir,file));pilot.push({preflight:name,arm,file,promptTokens:r.promptTokens,outputTokens:r.outputTokens,completed:r.completed});}}}
const key=r=>`${r.arm}|${r.qid}|${r.run}`;
assert.equal(raw.length,36,"all 36 runs must be accounted for");
assert.equal(new Set(raw.map(key)).size,36,"duplicate run");
assert.ok(manifest.finishedAt,"runner has not finished");
const reviewed=raw.map(r=>{
  const manual=audit.find(a=>a.key===key(r));
  const verified=material.find(a=>a.key===key(r));
  assert.ok(manual,`missing review ${key(r)}`);
  assert.ok(verified,`missing integrity check ${key(r)}`);
  const review={...manual,writeIntegrity:verified.writeIntegrity};
  assert.ok(["pass","safe_abstention","fail","incomplete"].includes(review.verdict),`unreviewed outcome ${key(r)}`);
  assert.ok(["exact","issue","none","na"].includes(review.citation),`unreviewed citation ${key(r)}`);
  if(review.verdict==="pass") assert.ok(r.completed&&r.code===0);
  if(review.writeIntegrity) assert.ok(review.verdict!=="pass"||review.writeIntegrity.pass);
  const guardLog=path.join(path.dirname(r.workDir),"path-guard.jsonl");
  const events=fs.existsSync(guardLog)?fs.readFileSync(guardLog,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse):[];
  return {arm:r.arm,qid:r.qid,run:r.run,completed:r.completed,exitCode:r.code,rateLimited:r.rateLimited,
    promptTokens:r.promptTokens,outputTokens:r.outputTokens,cacheReadTokens:r.cacheReadTokens,
    toolCalls:r.toolCalls,wallMs:r.wallMs,indexMs:r.indexMs,tools:r.tools,answer:r.answer,
    literalCheck:r.acc,fileCheck:r.fileCheck,review,pathGuard:{remapped:events.filter(e=>e.remapped).length,blocked:events.filter(e=>e.blocked).length}};
});
for(const q of spec.questions) for(const arm of ["A","B"]) assert.equal(reviewed.filter(r=>r.qid===q.id&&r.arm===arm).length,3);
const sum=(rows,k)=>rows.reduce((n,r)=>n+(r[k]||0),0);
const median=(rows,k)=>[...rows].sort((a,b)=>(a[k]||0)-(b[k]||0))[Math.floor(rows.length/2)][k]||0;
const aggregate=rows=>({runs:rows.length,completed:rows.filter(r=>r.completed&&r.exitCode===0).length,
  goalCompleted:rows.filter(r=>r.review.verdict==="pass").length,safeAbstentions:rows.filter(r=>r.review.verdict==="safe_abstention").length,
  failures:rows.filter(r=>["fail","incomplete"].includes(r.review.verdict)).length,
  inputTokens:sum(rows,"promptTokens"),outputTokens:sum(rows,"outputTokens"),totalTokens:sum(rows,"promptTokens")+sum(rows,"outputTokens"),
  toolCalls:sum(rows,"toolCalls"),wallSeconds:sum(rows,"wallMs")/1000,indexSeconds:sum(rows,"indexMs")/1000,
  writesPassed:rows.filter(r=>r.review.writeIntegrity?.pass).length,writes:rows.filter(r=>r.review.writeIntegrity).length,
  goalWithUsableCitation:rows.filter(r=>r.review.verdict==="pass"&&r.review.citation==="exact").length,
  citationIssues:rows.filter(r=>r.review.citation==="issue").length,rateLimited:rows.filter(r=>r.rateLimited).length});
const A=aggregate(reviewed.filter(r=>r.arm==="A")),B=aggregate(reviewed.filter(r=>r.arm==="B"));
const common=[];
for(const q of spec.questions) for(const run of [1,2,3]){
  const a=reviewed.find(r=>r.arm==="A"&&r.qid===q.id&&r.run===run),b=reviewed.find(r=>r.arm==="B"&&r.qid===q.id&&r.run===run);
  if(a.review.verdict==="pass"&&b.review.verdict==="pass") common.push({qid:q.id,run,A:a.promptTokens,B:b.promptTokens});
}
const commonA=common.reduce((n,p)=>n+p.A,0),commonB=common.reduce((n,p)=>n+p.B,0);
const commonKinds=[...new Set(common.map(p=>spec.questions.find(q=>q.id===p.qid).kind))].join("、");
const perQuestion=spec.questions.map(q=>({id:q.id,kind:q.kind,question:q.q,expected:expected[q.id],
  arms:Object.fromEntries(["A","B"].map(arm=>{const rows=reviewed.filter(r=>r.arm===arm&&r.qid===q.id);return[arm,{...aggregate(rows),medianInputTokens:median(rows,"promptTokens"),medianSeconds:median(rows,"wallMs")/1000,medianTools:median(rows,"toolCalls")}];}))}));
const data={title:"Folio MCP 与原生 pi：隔离对照测试",startedAt:manifest.startedAt,finishedAt:manifest.finishedAt,
  model:manifest.model,piVersion:manifest.piVersion,sourceCommit:manifest.commit,sourceWorkingTree:"Product src unchanged; benchmark harness updated for isolation and review.",
  protocol:{questions:6,repeats:3,runsPerArm:18,order:"paired, alternating order",concurrency:1,pauseSeconds:25,timeoutSeconds:180,runnerRetries:0,
    corpusDocuments:Object.keys(manifest.corpus).length,corpusHashes:manifest.corpus,questionHash:manifest.questionHash,
    inputTokens:"Provider-reported cumulative input + cacheRead + cacheWrite over all calls; recorded failure usage included. In-flight requests without returned usage cannot be measured.",
    outputTokens:"Provider-reported cumulative output; token counts are not currency costs.",
    verdict:"Manual review against source; safe scan abstention reported separately from accomplishing the requested identification. Write integrity ignores only trailing newlines and optional blank lines immediately before the inserted Markdown paragraph.",
    sharedTools:"Both arms retain native read/bash/edit/write and installed Python/PyMuPDF/RapidOCR. Folio itself does not provide OCR.",
    limitations:"Six synthetic tasks targeting PDF/Markdown/CSV, three repeats; descriptive sample, no statistical significance claim. Same Windows OS tools, not an OS sandbox. Indexing time shown separately."},
  isolation:{configurationFilesChecked:Object.keys(manifest.personalConfigBefore).length,personalConfigUnchanged:manifest.personalConfigUnchanged,
    corpusUnchanged:manifest.corpusUnchanged,description:manifest.isolation+" Both arms also load the same pi-isolation-guard.mjs to remap literal /tmp and block pi paths/file-tool escapes."},
  excludedPilot:"Two preflights were stopped: --no-extensions disables pi's built-in MCP, and environment variables alone do not remap hard-coded /tmp paths. Both excluded preflights are retained under tests/tmp; formal runs apply the same tool-input guard to both arms.",
  pilotRecordedUsage:pilot,
  nativeTextProbe:{pythonStdoutEncoding:"gbk",technicalPdfPages:60,page45TextCharacters:320,backupKeywordExtractable:true,
    note:"Independent read-only PyMuPDF probe confirmed the locating PDF has usable text; agent console-decoding failures do not mean the PDF requires OCR."},
  totals:{A,B},jointlyCompletedPairs:{pairs:common,inputTokens:{A:commonA,B:commonB}},perQuestion,runs:reviewed};
fs.writeFileSync(path.join(root,"tests/ab/native-results.json"),JSON.stringify(data,null,2)+"\n");
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=n=>Math.round(n).toLocaleString("en-US");
const pct=(a,b)=>a===b?"持平":!a?"原生为 0，比例不可比":`${b<a?"减少":"增加"} ${Math.abs((b/a-1)*100).toFixed(1)}%`;
const label={pass:"完成目标",safe_abstention:"合理拒答",fail:"未达目标",incomplete:"未完成"};
const cite={exact:"引用可核对",issue:"引用有问题",none:"缺少引用",na:"不适用"};
const failureDetails=reviewed.filter(r=>r.review.verdict!=="pass"||r.review.citation==="issue");
const outline=perQuestion.map(q=>{
  const a=q.arms.A,b=q.arms.B;
  return `<tr><th scope="row"><a href="#${q.id}">${esc(q.kind)}</a></th><td>${fmt(a.medianInputTokens)}</td><td>${fmt(b.medianInputTokens)}</td><td>${esc(pct(a.medianInputTokens,b.medianInputTokens))}</td><td>${a.goalCompleted}/3 → ${b.goalCompleted}/3</td></tr>`;
}).join("");
const metrics=[ ["累计输入 token",fmt(A.inputTokens),fmt(B.inputTokens)], ["累计输出 token",fmt(A.outputTokens),fmt(B.outputTokens)],
 ["输入 + 输出 token",fmt(A.totalTokens),fmt(B.totalTokens)], ["工具调用",A.toolCalls,B.toolCalls], ["正常结束",`${A.completed}/18`,`${B.completed}/18`],
 ["完成用户目标",`${A.goalCompleted}/18`,`${B.goalCompleted}/18`], ["扫描件合理拒答",A.safeAbstentions,B.safeAbstentions],
 ["完成目标且引用位置正确",`${A.goalWithUsableCitation}/18`,`${B.goalWithUsableCitation}/18`],
 ["完整写盘校验",`${A.writesPassed}/${A.writes}`,`${B.writesPassed}/${B.writes}`], ["引用有问题的回答",A.citationIssues,B.citationIssues],
 ["任务累计耗时",`${fmt(A.wallSeconds)} 秒`,`${fmt(B.wallSeconds)} 秒`], ["预索引耗时（另计）",`${fmt(A.indexSeconds)} 秒`,`${fmt(B.indexSeconds)} 秒`]
].map(([k,a,b])=>`<tr><th scope="row">${k}</th><td>${a}</td><td>${b}</td></tr>`).join("");
const chartMax=Math.max(A.inputTokens,B.inputTokens);
const chartCss=`.barplot{margin:22px 0 16px;font-variant-numeric:tabular-nums}.bar-row{display:grid;grid-template-columns:78px minmax(0,1fr) 76px;gap:8px;align-items:center;font-size:13px;margin:18px 0}.bar-row b{font-weight:400;text-align:right}.track{height:18px}.track i{display:block;height:100%}.axis{display:flex;justify-content:space-between;margin:0 84px 0 86px;font-size:11px;color:#606060;border-top:1px solid #ddd;padding-top:6px}`;
const chart=`<div class="barplot" aria-label="累计输入 token 对比">
<div class="bar-row"><span>原生 pi</span><div class="track"><i style="width:${100*A.inputTokens/chartMax}%;background:#999"></i></div><b>${fmt(A.inputTokens)}</b></div>
<div class="bar-row"><span>Folio MCP</span><div class="track"><i style="width:${100*B.inputTokens/chartMax}%;background:#1d5fbf"></i></div><b>${fmt(B.inputTokens)}</b></div>
<div class="axis"><span>0</span><span>${fmt(chartMax)}</span></div></div>`;
const details=perQuestion.map(q=>`<details class="case" id="${q.id}" data-kind="${esc(q.kind)}"><summary>${esc(q.kind)}<span>原生 ${q.arms.A.goalCompleted}/3 · Folio ${q.arms.B.goalCompleted}/3 完成目标</span></summary><p>${esc(q.question)}</p><p class="meta">核验基准：${esc(q.expected)}</p>
${[1,2,3].map(run=>`<h3>第 ${run} 次</h3><div class="pair">${["A","B"].map(arm=>{const r=reviewed.find(r=>r.qid===q.id&&r.run===run&&r.arm===arm);return`<article><h4>${arm==="A"?"原生 pi":"Folio MCP"} · ${label[r.review.verdict]}</h4><p class="answer">${esc(r.answer||"没有正常完成的最终回答。")}</p><p class="meta">输入 ${fmt(r.promptTokens)} · 输出 ${fmt(r.outputTokens)} token · ${r.toolCalls} 次工具 · ${(r.wallMs/1000).toFixed(1)} 秒</p><p>${cite[r.review.citation]}。${esc(r.review.note)}</p>${r.review.writeIntegrity?`<p class="meta">整份目标文件符合预期：${r.review.writeIntegrity.expectedWholeFile?"是":"否"}；其余文档未变：${r.review.writeIntegrity.unrelatedDocumentsUnchanged?"是":"否"}。</p>`:""}</article>`;}).join("")}</div>`).join("")}</details>`).join("");
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${data.title}</title><style>
:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#252525;background:#f4f5f6;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:auto;padding:32px 32px 44px}header{display:flex;align-items:baseline;justify-content:space-between;gap:16px}h1{font-size:26px;line-height:1.35;margin:0 0 12px;font-weight:600}h2{font-size:18px;margin:0 0 16px}h3{font-size:15px;margin:24px 0 10px}h4{font-size:14px;margin:0 0 10px}p{font-size:14px;line-height:1.8;margin:8px 0}a{color:inherit;text-underline-offset:3px}nav{font-size:13px;white-space:nowrap;display:flex;gap:16px}.scope,.meta{color:#606060;font-size:12px;line-height:1.7}.intro{max-width:58em;margin:8px 0 22px}.finding{font-size:20px;line-height:1.5;font-weight:500;margin:0 0 8px}.overview{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:20px}.panel{background:#fff;border:1px solid #ddd;border-radius:8px;padding:22px;min-width:0}section{margin-top:22px}svg{width:100%;height:auto;margin:16px 0 4px;font:14px Arial,"Microsoft YaHei",sans-serif}table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}caption{text-align:left;font-size:12px;color:#606060;padding-bottom:10px}th,td{padding:10px 5px;border-bottom:1px solid #e3e3e3;text-align:right;vertical-align:top}th{font-weight:400;color:#606060}th:first-child{text-align:left}thead th{font-size:12px}tr:last-child th,tr:last-child td{border-bottom:0}.quality{margin:10px 0 0;padding:0 0 0 18px;font-size:13px;line-height:1.9}.notes{display:grid;grid-template-columns:1fr 1fr;gap:20px}.toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.toolbar h2{margin:0}button{border:1px solid #bbb;border-radius:6px;padding:8px 12px;background:#fff;color:#252525;cursor:pointer;font:inherit;font-size:13px}button:hover{background:#eee}button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid #252525;outline-offset:4px}.case{background:white;border:1px solid #ddd;border-radius:8px;padding:0 18px;margin:10px 0;scroll-margin-top:16px}.case>summary{padding:16px 0;cursor:pointer;font-size:14px;font-weight:600}.case>summary span{float:right;font-size:12px;color:#606060;font-weight:400}.case[open]{padding-bottom:18px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}.pair article+article{border-left:1px solid #ddd;padding-left:24px}.answer{white-space:pre-wrap;overflow-wrap:anywhere}.case p:last-child{margin-bottom:0}.warning{color:#973621}.empty{color:#606060}footer{font-size:12px;line-height:1.8;color:#606060;margin-top:26px;border-top:1px solid #d2d2d2;padding-top:16px}code{font-size:12px;overflow-wrap:anywhere}ul{padding-left:18px}li{font-size:13px;line-height:1.9}.table-wrap{overflow-x:auto}
@media(max-width:780px){main{padding:24px 18px}.overview,.notes{grid-template-columns:1fr}header{display:block}nav{margin-bottom:18px}.panel{padding:18px}.pair{grid-template-columns:1fr;gap:14px}.pair article+article{border-left:0;border-top:1px solid #ddd;padding:14px 0 0}.case>summary span{float:none;display:block;margin-top:5px}h1{font-size:23px}.finding{font-size:18px}.wide{min-width:520px}}
</style></head><body><main><header><div><p class="scope">Folio / 2026-10-31 / 隔离对照测试</p><h1>Folio MCP 与原生 pi</h1></div><nav aria-label="报告导航"><a href="#overview">结果</a><a href="#cases">逐次答案</a><a href="#method">测试方法</a></nav></header>
<p class="intro">同一模型、同一批 26 份文档，六类任务各跑三次。原生组关闭 MCP；Folio 组接入当前版本，保留相同的原生工具。</p>
<div class="overview" id="overview"><section class="panel" style="margin-top:0"><h2>本轮观察</h2><p class="finding">启用 Folio 后，累计输入 token ${pct(A.inputTokens,B.inputTokens)}。</p><p>完成用户目标：原生 pi ${A.goalCompleted}/18，Folio ${B.goalCompleted}/18。合理拒答单独计数，失败和超时的已记录消耗也计入。</p>${chart}<p class="meta">输入 token 含缓存读取，是各次模型请求的累加；不是单次上下文大小，也不是人民币费用。超时前未返回用量的在途请求无法计量。</p><ul class="quality"><li>完整写盘：原生 ${A.writesPassed}/${A.writes}，Folio ${B.writesPassed}/${B.writes}。</li><li>扫描件合理拒答：原生 ${A.safeAbstentions} 次，Folio ${B.safeAbstentions} 次。</li><li>人工复核发现引用问题：原生 ${A.citationIssues} 次，Folio ${B.citationIssues} 次。</li></ul></section>
<section class="panel" style="margin-top:0"><h2>全部运行汇总</h2><table><thead><tr><th>指标</th><th>原生 pi</th><th>Folio MCP</th></tr></thead><tbody>${metrics}</tbody></table></section></div>
<section class="panel"><h2>逐题比较</h2><div class="table-wrap"><table class="wide"><caption>每格 3 次，token 显示中位数；“完成目标”是人工核验结果。</caption><thead><tr><th>任务</th><th>原生输入 token</th><th>Folio 输入 token</th><th>Folio 相对原生</th><th>完成目标</th></tr></thead><tbody>${outline}</tbody></table></div><p>另看双方都完成目标的 ${common.length} 对任务：原生输入 ${fmt(commonA)}、Folio 输入 ${fmt(commonB)} token，Folio ${pct(commonA,commonB)}。这只是共同完成的子集，不替代全部样本。</p><p class="meta">扫描件拒答代表如实说明能力限制，不算识别出了出席名单。三次重复只用于观察波动，本报告不作统计显著性推断。</p></section>
<section class="notes" id="method"><div class="panel"><h2>隔离与公平性</h2><ul><li>每次新建 pi 配置目录、用户主目录、缓存和临时目录，并复制全新语料。</li><li>两组关闭会话保存、项目指令、技能和提示模板；隔离目录中没有个人扩展。pi 的内置扩展保留，以支持 MCP。</li><li>个人 pi 配置 ${data.isolation.configurationFilesChecked} 份文件指纹：${data.isolation.personalConfigUnchanged?"前后一致":"存在变化，需复核"}；原始语料：${data.isolation.corpusUnchanged?"前后一致":"存在变化，需复核"}。</li><li>这是配置与工作目录隔离，未使用操作系统级文件访问沙箱。</li></ul></div><div class="panel"><h2>如何读这些结果</h2><ul><li>模型：${esc(manifest.model)}；pi ${manifest.piVersion}。</li><li>36 次交错串行运行，题间暂停 25 秒；单题上限 180 秒，不自动重跑。</li><li>写入题比对整份目标文件，并核对其余文档；最终答案与引用另作人工复核。</li><li>Folio 的预索引时间另列；任务耗时包含 pi 启动和模型/工具执行，不含题间暂停。</li><li>这是六道合成题的小样本，不能代表所有文件和所有任务。</li></ul></div></section>
<section class="panel"><h2>失败与限制</h2><p>${failureDetails.length?`有 ${failureDetails.length} 次运行需要留意，详见下面对应答案。` : "本轮未发现任务失败或引用错误。"} 网关限流记录：原生 ${A.rateLimited} 次，Folio ${B.rateLimited} 次。</p><p class="meta">原生组可能受当前 Windows 的中文控制台编码与 PDF 提取工具影响；本结果不能直接推广到已优化提取脚本或其他操作系统。180 秒上限造成的未完成，反映预算内完成能力，不能直接解释为事实回答错误。</p><p class="meta">初次环境预运行因扩展开关配置问题停止，额外记录输入 ${fmt(pilot.reduce((n,r)=>n+r.promptTokens,0))}、输出 ${fmt(pilot.reduce((n,r)=>n+r.outputTokens,0))} token，未混入正式 36 次对照。正式测试期间产品代码保持不变；报告只反映当前版本相对不用 MCP 的效果。</p></section>
<section id="cases"><div class="toolbar"><h2>逐次答案与核验</h2><button type="button" id="toggle">展开全部</button></div>${details}</section>
<footer>数据来自实际 pi 运行，没有把未完成任务的中间说明当作最终答案。<br><a href="tests/ab/native-results.json">下载完整统计与人工核验数据</a> · 复现入口：<code>node tests/ab/native-comparison.mjs</code> · 报告生成：<code>node tests/ab/native-report.mjs</code><br>源代码提交：${esc(manifest.commit.slice(0,12))}。运行始末：${esc(manifest.startedAt)} 至 ${esc(manifest.finishedAt)}。</footer>
</main><script>const button=document.getElementById('toggle');button.addEventListener('click',()=>{const open=button.textContent==='展开全部';document.querySelectorAll('.case').forEach(e=>e.open=open);button.textContent=open?'收起全部':'展开全部';});document.querySelectorAll('a[href^="#q"]').forEach(a=>a.addEventListener('click',()=>{document.querySelector(a.getAttribute('href')).open=true;}));</script></body></html>`;
const layoutCss="@media(max-width:780px){.wide{min-width:0;table-layout:fixed}.wide th,.wide td{padding:10px 2px;font-size:12px}.wide th:first-child{width:12%}}";
const page=html.replace("</style>",`${chartCss}${layoutCss}</style>`)
  .replace("<li>个人 pi 配置 ","<li>两组加载相同的路径限制扩展：硬编码 /tmp 重定向到私有目录，并拦截 pi 配置路径及文件工具越界。</li><li>个人 pi 配置 ")
  .replace("<li>人工复核发现引用问题：",`<li>双方均完成目标的 ${common.length} 对任务中，Folio 输入 token ${pct(commonA,commonB)}。</li><li>人工复核发现引用问题：`)
  .replace(/(<ul class="quality">[\s\S]*?<\/ul>)/,`$1<p>全部样本还包含失败与超时的消耗；共同完成子集只保留两组都完成目标的对应任务，组成不同。</p><p class="meta">本轮共同完成子集包括：${esc(commonKinds||"无")}。因此，总量下降不代表这些任务逐项都更便宜。具体过程见逐次答案。</p>`)
  .replace("<li>这是六道合成题的小样本", "<li>题目主要测 PDF、Markdown 和 CSV，未覆盖所有格式，也未模拟并发修改。</li><li>这是六道合成题的小样本")
  .replace("初次环境预运行因扩展开关配置问题停止", "环境预运行先后排查内置扩展开关与硬编码临时路径，已停止并排除");
fs.writeFileSync(path.join(root,"native-comparison.html"),page);
console.log(JSON.stringify({A,B,report:"native-comparison.html",personalConfigUnchanged:data.isolation.personalConfigUnchanged}));
