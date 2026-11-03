import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ACCEPT, EXAMPLES, STAGES, type DocumentInfo, type Draft, type FlowEvent, type ModelSettings, type Reference, type RunInfo, type Stage, type WorkspaceInfo } from "../shared";
import { api, post, contentUrl, unitName } from "./api";
import { Icon, Machine, PaperPi, RoughOutline } from "./art";
import { Modal, PreviewDialog, SettingsDialog } from "./dialogs";

interface Status { pi: { installed: boolean; version: string|null }; model: ModelSettings; }
const emptySettings: ModelSettings = {baseUrl:"",model:"",hasKey:false};
const num=(n:number)=>n.toLocaleString("zh-CN");
const active=(run?:RunInfo|null)=>!!run&&["queued","running"].includes(run.status);
const statusText=(run:RunInfo|null)=>!run?"等你开工":run.status==="running"?"正在行动":run.status==="queued"?"准备出发":run.status==="awaiting_approval"?"等你盖章":run.status==="failed"?"这场遇到问题":run.status==="cancelled"?"任务已停止":run.status==="interrupted"?"任务已中断":run.outcome==="written"?"已真实写回":run.outcome==="partial"?"部分修改已写回":run.outcome==="discarded"?"原文未改":"本场已完成";
const draftKey=(d:Pick<Draft,"doc"|"id">)=>`${d.doc}\0${d.id}`;
const unitCount=(d:DocumentInfo)=>`${d.units} ${d.unitKind==="page"?"页":d.unitKind==="slide"?"页幻灯片":d.unitKind==="sheet"?"张工作表":"段"}`;

