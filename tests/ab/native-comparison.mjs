// Run the current Folio against native pi, with a fresh isolated home per attempt.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { snapshotPiConfig } from "./isolation.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputArg=process.argv.indexOf("--runs");
const output = path.resolve(root,outputArg<0?"tests/tmp/native-comparison-2026-10-31-guarded":process.argv[outputArg+1]);
const relativeOutput=path.relative(path.join(root,"tests/tmp"),output);
if(!relativeOutput||relativeOutput.startsWith("..")||path.isAbsolute(relativeOutput)) throw new Error("Run output must stay inside tests/tmp");
if (fs.existsSync(path.join(output,"manifest.json"))) throw new Error("Run directory already exists; preserve it and choose a new dated run directory");
fs.mkdirSync(output,{recursive:true});
const personalPi = path.join(process.env.USERPROFILE || process.env.HOME,".pi");
const before = snapshotPiConfig(personalPi);
const hash = p => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const spec = JSON.parse(fs.readFileSync(path.join(root,"tests/ab/questions-context.json"),"utf8"));
spec.description = "当前 Folio MCP 对比原生 pi；相同六题各三次。扫描件允许有证据的识别，合理拒答与实际识别分别人工判定。";
const scan = spec.questions.find(q=>q.id==="q9-scan");
delete scan.forbid;
scan.note = "无文本层。有实际图像/OCR证据的识别可算回答成功；如实拒答另记安全处理，不能冒充已识别。";
const qfile = path.join(root,"tests/ab/questions-native.json");
fs.writeFileSync(qfile,JSON.stringify(spec,null,2)+"\n");
const args = ["tests/ab/run.mjs","--arms","A,B","--repeat","3","--conc","1","--order","paired","--retries","0","--pause-ms","25000","--timeout","180","--corpus","tests/ab/corpus2","--qfile","tests/ab/questions-native.json","--runs",path.relative(root,output)];
const corpus = Object.fromEntries(fs.readdirSync(path.join(root,"tests/ab/corpus2")).sort().map(f=>[f,hash(path.join(root,"tests/ab/corpus2",f))]));
const manifest = { startedAt:new Date().toISOString(),commit:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim(),
  model:"aigw/DeepSeek-V4-Flash-0731-W8A8",piVersion:"1.4.0",args,questionHash:hash(qfile),corpus,
  personalConfigBefore:before,personalConfigAfter:null,personalConfigUnchanged:null,
  isolation:"Per attempt: separate PI_CODING_AGENT_DIR, HOME/USERPROFILE, APPDATA, caches, temp and npm config. Sessions/context/skills/templates disabled. Fresh homes have no personal extensions; built-in extensions remain enabled because pi implements MCP as one. Both arms load the same tool-input guard, remapping literal /tmp into the private temp directory and blocking pi paths/file-tool escapes. Configuration and tool-input isolation, not an OS filesystem sandbox." };
fs.writeFileSync(path.join(output,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
const child = spawn(process.execPath,args,{cwd:root,env:process.env,windowsHide:true,stdio:["ignore","inherit","inherit"]});
child.on("error",err=>{console.error(err.message);process.exitCode=1;});
child.on("close",code=>{
  manifest.finishedAt=new Date().toISOString(); manifest.exitCode=code;
  manifest.personalConfigAfter=snapshotPiConfig(personalPi);
  manifest.personalConfigUnchanged=JSON.stringify(manifest.personalConfigBefore)===JSON.stringify(manifest.personalConfigAfter);
  manifest.corpusUnchanged=Object.entries(corpus).every(([f,h])=>hash(path.join(root,"tests/ab/corpus2",f))===h);
  fs.writeFileSync(path.join(output,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
  console.log(JSON.stringify({personalConfigUnchanged:manifest.personalConfigUnchanged,corpusUnchanged:manifest.corpusUnchanged,exitCode:code}));
  process.exitCode=code || (manifest.personalConfigUnchanged && manifest.corpusUnchanged ? 0 : 1);
});
