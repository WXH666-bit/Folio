import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const html=await fs.readFile('web/client/public/theater.html','utf8');
for(const [index,script]of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].entries())new vm.Script(script[1],{filename:'theater-inline-'+index});
const core=html.match(/<script id="director-core">([\s\S]*?)<\/script>/)[1];
const context=vm.createContext({requestAnimationFrame:()=>1,cancelAnimationFrame(){}});
vm.runInContext(core,context);
const {compileEvents,describe,Clock,stateAt,timing}=context.TheaterCore;
const elapsed=timing({startedAt:'2026-11-01T00:00:00Z',awaitingSince:'2026-11-01T00:00:05Z',confirmationMs:0},Date.parse('2026-11-01T00:00:10Z'));assert.equal(elapsed.execution,5000);assert.equal(elapsed.human,5000);
assert.equal(stateAt([],'native'),'queued');assert.equal(stateAt([{arm:'native',type:'tool_start'}],'native'),'running');assert.equal(stateAt([{arm:'native',armStatus:'failed'}],'native'),'failed');
for(const name of ['pdf','edit','delete']){
 const c=JSON.parse(await fs.readFile(`web/demos/${name}.json`,'utf8'));
 const beats=compileEvents(c.events);
 assert(beats.length>10);
 assert.deepEqual(Array.from(beats,b=>b.id),c.events.filter(e=>beats.some(b=>b.id===e.seq)).map(e=>e.seq));
 for(const arm of ['native','folio'])assert.deepEqual(Array.from(beats.filter(b=>b.arm===arm),b=>b.event.originalSeq),c.events.filter(e=>e.arm===arm&&beats.some(b=>b.id===e.seq)).map(e=>e.originalSeq));
 assert(beats.filter(b=>describe(b.event).action==='stamp').every(b=>b.event.type==='applied'&&b.event.state==='done'));
 assert(beats.every(b=>describe(b.event).text.length<=32),'short readable dialogue');
}
assert.equal(describe({type:'failed',detail:'pi 启动握手超时',arm:'native'}).emotion,'shock');
assert.equal(describe({type:'notice',message:'独立 pi 仍在启动',arm:'native'}).emotion,'sweat');
assert.equal(describe({type:'settled',stage:'approval',state:'waiting',arm:'folio'}).action,'wait');
assert.notEqual(describe({type:'tool_end',tool:'edit',arm:'native'}).action,'stamp','tool success cannot prove physical write');
const clock=new Clock();let position=0,finished=false;
const first=clock.tween(200,p=>{position=p;}).then(()=>{finished=true;});
clock.frame(100);clock.frame(150);assert.equal(position,0,'paused motion stays frozen');
clock.paused=false;clock.frame(200);assert.equal(position,.25);clock.paused=true;clock.frame(250);assert.equal(position,.25);
clock.speed=2;clock.paused=false;clock.frame(300);assert.equal(position,.75);clock.frame(350);await first;assert(finished);
const cancelled=clock.tween(100,()=>{});clock.cancel();await assert.rejects(cancelled,{name:'AbortError'});clock.dispose();
assert(!html.includes('<script src='),'all theater JS is inline');
assert(html.includes('baseFrequency="0.03"')&&html.includes('scale="2.5"'));
console.log('theater: three real recordings, source order, honest write/wait/error states, short dialogue, pause/speed/cancel clock and single-file assets passed');