export default function App(){
  const [ws,setWs]=useState(()=>new URLSearchParams(location.search).get("workspace")==="demo"?"demo":"main");
  const [workspace,setWorkspace]=useState<WorkspaceInfo>({id:ws,name:"我的文档",demo:false,documents:[]});
  const [status,setStatus]=useState<Status>({pi:{installed:false,version:null},model:emptySettings});
  const [run,setRun]=useState<RunInfo|null>(null),[history,setHistory]=useState<RunInfo[]>([]),[drafts,setDrafts]=useState<Draft[]>([]);
  const [prompt,setPrompt]=useState(""),[toast,setToast]=useState(""),[busy,setBusy]=useState(""),[settingsOpen,setSettingsOpen]=useState(false);
  const [tab,setTab]=useState<"evidence"|"drafts"|"trace">("evidence"),[sideOpen,setSideOpen]=useState(false),[filesOpen,setFilesOpen]=useState(false),[historyOpen,setHistoryOpen]=useState(false);
  const [preview,setPreview]=useState<{doc:DocumentInfo;reference?:Reference}|null>(null);
  const [fileAction,setFileAction]=useState<{doc:DocumentInfo;action:"rename"|"delete"}|null>(null),[newName,setNewName]=useState("");
  const [checked,setChecked]=useState<Set<string>>(new Set()),[selectedStage,setSelectedStage]=useState<Stage|null>(null);
  const selectionRun=useRef(""),knownDrafts=useRef(new Set<string>());
  const [stageMode,setStageMode]=useState(false),[connectionLost,setConnectionLost]=useState(false);
  const [replayClock,setReplayClock]=useState<number|null>(null),[replayPlaying,setReplayPlaying]=useState(false),[replaySpeed,setReplaySpeed]=useState(4);
  const fileInput=useRef<HTMLInputElement>(null),composer=useRef<HTMLTextAreaElement>(null),stream=useRef<EventSource|null>(null);
  const reduced=useReducedMotion();
  const refreshWorkspace=useCallback(async()=>{const next=await api<WorkspaceInfo>(`/api/workspaces/${ws}`);setWorkspace(next);return next;},[ws]);
  const refreshHistory=useCallback(async()=>{const rows=await api<RunInfo[]>(`/api/workspaces/${ws}/runs`);setHistory(rows);return rows;},[ws]);
  const refreshDrafts=useCallback(async(id:string)=>{const next=await api<Draft[]>(`/api/runs/${id}/drafts`);setDrafts(next);const valid=new Set(next.filter(d=>d.status==="pending"&&d.canApply).map(draftKey)),previous=knownDrafts.current,same=selectionRun.current===id;knownDrafts.current=valid;selectionRun.current=id;setChecked(old=>new Set([...valid].filter(k=>!same||!previous.has(k)||old.has(k))));},[]);
  const selectRun=useCallback(async(id:string)=>{const r=await api<RunInfo>(`/api/runs/${id}`);setRun(r);setReplayClock(null);setReplayPlaying(false);setSelectedStage(null);await refreshDrafts(id);if(r.status==="awaiting_approval")setTab("drafts");},[refreshDrafts]);
  useEffect(()=>{let closed=false;setRun(null);setDrafts([]);setReplayClock(null);setReplayPlaying(false);
    const params=new URLSearchParams();if(ws==="demo")params.set("workspace","demo");historyReplace(params);
    void Promise.all([api<Status>("/api/status"),api<WorkspaceInfo>(`/api/workspaces/${ws}`),api<RunInfo[]>(`/api/workspaces/${ws}/runs`)]).then(([s,w,h])=>{if(closed)return;setStatus(s);setWorkspace(w);setHistory(h);if(h[0])void selectRun(h[0].id);}).catch(e=>{if(!closed)setToast(e.message);});
    return()=>{closed=true;};
  },[ws,selectRun]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(""),6500);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{setReplayClock(null);setReplayPlaying(false);setSelectedStage(null);},[run?.id]);
  useEffect(()=>{
    stream.current?.close();setConnectionLost(false);
    if(!run||!["queued","running","awaiting_approval"].includes(run.status))return;
    const id=run.id,source=new EventSource(`/api/runs/${id}/events?after=${run.events.at(-1)?.seq??0}`);stream.current=source;
    const sync=async()=>{try{const updated=await api<RunInfo>(`/api/runs/${id}`);setRun(prev=>prev?.id===id?updated:prev);await Promise.all([refreshWorkspace(),refreshHistory(),refreshDrafts(id)]);if(updated.status==="awaiting_approval"){setTab("drafts");}if(!["queued","running","awaiting_approval"].includes(updated.status))source.close();}catch(e){setToast((e as Error).message);}};
    source.onopen=()=>{setConnectionLost(false);void sync();};
    source.onerror=()=>setConnectionLost(true);
    source.onmessage=message=>{
      const event=JSON.parse(message.data) as FlowEvent;
      setRun(previous=>{
        if(!previous||previous.id!==id||previous.events.some(e=>e.seq===event.seq))return previous;
        return {...previous,status:event.type==="starting"||event.type==="upload"?"running":previous.status,events:[...previous.events,event],
          answer:event.type==="answer"?event.text??"":event.type==="answer_delta"?previous.answer+(event.text??""):previous.answer,
          inputTokens:event.inputTokens??previous.inputTokens,outputTokens:event.outputTokens??previous.outputTokens};
      });
      if(event.type==="settled"||event.type==="failed")void sync();
      else if(event.type==="indexed")void refreshWorkspace();
      else if(event.type==="tool_end"&&event.tool==="folio_revise")void refreshDrafts(id);
    };
    return()=>{source.close();if(stream.current===source)stream.current=null;};
    // The connection belongs to a run, not to each streamed text update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[run?.id]);
  const duration=run?.events.length?Math.max(1,new Date(run.events.at(-1)!.at).getTime()-new Date(run.events[0].at).getTime()):1;
  useEffect(()=>{if(replayClock===null||!replayPlaying)return;const timer=setInterval(()=>setReplayClock(prev=>prev===null?null:Math.min(duration,prev+100*replaySpeed)),100);return()=>clearInterval(timer);},[replayPlaying,replaySpeed,duration,replayClock===null]);
  useEffect(()=>{if(replayClock!==null&&replayClock>=duration)setReplayPlaying(false);},[replayClock,duration]);
  const visibleEvents=useMemo(()=>!run?[]:replayClock===null?run.events:run.events.filter(e=>new Date(e.at).getTime()-new Date(run.events[0]?.at??run.createdAt).getTime()<=replayClock),[run,replayClock]);
  const sceneAnswer=useMemo(()=>{if(replayClock===null)return run?.answer??"";return visibleEvents.reduce((text,e)=>e.type==="answer"?e.text??"":e.type==="answer_delta"?text+(e.text??""):text,"");},[run?.answer,visibleEvents,replayClock]);
  const refs=useMemo(()=>{const map=new Map<string,Reference>();for(const e of visibleEvents)for(const ref of e.references??[]){const key=`${ref.docId}:${ref.target}:${ref.version}`;if((map.get(key)?.text.length??0)<=ref.text.length)map.set(key,ref);}return[...map.values()];},[visibleEvents]);
  const sceneRunning=replayClock!==null?replayClock<duration:active(run);
  const currentStage=[...visibleEvents].reverse().find(e=>e.stage)?.stage??"inbox";
  const tools=visibleEvents.filter(e=>e.type==="tool_start");
  const hasWritten=replayClock===null?!!run&&["written","partial"].includes(run.outcome??"")&&run.events.some(e=>e.type==="applied"&&e.state==="done"):visibleEvents.some(e=>e.type==="applied"&&e.state==="done");
  const pending=drafts.filter(d=>d.status==="pending");

  async function loadExamples(){
    if(busy)return;setBusy("examples");
    try{const r=await post<RunInfo>("/api/workspaces/demo/examples");if(ws!=="demo"){setWs("demo");}setRun(r);setDrafts([]);setFilesOpen(false);setPrompt("");setTab("evidence");setToast("正在装入三份真实的示例材料…");}
    catch(e){setToast((e as Error).message);}finally{setBusy("");}
  }
  async function upload(files:FileList|File[]|null){
    if(!files?.length)return;const list=Array.from(files);if(list.length>10){setToast("一次最多接收 10 份文件");return;}if(list.some(f=>f.size>50*1024*1024)){setToast("每份文件请控制在 50MB 以内");return;}
    setBusy("upload");setReplayClock(null);
    try{const job=await post<RunInfo>(`/api/workspaces/${ws}/uploads`);setRun(job);setDrafts([]);setFilesOpen(false);const form=new FormData();for(const file of list)form.append("files",file);
      const updated=await api<RunInfo>(`/api/workspaces/${ws}/documents?run=${job.id}`,{method:"POST",body:form});setRun(updated);await Promise.all([refreshWorkspace(),refreshHistory()]);setToast("文件已接收，准备开始第一场行动。");}
    catch(e){setToast((e as Error).message);await refreshWorkspace().catch(()=>{});}finally{setBusy("");if(fileInput.current)fileInput.current.value="";}
  }
  async function submit(e:React.FormEvent){e.preventDefault();if(!status.model.hasKey){setSettingsOpen(true);return;}if(!prompt.trim())return;setBusy("task");setReplayClock(null);setTab("evidence");setSelectedStage(null);
    try{const r=await post<RunInfo>(`/api/workspaces/${ws}/runs`,{message:prompt});setRun(r);setDrafts([]);setPrompt("");void refreshHistory();}catch(e){setToast((e as Error).message);}finally{setBusy("");}
  }
  async function approve(){if(!run)return;setBusy("apply");try{const keys=drafts.filter(d=>d.status==="pending"&&d.canApply&&checked.has(draftKey(d))).map(d=>({doc:d.doc,id:d.id}));const r=await post<RunInfo>(`/api/runs/${run.id}/apply`,{keys});setRun(r);await Promise.all([refreshDrafts(r.id),refreshWorkspace(),refreshHistory()]);setToast(r.status==="failed"?r.error??"修改未能写回":"已收到实际写回结果，请查看出件口。");}catch(e){setToast((e as Error).message);await selectRun(run.id);}finally{setBusy("");}}
  async function discard(){if(!run)return;setBusy("discard");try{const r=await post<RunInfo>(`/api/runs/${run.id}/discard`);setRun(r);await Promise.all([refreshDrafts(r.id),refreshHistory()]);setToast(r.outcome==="partial"?"剩余草案已撤销，已确认的写回保留。":"本次草案已撤销，原文未改。");}catch(e){setToast((e as Error).message);}finally{setBusy("");}}
  async function stop(){if(!run)return;setBusy("stop");try{const r=await post<RunInfo>(`/api/runs/${run.id}/stop`);setRun(r);await refreshDrafts(r.id);}catch(e){setToast((e as Error).message);}finally{setBusy("");}}
  async function manageFile(e:React.FormEvent){e.preventDefault();if(!fileAction)return;setBusy("file");try{const {doc,action}=fileAction;await api(`/api/workspaces/${ws}/documents/${doc.id}`,{method:action==="delete"?"DELETE":"PATCH",...(action==="rename"?{body:JSON.stringify({name:newName})}:{})});setFileAction(null);await refreshWorkspace();if(run)await refreshDrafts(run.id);setToast(action==="delete"?"文件已移出工作区，你电脑中的原文件不受影响。":"文件已重命名，旧名称的待确认草案已撤销。");}catch(e){setToast((e as Error).message);}finally{setBusy("");}}
  async function refreshDoc(doc:DocumentInfo){setBusy("refresh");try{const w=await post<WorkspaceInfo>(`/api/workspaces/${ws}/documents/${doc.id}/refresh`);setWorkspace(w);setToast("这份文档的索引已刷新。");}catch(e){setToast((e as Error).message);}finally{setBusy("");}}
  function openReference(ref:Reference){const doc=workspace.documents.find(d=>d.id===ref.docId);if(!doc){setToast("文件已移出工作区；这里保留的是当时引用的原文。");return;}setPreview({doc,reference:ref});}
  function pickStage(stage:Stage){setSelectedStage(selectedStage===stage?null:stage);setTab(stage==="draft"||stage==="approval"?"drafts":stage==="evidence"?"evidence":"trace");setSideOpen(true);}
  function stageState(stage:Stage){const last=visibleEvents.filter(e=>e.stage===stage&&e.state).at(-1);if(!last)return"idle";if(!sceneRunning&&last.state==="running"&&!last.type.startsWith("apply"))return"waiting";return last.state??"idle";}
  const showTrace=visibleEvents.filter(e=>["upload","index","indexed","starting","accepted","tool_start","tool_end","notice","apply_start","apply_end","applied","settled","failed"].includes(e.type)&&(!selectedStage||e.stage===selectedStage));

  return <div className={`workshop-app ${stageMode?"stage-mode":""}`}>
    <header className="masthead"><a className="brand" href="/" aria-label="Folio 文档工坊首页"><span className="brand-paper"><Icon name="file" size={27}/></span><strong>Folio<span>文档工坊</span></strong></a><span className="brand-caption">有依据，才动笔。</span>
      <div className="header-actions"><a className="button small comparison-entry" href={`/theater.html?workspace=${ws}`}><span className="comparison-entry-label">比赛对照</span> <Icon name="play" size={13}/></a><span className={`engine-badge ${status.pi.installed?"":"offline"}`}><span/>{status.pi.installed?`独立 π ${status.pi.version}`:"引擎待安装"}</span><button className={`model-button ${status.model.hasKey?"connected":""}`} onClick={()=>setSettingsOpen(true)}><Icon name="settings" size={17}/><span>{status.model.hasKey?status.model.model:"连接模型"}</span><i/></button><button className="icon-button stage-toggle" onClick={()=>setStageMode(v=>!v)} title={stageMode?"退出舞台模式":"进入大屏舞台模式"} aria-label={stageMode?"退出舞台模式":"进入大屏舞台模式"}><Icon name="expand"/></button><button className="icon-button mobile-files-toggle" aria-label="打开文件架" onClick={()=>setFilesOpen(true)}><Icon name="file"/></button></div>
    </header>
    <div className="workbench">
      <aside className={`file-shelf ${filesOpen?"mobile-open":""}`} aria-label="文件架">
        <div className="shelf-heading"><h2>收件架<span>{workspace.documents.length} 份</span></h2><button className="icon-button close-drawer" onClick={()=>setFilesOpen(false)} aria-label="关闭文件架"><Icon name="close"/></button></div>
        <div className="workspace-switch" role="group" aria-label="选择工作区"><button className={ws==="main"?"selected":""} onClick={()=>{setWs("main");setFilesOpen(false);}}>我的文档</button><button className={ws==="demo"?"selected":""} onClick={()=>{setWs("demo");setFilesOpen(false);}}>比赛示例</button></div>
        <input ref={fileInput} id="file-upload" type="file" accept={ACCEPT} multiple onChange={e=>void upload(e.target.files)} hidden/>
        <button className={`drop-zone ${busy==="upload"?"receiving":""}`} disabled={!!busy||active(run)} onClick={()=>fileInput.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!busy&&!active(run))void upload(e.dataTransfer.files);}}><span className="upload-symbol"><Icon name="upload" size={27}/></span><strong>{busy==="upload"?"正在接收文档…":"把文档放进来"}</strong><span>拖拽到这里，或点击上传</span><small>PDF / Office / 网页 / 文本 · 每份 ≤ 50MB</small></button>
        <div className="file-list">{!workspace.documents.length?<div className="empty-shelf"><span className="empty-dashes">— — —</span><p>书架空空，故事还没开始。</p><button className="text-button" onClick={()=>void loadExamples()} disabled={!!busy}>先试试比赛示例 <Icon name="arrow" size={15}/></button></div>:<AnimatePresence initial={false}>{workspace.documents.map(doc=><motion.div layout key={doc.id} className={`file-card ${doc.status!=="ready"?"unreadable":""}`} initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} exit={{opacity:0,x:-35,rotate:-5}}>
          <button className="file-main" onClick={()=>setPreview({doc})}><span className={`file-type type-${doc.kind}`}><Icon name="file" size={25}/><b>{doc.name.split(".").at(-1)?.toUpperCase()}</b></span><span className="file-copy"><strong title={doc.name}>{doc.name}</strong><small>{doc.status==="ready"?unitCount(doc):doc.status==="no_text"?(doc.kind==="pdf"?"没有文字层 / 需 OCR":"没有可提取的正文"):"索引需要检查"}</small><span className="file-capability">{doc.editableActions.length?doc.kind==="docx"?"可改文字":"可增删改":"只读与修改建议"}</span></span></button>
          <details className="file-menu"><summary aria-label={`${doc.name} 的文件操作`}><Icon name="menu" size={19}/></summary><div><button onClick={()=>setPreview({doc})}>查看原文</button><a href={contentUrl(ws,doc.id,true)} download>下载文件</a><button disabled={active(run)||!!busy} onClick={()=>{setFileAction({doc,action:"rename"});setNewName(doc.name);}}>重命名</button><button disabled={active(run)||!!busy} onClick={()=>void refreshDoc(doc)}>重新索引</button><button className="danger-text" disabled={active(run)||!!busy} onClick={()=>setFileAction({doc,action:"delete"})}>移出工作区</button></div></details>
        </motion.div>)}</AnimatePresence>}</div>
        <div className="shelf-bottom">{ws==="demo"&&<button className="text-button" disabled={!!busy||active(run)} onClick={()=>{if(workspace.documents.length){if(!window.confirm("重置三份示例材料和示例对话？你的个人文档不会受影响，已保存的流程回放会保留。"))return;}void loadExamples();}}>↻ {workspace.documents.length?"重置示例材料":"装入三份示例"}</button>}<button className="history-button" onClick={()=>setHistoryOpen(true)}><Icon name="history"/><span>工坊记录</span><b>{history.length}</b></button><p>上传副本保存在本机。<br/>原文片段用于你配置的模型调用。</p></div>
      </aside>
      <main className="factory-main">
        <div className="factory-heading"><div><p className="eyebrow"><span/> 本机文档操作台</p><h1>文档就位，好戏开场。</h1><p className="stage-description">从查找依据到确认改稿，让每一步都看得见。</p></div><div className="pi-greeting"><PaperPi working={sceneRunning}/><span className="speech-bubble">{sceneRunning?"正在翻翻找找！":run?.status==="awaiting_approval"?"最后一笔，交给你。":hasWritten?"这回，真的改好了！":"你好，我是小π！"}</span></div></div>
        <div className="factory-paper">
          <div className="scene-toolbar"><div className="scene-label"><span className="scene-dot"/><strong>{replayClock!==null?"真实记录回放":statusText(run)}</strong>{run&&<span className="scene-task" title={run.message}>{run.message}</span>}</div><div className="scene-actions">{run&&!active(run)&&run.status!=="awaiting_approval"&&run.events.length>0&&replayClock===null&&<button onClick={()=>{setReplayClock(0);setReplayPlaying(true);}}><Icon name="play" size={13}/>回放</button>}<button className="inspector-toggle" onClick={()=>setSideOpen(true)}><Icon name="quote" size={14}/>依据与改稿{pending.length>0&&<b>{pending.length}</b>}</button></div></div>
          {replayClock!==null&&<div className="replay-controls"><span>回放 · 不会重新调用模型</span><button onClick={()=>setReplayPlaying(v=>!v)}>{replayPlaying?"暂停":"继续"}</button><select aria-label="回放速度" value={replaySpeed} onChange={e=>setReplaySpeed(Number(e.target.value))}><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select><button onClick={()=>{setReplayClock(null);setReplayPlaying(false);}}>退出回放</button><div className="replay-track"><i style={{width:`${Math.min(100,replayClock/duration*100)}%`}}/></div></div>}
          <div className="factory-floor">
            <svg className="factory-conveyor" viewBox="0 0 900 410" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="arrow-head" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M1 1 6 4 1 7" fill="none" stroke="currentColor" strokeWidth="1.5"/></marker></defs><path d="M275 93h47M575 93h47M755 180v48M625 317h-47M325 317h-47" fill="none" stroke="currentColor" strokeWidth="2.3" strokeDasharray="5 4" markerEnd="url(#arrow-head)"/></svg>
            <div className="station-grid">{STAGES.map((s,i)=>{const state=stageState(s.id),count=tools.filter(t=>t.stage===s.id).length,isCurrent=sceneRunning&&currentStage===s.id;return <motion.button layout className={`station station-${s.id} state-${state} ${selectedStage===s.id?"chosen":""}`} key={s.id} onClick={()=>pickStage(s.id)} aria-label={`${s.title}：${state==="idle"?"尚未经过":state==="running"?"进行中":state==="done"?"已完成":state==="waiting"?"等待确认或需留意":"出现问题"}`} whileTap={reduced?undefined:{scale:.98}}>
              <RoughOutline seed={i+91}/><span className="station-number">{s.number}</span><span className="station-indicator">{state==="done"?<Icon name="check" size={14}/>:state==="running"?<span className="working-dot"/>:state==="error"?"!":state==="waiting"?"…":""}</span><Machine stage={s.id} active={isCurrent}/><h2>{s.title}</h2><p>{s.subtitle}</p>{count>0&&<span className="station-count">{count} 次真实调用</span>}{isCurrent&&<motion.span layoutId="travelling-pi" className="travelling-pi" transition={{type:"spring",stiffness:95,damping:18}}><PaperPi small working/></motion.span>}{s.id==="delivery"&&hasWritten&&<motion.span initial={{scale:1.8,opacity:0,rotate:-20}} animate={{scale:1,opacity:1,rotate:-10}} className="written-stamp">已写回</motion.span>}
            </motion.button>;})}</div>
          </div>
          <div className="scene-footer"><span className="hand-note">先有证据，再动原文。<svg viewBox="0 0 120 15" aria-hidden="true"><path d="M2 7q55-8 114-2M7 12q56-8 106-4"/></svg></span><div className="real-counters"><span><b>{tools.length}</b> 工具调用</span><span><b>{refs.length}</b> 条依据</span>{run?.kind==="task"&&<span><b>{num(replayClock===null?run.inputTokens:visibleEvents.filter(e=>e.inputTokens!==undefined).at(-1)?.inputTokens??0)}</b> 输入 token</span>}</div></div>
        </div>
        {connectionLost&&active(run)&&<div role="status" className="connection-warning">连接暂时断开，正在重新接收同一任务的进度，不会重复执行。</div>}
        {run?.error&&replayClock===null&&<div role="alert" className="task-error"><strong>这一步需要你留意</strong><p>{run.error}</p></div>}
        {sceneAnswer&&<div className={`answer-bubble ${run?.status==="awaiting_approval"?"needs-approval":""}`}><div className="answer-label"><span>{hasWritten?"提案时的答复":"小π的答复"}</span>{replayClock===null&&(hasWritten?<strong>已真实写回 · 以下为确认前的建议</strong>:run?.status==="awaiting_approval"?<strong>草案已生成 · 原文尚未改动</strong>:run?.status==="completed"&&run.kind==="task"?<strong>答复已完成 · 本次原文未改</strong>:null)}</div><div className="answer-content"><Markdown remarkPlugins={[remarkGfm]}>{sceneAnswer}</Markdown></div>{hasWritten&&<div className="result-downloads">{[...new Set(drafts.filter(d=>d.status==="applied").map(d=>d.docId))].map(id=>{const doc=workspace.documents.find(d=>d.id===id);return doc?<a className="button small" key={id} href={contentUrl(ws,id,true)} download><Icon name="download" size={15}/>下载 {doc.name}</a>:null;})}</div>}</div>}
        <form className="composer" onSubmit={submit}><div className="composer-label"><strong>给小π一个任务</strong><span>{ws==="demo"?"正在使用合成比赛示例":"正在使用你的上传副本"}</span></div><div className="composer-row"><textarea ref={composer} aria-label="给小π一个任务" placeholder={workspace.documents.length?"例如：找出付款期限，给我原文出处。也可以让我拟一份修改建议…":"先上传文档，或者试试我们准备的比赛示例…"} value={prompt} disabled={!!busy||active(run)||replayClock!==null} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter"){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>{active(run)?<button type="button" className="button stop-button" onClick={()=>void stop()} disabled={!!busy||run?.kind==="upload"}><Icon name="stop" size={15}/>{run?.kind==="upload"?"接收中…":busy==="stop"?"停止中…":"停止"}</button>:<button className="button primary start-button" disabled={!!busy||replayClock!==null||(status.model.hasKey&&!prompt.trim())}>{!status.model.hasKey?"连接模型":busy==="task"?"接单中…":"开工！"}<Icon name="arrow"/></button>}</div><div className="quick-prompts">{ws==="demo"&&workspace.documents.length?EXAMPLES.map((e,i)=><button type="button" key={e.kind} disabled={active(run)||!!busy||replayClock!==null} onClick={()=>{setPrompt(e.text);composer.current?.focus();}}><span>0{i+1}</span>{e.title}</button>):<button type="button" className="example-prompt" onClick={()=>void loadExamples()} disabled={active(run)||!!busy}><Icon name="spark" size={15}/>没有材料？用三份示例看看工坊怎么工作。</button>}</div></form>
        <div className="workshop-footnote"><span>Folio × pi agent</span><span>模型调用与文件处理都使用本项目的独立环境</span></div>
      </main>
      <aside className={`inspector ${sideOpen?"mobile-open":""}`} aria-label="依据与改稿"><div className="inspector-heading"><div><p className="eyebrow">依据与改稿</p><h2>把来路，讲清楚。</h2></div><button className="icon-button close-drawer" onClick={()=>setSideOpen(false)} aria-label="关闭依据面板"><Icon name="close"/></button></div><div className="inspector-tabs" role="tablist" aria-label="任务详情">{([['evidence','依据',refs.length],['drafts','改稿',drafts.length],['trace','足迹',tools.length]] as const).map(([key,label,count])=><button role="tab" aria-selected={tab===key} className={tab===key?"selected":""} key={key} onClick={()=>{setTab(key);setSelectedStage(null);}}>{label}<span>{count}</span></button>)}</div>
        <div className="inspector-scroll">{tab==="evidence"&&(!refs.length?<div className="empty-inspector"><span className="pin"/><div className="blank-note"><Icon name="quote" size={35}/><span/><span/><span/></div><h3>结论，不能凭空而来。</h3><p>小π找到的原文会贴在这里。<br/>点一下，就能翻到对应的页面。</p><small>没有依据时，这里不会假装有答案。</small></div>:<div className="evidence-list">{refs.map((ref,i)=><button className="evidence-card" key={`${ref.docId}-${ref.target}-${ref.version}`} onClick={()=>openReference(ref)}><span className="evidence-index">{String(i+1).padStart(2,"0")}</span><div><strong>{ref.doc}</strong><small>{unitName(ref.label)} · 第 {ref.line} 行</small><p>{ref.text}</p><span className="evidence-link">翻开这条依据 <Icon name="arrow" size={14}/></span></div></button>)}</div>)}
        {tab==="drafts"&&(!drafts.length?<div className="empty-inspector"><Machine stage="draft" active={false}/><h3>先看一眼，再动笔。</h3><p>提出修改任务后，原文和改稿<br/>会在这里一一对照。</p><small>确认之前，文件不会被写回。</small></div>:<div className="draft-list"><p className="draft-intro">{pending.some(d=>d.canApply)?"改稿已备好。勾选要应用的修改，再盖章。":"这里是本次任务的修改意见与处理结果。"}</p>{drafts.map(d=><article key={draftKey(d)} className={`draft-card draft-${d.status}`}><header>{d.status==="pending"&&d.canApply?<input type="checkbox" aria-label={`选择 ${d.doc} ${d.id}`} checked={checked.has(draftKey(d))} disabled={replayClock!==null||!!busy||active(run)} onChange={e=>setChecked(prev=>{const next=new Set(prev);e.target.checked?next.add(draftKey(d)):next.delete(draftKey(d));return next;})}/>:<span className="draft-status">{d.status==="applied"?"已写回":d.status==="discarded"?"已撤销":d.status==="conflict"?"版本冲突":"仅建议"}</span>}<strong>{d.doc}</strong><span>{d.id}</span></header><p className="draft-location">{unitName(d.target.split(":L")[0])} · {d.action==="delete"?"删除":d.action==="insert_after"?"追加":"替换"}</p><div className="diff-before"><span>原</span><p>{d.before}</p></div><div className="diff-after"><span>{d.action==="delete"?"删":"改"}</span><p>{d.action==="delete"?"删除这一整行":d.text}</p></div>{d.reason&&<p className="draft-reason">{d.reason}</p>}{!d.canApply&&d.status==="pending"&&<p className="proposal-only">此格式或操作仅提供建议，不直接写回。</p>}</article>)}</div>)}
        {tab==="trace"&&(!showTrace.length?<div className="empty-inspector"><Icon name="history" size={42}/><h3>行动之后，才有足迹。</h3><p>这里记录真实工具调用。<br/>不会用动画补一段没发生的流程。</p></div>:<div className="trace-list">{selectedStage&&<button className="text-button" onClick={()=>setSelectedStage(null)}>显示全部环节</button>}{showTrace.filter(e=>e.type!=="tool_start"||!showTrace.some(end=>end.type==="tool_end"&&end.toolCallId===e.toolCallId)).map(e=><details key={e.seq} className={`trace-item trace-${e.state}`}><summary><i/>{e.message}<span>{new Date(e.at).toLocaleTimeString("zh-CN",{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span></summary><small>{e.tool??e.type}</small>{e.args&&<pre>{JSON.stringify(e.args,null,2)}</pre>}{e.detail&&<pre>{e.detail}</pre>}</details>)}</div>)}
        </div>
        {tab==="drafts"&&drafts.length>0&&<div className="approval-bar">{pending.some(d=>d.canApply)&&<><p><strong>{drafts.filter(d=>d.status==="pending"&&checked.has(draftKey(d))&&d.canApply).length}</strong> 处已勾选 · 确认后才写回</p><button className="button stamp-button" onClick={()=>void approve()} disabled={!!busy||active(run)||!checked.size||replayClock!==null}><Machine stage="approval" active={busy==="apply"}/>{busy==="apply"?"正在写回…":"确认盖章"}<Icon name="check"/></button></>}{pending.length>0&&<button className="text-button" disabled={!!busy||active(run)||replayClock!==null} onClick={()=>void discard()}>撤销本次尚未应用的草案</button>}<a className="text-button" href={`/api/runs/${run?.id}/proposals.md`} download><Icon name="download" size={14}/>导出修改意见</a></div>}
        <div className="inspector-note"><span className="tiny-check"><Icon name="check" size={12}/></span>依据来自真实工具结果，改稿由你确认。</div>
      </aside>
    </div>
    {(sideOpen||filesOpen)&&<button className="drawer-scrim" onClick={()=>{setSideOpen(false);setFilesOpen(false);}} aria-label="关闭侧栏"/>}
    <AnimatePresence>{toast&&<motion.div className="toast" role="status" initial={{opacity:0,y:20}} animate={{opacity:1,y:0}} exit={{opacity:0,y:10}}><span>{toast}</span><button className="icon-button" onClick={()=>setToast("")} aria-label="关闭提示"><Icon name="close" size={16}/></button></motion.div>}</AnimatePresence>
    {settingsOpen&&<SettingsDialog settings={status.model} onClose={()=>setSettingsOpen(false)} onSaved={model=>{setStatus(prev=>({...prev,model}));setToast("模型连接已保存，小π准备好了。");}}/>}
    {preview&&<PreviewDialog workspace={ws} doc={preview.doc} reference={preview.reference} onClose={()=>setPreview(null)}/>}
    {fileAction&&<Modal title={fileAction.action==="delete"?"把这份文件移出工坊？":"给文件换个名字"} onClose={()=>setFileAction(null)}><form onSubmit={e=>void manageFile(e)} className="file-action-form"><p><strong>{fileAction.doc.name}</strong></p>{fileAction.action==="rename"?<><label>新文件名<input required autoFocus value={newName} onChange={e=>setNewName(e.target.value)}/></label><p className="muted small-text">保留扩展名。此文件尚未确认的旧名称草案将撤销。</p></>:<p>上传的副本及它的待确认草案会移出本工作区。你电脑里的原文件不会被删除。</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={()=>setFileAction(null)}>算了，保留</button><button className={`button ${fileAction.action==="delete"?"danger":"primary"}`} disabled={!!busy}>{busy==="file"?"处理中…":fileAction.action==="delete"?"确认移出":"保存新名字"}</button></div></form></Modal>}
    {historyOpen&&<Modal title="工坊记录 · 真实任务" onClose={()=>setHistoryOpen(false)}><div className="history-list">{history.length?history.map(h=><button key={h.id} onClick={()=>{void selectRun(h.id);setHistoryOpen(false);}}><span className={`history-mark history-${h.status}`}><Icon name={h.status==="awaiting_approval"?"file":"history"}/></span><span><strong>{h.message}</strong><small>{new Date(h.createdAt).toLocaleString("zh-CN")} · {statusText(h)}</small></span><Icon name="arrow" size={16}/></button>):<p className="muted">还没有任务记录。第一场行动，从上传文档开始。</p>}</div></Modal>}
  </div>;
}
function historyReplace(params:URLSearchParams){window.history.replaceState(null,"",`${location.pathname}${params.size?"?"+params.toString():""}`);}








