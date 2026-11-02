// Loaded only by the project's independent pi. All four native tools operate through Docker.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dockerConnection, dockerInvocation } from './docker-client.mjs';

export function remotePath(root, requested) {
  // Pi resolves native file arguments against its Windows cwd; bash uses /workspace.
  if(requested==='/workspace'||requested.startsWith('/workspace/')) {const normalized=path.posix.normalize(requested);if(normalized!=='/workspace'&&!normalized.startsWith('/workspace/'))throw Error('文件工具只能操作当前对照副本');return normalized;}
  const relative=path.relative(root,path.resolve(root,requested));
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('文件工具只能操作当前对照副本');
  return '/workspace'+(relative?'/'+relative.split(path.sep).join('/'):'');
}
const fileScript=`import os,sys,json,base64
p=json.loads(sys.argv[1]); f=p['path']; root='/workspace'; real=os.path.realpath(f)
if real!=root and not real.startswith(root+'/'): raise Exception('path outside comparison copy')
op=p['op']
if op in ('write','mkdir') and op=='write' and os.path.splitext(f)[1].lower() not in ('.txt','.md','.csv','.log'): raise Exception('native text writes support TXT/MD/CSV/LOG; use python-docx for DOCX text replacement')
if op=='read': print(base64.b64encode(open(f,'rb').read()).decode())
elif op=='write': open(f,'wb').write(base64.b64decode(p['data']))
elif op=='mkdir': os.makedirs(f,exist_ok=True)
elif op=='access':
 if not os.path.isfile(f): raise Exception('file not found')
`;
export async function dockerCommand(container,args,onData,signal,timeout) {
  if(!/^folio-cmp-[a-f0-9-]+$/.test(container))return Promise.reject(Error('Invalid owned container'));
  const connection=await dockerConnection();
  return new Promise((resolve,reject)=>{
    const call=dockerInvocation(['exec','-w','/workspace',container,...args],connection);
    const child=spawn(call.command,call.args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let timer,expired=false;child.stdout.on('data',onData);child.stderr.on('data',onData);
    const stop=()=>{child.kill();const call=dockerInvocation(['kill',container],connection);const killer=spawn(call.command,call.args,{windowsHide:true,stdio:'ignore'});killer.on('error',()=>{});};
    if(timeout)timer=setTimeout(()=>{expired=true;stop();},timeout*1000);
    signal?.addEventListener('abort',stop,{once:true});
    child.on('error',reject);child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);signal?.aborted||expired?reject(Error(expired?'隔离工具执行超时':'执行已停止')):resolve({exitCode:code});});
  });
}
export default async function(pi) {
  const root=process.cwd(),container=process.env.FOLIO_NATIVE_CONTAINER;
  if(!container||!process.env.FOLIO_NATIVE_SDK)throw Error('Missing comparison isolation');
  const sdk=await import(pathToFileURL(process.env.FOLIO_NATIVE_SDK).href);
  pi.on('tool_call',event=>{
    if(!['read','edit','write'].includes(event.toolName))return;
    try {const remote=remotePath(root,String(event.input?.path??''));event.input.path=path.join(root,...path.posix.relative('/workspace',remote).split('/'));}
    catch(error){return {block:true,reason:error.message};}
  });
  const file=async(op,target,data)=>{let output='';const result=await dockerCommand(container,['python3','-c',fileScript,JSON.stringify({op,path:remotePath(root,target),...(data===undefined?{}:{data:Buffer.from(data).toString('base64')})})],b=>{output+=b.toString();},undefined,30);if(result.exitCode!==0)throw Error(output);return op==='read'?Buffer.from(output.trim(),'base64'):undefined;};
  const read=target=>file('read',target),access=target=>file('access',target);
  pi.registerTool({...sdk.createReadTool(root,{operations:{readFile:read,access}})});
  pi.registerTool({...sdk.createEditTool(root,{operations:{readFile:read,access,writeFile:(target,text)=>file('write',target,text)}})});
  pi.registerTool({...sdk.createWriteTool(root,{operations:{mkdir:target=>file('mkdir',target),writeFile:(target,text)=>file('write',target,text)}})});
  pi.registerTool({...sdk.createBashTool(root,{exposeSessionEnvironment:false,operations:{exec:(command,_cwd,{onData,signal,timeout})=>dockerCommand(container,['bash','-lc',command],onData,signal,timeout??90)}})});
  pi.on('user_bash',()=>({result:{output:'请通过隔离的 bash 工具执行。',exitCode:1,cancelled:false,truncated:false}}));
}
