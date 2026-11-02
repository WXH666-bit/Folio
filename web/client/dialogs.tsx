import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Icon } from "./art";
import { api, post, contentUrl, unitName } from "./api";
import type { ModelSettings, Preview, DocumentInfo, Reference } from "../shared";

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? "wide-modal" : ""}`} onCancel={onClose} onClick={e => { if(e.target === e.currentTarget) onClose(); }}>
    <div className="modal-top"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close"/></button></div>{children}
  </dialog>;
}

export function SettingsDialog({ settings, onClose, onSaved }: { settings: ModelSettings; onClose: () => void; onSaved: (settings: ModelSettings) => void }) {
  const [baseUrl,setBase] = useState(settings.baseUrl), [model,setModel] = useState(settings.model), [key,setKey] = useState("");
  const [busy,setBusy] = useState(""),[error,setError] = useState(""),[success,setSuccess] = useState("");
  const payload = () => ({baseUrl, model, ...(key ? {apiKey:key}: {})});
  const test = async () => { setBusy("test");setError("");setSuccess("");try { const r = await post<{message:string}>("/api/settings/test", payload()); setSuccess(r.message); } catch(e){setError((e as Error).message);}finally{setBusy("");} };
  const save = async (e: React.FormEvent) => { e.preventDefault();setBusy("save");setError("");try{const r=await api<ModelSettings>("/api/settings",{method:"PUT",body:JSON.stringify(payload())});setKey("");onSaved(r);onClose();}catch(e){setError((e as Error).message);}finally{setBusy("");} };
  return <Modal title="给小π接通模型" onClose={onClose}><form className="settings-form" onSubmit={save}>
    <div className="connection-note"><Icon name="settings" size={30}/><p>使用你自己的兼容 API。连接保存在本机工坊，不使用个人 pi 的配置。</p></div>
    <label>API 地址<input required type="url" value={baseUrl} onChange={e=>setBase(e.target.value)} placeholder="https://api.example.com/v1" autoComplete="off"/></label>
    <label>模型名称<input required value={model} onChange={e=>setModel(e.target.value)} placeholder="填写服务商提供的模型 ID" autoComplete="off"/></label>
    <label>API 密钥<input type="password" value={key} onChange={e=>setKey(e.target.value)} required={!settings.hasKey} placeholder={settings.hasKey ? "已保存；留空保留原密钥" : "密钥仅交给本机后端"} autoComplete="new-password"/></label>
    <p className="muted small-text">使用 OpenAI 兼容的 Chat Completions 接口。任务与相关原文会发送至你配置的模型；密钥不写入浏览器缓存和流程回放。</p>
    {error&&<p role="alert" className="error-note">{error}</p>}{success&&<p className="success-note">{success}</p>}
    <div className="modal-actions"><button type="button" className="button secondary" onClick={()=>void test()} disabled={!!busy||!baseUrl||!model||(!key&&!settings.hasKey)}>{busy==="test"?"正在等待模型…":"测试连接"}</button><button className="button primary" disabled={!!busy}>{busy==="save"?"保存中…":"保存，准备开工"}<Icon name="arrow"/></button></div>
  </form></Modal>;
}

function PdfPage({ url, page }: { url: string; page: number }) {
  const canvas=useRef<HTMLCanvasElement>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  useEffect(()=>{
    let closed=false;let cleanup:(()=>void)|undefined;
    void (async()=>{try{
      setError("");setLoading(true);
      const pdfjs=await import("pdfjs-dist/build/pdf.mjs");
      const worker=await import("pdfjs-dist/build/pdf.worker.min.mjs?url"); pdfjs.GlobalWorkerOptions.workerSrc=worker.default;
      const task=pdfjs.getDocument({url}); cleanup=()=>{void task.destroy();};
      const pdf=await task.promise;if(closed)return;
      const p=await pdf.getPage(page),view=p.getViewport({scale:1.5});const target=canvas.current;if(!target||closed)return;
      target.width=view.width;target.height=view.height;
      const render=p.render({canvas:target,viewport:view});await render.promise;
      if(!closed)setLoading(false);
    }catch(e){if(!closed){setError("页面暂时无法显示，请重新打开或下载原文件。");setLoading(false);}}})();
    return()=>{closed=true;cleanup?.();};
  },[url,page]);
  return <div className="pdf-preview">{loading&&<p className="preview-loading">正在把原始页面铺到桌面上…</p>}{error&&<p className="error-note">{error}</p>}<canvas ref={canvas} aria-label={`PDF 第 ${page} 页`}/></div>;
}

export function PreviewDialog({ workspace, doc, reference, onClose, documentBase }: { workspace: string; doc: DocumentInfo; reference?: Reference; onClose:()=>void; documentBase?:string }) {
  const base=documentBase??`/api/workspaces/${workspace}/documents/${doc.id}`;
  const [data,setData]=useState<Preview|null>(null),[label,setLabel]=useState(reference?.label??""),[error,setError]=useState("");
  useEffect(()=>{let closed=false;setError("");setData(null);const query=new URLSearchParams();if(label)query.set("label",label);if(reference?.version)query.set("version",reference.version);if(reference?.line&&label===reference.label)query.set("line",String(reference.line));
    void api<Preview>(`${base}/preview?${query}`).then(r=>{if(!closed)setData(r);}).catch(e=>{if(!closed)setError(e.message);});return()=>{closed=true;};
  },[base,doc.id,label,reference]);
  const current=label||data?.label||"";
  return <Modal title="把依据摊开来看" onClose={onClose} wide>
    <div className="preview-toolbar"><div><strong>{doc.name}</strong><span className="muted small-text">{doc.kind==="pdf"?"原始 PDF 页面 + 提取原文":"提取文本预览 · 不保留原版布局"}</span></div>
      <div className="preview-controls">{!!data?.labels.length&&<select aria-label="选择页码或段落" value={current} onChange={e=>setLabel(e.target.value)}>{data.labels.map(l=><option key={l} value={l}>{unitName(l)}</option>)}</select>}<a className="button small secondary" href={`${base}/content?download=1`} download><Icon name="download" size={16}/>原文件</a></div></div>
    {reference&&<p className="reference-banner">引用：{unitName(reference.label)} · 原文第 {reference.line} 行 · 版本 {reference.version.slice(0,8)}</p>}
    {error?<div className="preview-error"><Icon name="file" size={44}/><p role="alert">{error}</p>{reference&&<blockquote><strong>当时引用的原文片段</strong><p>{reference.text}</p><small>这是历史证据，不代表文件当前内容。</small></blockquote>}</div>:!data?<p className="preview-loading">正在读取原文…</p>:<div className={`preview-body ${doc.kind==="pdf"?"with-pdf":""}`}>
      {doc.kind==="pdf"&&<PdfPage url={`${base}/content?version=${data.doc.version??""}`} page={Number(current.replace("p.",""))||1}/>}
      <div className="original-text">{!data.lines.length&&<p className="muted small-text">{doc.kind==="pdf"?"没有可提取的文字。可查看原始 PDF 页面；扫描文字需要 OCR，本应用目前不提供 OCR。":"文件没有可提取的正文，可通过「原文件」下载查看。"}</p>}{data.truncated&&<p className="muted small-text">显示当前位置附近最多 120 行；更多内容可切换位置或下载原文件。</p>}{data.lines.map((l,i)=><div key={`${l.label}-${l.line}-${i}`} className={`source-line ${reference&&l.label===reference.label&&l.line===reference.line?"highlight-line":""}`}><span>{doc.kind==="pdf"?l.line:unitName(l.label)}</span><p>{l.text||" "}</p></div>)}</div>
    </div>}
  </Modal>;
}

