// Applied equally to both arms. This is a tool-input guard, not an OS sandbox.
import fs from "node:fs";
import path from "node:path";

export function guardInput(event, privateRoot, workDir, tempDir) {
  const input=event.input;
  if(!input||typeof input!=="object") return;
  const text=JSON.stringify(input).replace(/\\+/g,"/");
  if(/(?:^|[\/"'\s])\.pi(?:[\/"'\s]|$)/i.test(text)) return {block:true,reason:"Benchmark isolation: accessing pi configuration paths is prohibited. Use only the current document folder."};
  const remap=s=>s.replace(/(?<![\w./-])(?:[a-z]:)?[\\/]+tmp(?=[\\/"'\s;]|$)/gi,tempDir.replace(/\\/g,"/"));
  let changed=false;
  if(event.toolName==="bash"&&typeof input.command==="string"){
    const mapped=remap(input.command); changed=mapped!==input.command; input.command=mapped;
  }
  if(["read","write","edit"].includes(event.toolName)&&typeof input.path==="string"){
    const mapped=remap(input.path); changed=mapped!==input.path; input.path=mapped;
    const target=path.resolve(workDir,input.path),relative=path.relative(privateRoot,target);
    if(relative.startsWith("..")||path.isAbsolute(relative)) return {block:true,reason:"Benchmark isolation: file tools must stay in this run's private directory."};
  }
  return {changed};
}

export default function(pi){
  pi.on("tool_call",async event=>{
    const root=process.env.FOLIO_BENCH_PRIVATE_ROOT;
    if(!root) return {block:true,reason:"Missing benchmark isolation root"};
    const result=guardInput(event,root,process.cwd(),process.env.TEMP);
    if(result?.changed||result?.block) fs.appendFileSync(path.join(root,"path-guard.jsonl"),JSON.stringify({tool:event.toolName,remapped:!!result.changed,blocked:!!result.block})+"\n");
    return result?.block?{block:true,reason:result.reason}:undefined;
  });
}
