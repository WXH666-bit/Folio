import fs from 'node:fs/promises';import vm from 'node:vm';import assert from 'node:assert/strict';
const html=await fs.readFile('web/client/public/theater.html','utf8');
for(const [i,s]of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].entries())new vm.Script(s[1],{filename:'theater-'+i});
const ctx=vm.createContext({requestAnimationFrame:()=>1,cancelAnimationFrame(){}});vm.runInContext(html.match(/<script id="director-core">([\s\S]*?)<\/script>/)[1],ctx);
const {synchronize,presentedEvents,playedFrontiers,restorePlayback}=ctx.TheaterCore;
const completed=t=>presentedEvents(t.beats,t.beats.length),keys=t=>Array.from(t.beats,n=>n.key);
function check(t){
 for(const n of t.beats){assert(Object.keys(n.sides).length>=1&&Object.keys(n.sides).length<=2);for(const s of Object.values(n.sides)){assert.equal(s.kind,n.kind);assert.equal(s.beat.stage,n.stage);}assert(n.caption.length>0);}
 for(const arm of ['native','folio']){const a=Array.from(completed(t).filter(b=>b.arm===arm),b=>b.id);assert.deepEqual(a,[...a].sort((a,b)=>a-b),'source order survives concurrent checkpoints');}
 assert.equal(new Set(completed(t).map(b=>b.arm+':'+b.id)).size,completed(t).length,'events commit exactly once');
 for(const r of t.rounds)assert(t.beats.slice(r.from,r.to).every(n=>n.stage===r.stage&&n.round===r.key));
}
for(const key of ['pdf','edit','delete']){
 const c=JSON.parse(await fs.readFile(`web/demos/${key}.json`,'utf8')),source=JSON.stringify(c.events),t=synchronize(c.events);check(t);
 assert.deepEqual(Array.from(completed(t),b=>b.arm+':'+b.id).sort(),Array.from(t.raw,b=>b.arm+':'+b.id).sort(),'all captured actions are retained');
 assert(['dispatch','accept','arrive','process','handoff','return'].every(kind=>t.beats.some(n=>n.kind===kind&&n.sides.native&&n.sides.folio)),'genuine shared work pairs at all common checkpoints');
 assert(t.beats.filter(n=>Object.values(n.sides).some(s=>['index','indexed'].includes(s.source.type))).every(n=>!n.sides.native),'no native indexing is invented');
 if(key==='pdf')assert.equal(t.rounds.filter(r=>r.stage==='search').length,2);
 if(key==='delete')assert(t.rounds.some(r=>r.stage==='evidence'&&r.visit===2&&r.parts.folio.absent));
 if(key!=='pdf')assert(completed(t).filter(b=>['apply_start','applied','apply_end'].includes(b.event.type)).every(b=>b.stage==='approval'));
 let last=[];for(let n=0;n<=c.events.length;n++){const events=c.events.slice(0,n),statuses=Object.fromEntries(['native','folio'].map(a=>[a,events.findLast(e=>e.arm===a&&e.armStatus)?.armStatus||'running']));const live=synchronize(events,{live:true,statuses});check(live);const current=keys(live);assert.deepEqual(current.slice(0,last.length),last,`${key}: append must not rewrite played nodes at prefix ${n}`);last=current;}
 assert.deepEqual(last,keys(t));assert.equal(JSON.stringify(c.events),source);
 for(let i=0;i<=t.beats.length;i++)assert.equal(restorePlayback(t,{version:3,next:t.beats[i]?.key||null,played:playedFrontiers(t.beats,i)}),i,'joint checkpoint is restored even mid-event');
 for(const i of [1,Math.floor(t.beats.length/2),t.beats.length]){const at=restorePlayback(t,{version:2,played:playedFrontiers(t.beats,i)});assert(at===t.beats.length||t.beats.findIndex(n=>n.pair===t.beats[at].pair)===at);}
 for(const cursor of [1,Math.floor(t.raw.length/2),t.raw.length]){const at=restorePlayback(t,{cursor});assert.equal(t.beats.findIndex(n=>n.pair===t.beats[at].pair),at);}
}
let seq=0;const e=(arm,type,stage,extra={})=>({seq:++seq,arm,type,stage,...extra});
const initial=[e('native','prepared','inbox'),e('folio','prepared','inbox')];const open=synchronize(initial,{live:true});assert(open.beats.length>0);assert(open.beats.every(n=>n.sides.native&&n.sides.folio));assert.equal(open.waiting.reason,'records');assert(!open.complete);assert(!open.rounds[0].closed,'known actions can play while the open phase waits for proof of completion');
const leftReady=[...initial,e('native','tool_start','search',{toolCallId:'a'})];assert(synchronize(leftReady,{live:true}).beats.every(n=>n.stage==='inbox'),'the faster side cannot enter search before its counterpart leaves inbox');
const rightReady=[...leftReady,e('folio','tool_start','search',{toolCallId:'b'})],together=synchronize(rightReady,{live:true});assert(together.beats.length>0);assert(together.beats.every(n=>n.sides.native&&n.sides.folio));
const crossed=synchronize([...rightReady,e('native','tool_end','evidence',{toolCallId:'a'})]);assert.equal(completed(crossed).find(b=>b.event.type==='tool_end').stage,'search');
const concurrent=synchronize([e('native','tool_start','search',{toolCallId:'x'}),e('folio','tool_start','search',{toolCallId:'x'}),e('native','tool_start','evidence',{toolCallId:'y'}),e('native','tool_end','search',{toolCallId:'x'}),e('folio','tool_end','search',{toolCallId:'x'}),e('native','tool_end','evidence',{toolCallId:'y'})]);check(concurrent);
for(const arm of ['native','folio'])for(const call of ['x','y']){const pair=completed(concurrent).filter(b=>b.arm===arm&&b.event.toolCallId===call);if(pair.length)assert.equal(pair[0].work.worker,pair[1].work.worker);}
assert.notEqual(completed(concurrent).find(b=>b.arm==='native'&&b.event.toolCallId==='x').work.worker,completed(concurrent).find(b=>b.arm==='native'&&b.event.toolCallId==='y').work.worker);
const review=[e('native','native_write','approval'),e('native','settled','delivery',{armStatus:'completed'}),e('folio','settled','approval',{state:'waiting',armStatus:'awaiting_approval'})];
const held=synchronize(review,{live:true,statuses:{folio:'awaiting_approval'}});assert.equal(held.waiting.reason,'approval');assert(!held.complete);assert(held.beats.some(n=>n.kind==='process'&&n.sides.native&&n.sides.folio));
const holdNode=held.beats.findIndex(n=>n.completed.some(b=>b.mode==='hold'));assert(holdNode>=0);assert(!presentedEvents(held.beats,holdNode).some(b=>b.mode==='hold'));
const applying=[...review,e('folio','apply_start','approval'),e('folio','applied','delivery',{state:'done'}),e('folio','apply_end','approval')],pending=synchronize(applying,{live:true,statuses:{folio:'running'}});assert.deepEqual(keys(pending).slice(0,held.beats.length),keys(held));assert(completed(pending).filter(b=>b.arm==='folio').every(b=>b.stage==='approval'));assert.equal(new Set(completed(pending).filter(b=>b.arm==='folio').map(b=>b.work.worker)).size,1);
const finished=synchronize([...applying,e('folio','settled','delivery',{armStatus:'completed'})],{live:true});assert(finished.complete);check(finished);
for(const status of ['failed','cancelled','interrupted']){const stopped=synchronize([e('native','tool_start','search',{toolCallId:'stop'}),e('folio','prepared','inbox'),e('native','settled','delivery',{armStatus:status}),e('folio','settled','delivery',{armStatus:'completed'})],{live:true});check(stopped);const stop=completed(stopped).find(b=>b.mode==='stop');assert.equal(stop.releases.length,1);assert.equal(stop.stage,'search');assert(stopped.complete);}
assert(!synchronize(initial,{live:true,statuses:{native:'completed',folio:'running'}}).complete,'snapshot status cannot prematurely close an open event tail');
console.log('theater parallel: paired checkpoints, independent order, extra actions, concurrent owners, streamed stability, review gate and v1/v2/v3 progress passed');
