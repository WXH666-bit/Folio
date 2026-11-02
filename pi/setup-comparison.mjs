import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {dockerConnection,dockerInvocation,dockerPath} from '../web/server/docker-client.mjs';
const root=path.resolve(import.meta.dirname,'..');
const connection=await dockerConnection();
function run(args){const call=dockerInvocation(args,connection);const r=spawnSync(call.command,call.args,{stdio:'inherit',windowsHide:true});if(r.status!==0)process.exit(r.status??1);}
const context=await dockerPath(path.join(root,'pi/tools'),connection);
// Build-time proxy values come from the existing WSL environment. They are not passed to runtime containers.
const network=process.env.FOLIO_DOCKER_BUILD_NETWORK??(connection.kind==='wsl'||process.platform==='linux'?'host':'');
run(['build',...(network?['--network',network]:[]),'--build-arg','HTTP_PROXY','--build-arg','HTTPS_PROXY','--build-arg','http_proxy','--build-arg','https_proxy','-t','folio-comparison-tools:1',context]);
