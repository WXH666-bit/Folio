import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const execute=promisify(execFile);
let selected;
export function connectionFor(mode,platform,hasDocker,distro='') {
  if(!['auto','direct','wsl'].includes(mode))throw Error('FOLIO_DOCKER_MODE 只能是 auto、direct 或 wsl');
  if(mode==='direct'||(mode==='auto'&&hasDocker))return{command:'docker',prefix:[],kind:'direct',label:'Docker'};
  if(platform==='win32'&&(mode==='wsl'||mode==='auto'))return{command:'wsl.exe',prefix:[...(distro?['-d',distro]:[]),'--exec','docker'],kind:'wsl',label:'WSL Docker'};
  throw Error('没有找到 Docker；请安装 Docker 并准备对照工具镜像');
}
export async function dockerConnection(){
  if(!selected){const mode=process.env.FOLIO_DOCKER_MODE??'auto';const direct=mode==='auto'?spawnSync('docker',['--version'],{windowsHide:true,stdio:'ignore',timeout:4000}).status===0:mode==='direct';selected=connectionFor(mode,process.platform,direct,process.env.FOLIO_WSL_DISTRO??'');}
  return selected;
}
export function dockerInvocation(args,connection){return{command:connection.command,args:[...connection.prefix,...args]};}
export async function dockerRun(args,timeout=30000){const call=dockerInvocation(args,await dockerConnection());const result=await execute(call.command,call.args,{windowsHide:true,timeout,maxBuffer:4*1024*1024});return result.stdout.trim();}
export function mappedHostDataPath(file,localData,hostData){if(!localData||!hostData)return;const rel=path.relative(path.resolve(localData),path.resolve(file));if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))return;return path.posix.join(hostData.replace(/\\/g,'/'),...rel.split(path.sep));}
export async function dockerPath(file,connection){const mapped=mappedHostDataPath(file,process.env.FOLIO_WEB_DATA,process.env.FOLIO_DOCKER_HOST_DATA_ROOT);if(mapped)return mapped;const c=connection??await dockerConnection();if(c.kind==='direct')return path.resolve(file);const prefix=c.prefix.slice(0,-2);const result=await execute(c.command,[...prefix,'--exec','wslpath','-a',path.resolve(file)],{windowsHide:true,timeout:15000});return result.stdout.trim();}
export async function holdDockerHost(){
  const c=await dockerConnection();if(c.kind!=='wsl')return{close(){}};
  // WSL may stop systemd services when its last foreground client exits. The open
  // stdin keeps this owned client alive; parent exit closes the pipe automatically.
  const child=spawn(c.command,[...c.prefix.slice(0,-2),'--exec','cat'],{windowsHide:true,stdio:['pipe','ignore','ignore']});
  child.on('error',()=>{});child.stdin.on('error',()=>{});
  return{close(){child.stdin.end();}};
}
