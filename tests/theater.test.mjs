import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const html=await fs.readFile('web/client/public/theater.html','utf8');
for(const [index,script]of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].entries())new vm.Script(script[1],{filename:'theater-inline-'+index});
const core=html.match(/<script id="director-core">([\s\S]*?)<\/script>/)[1];
const context=vm.createContext({requestAnimationFrame:()=>1,cancelAnimationFrame(){}});
vm.runInContext(core,context);
const {compileEvents,describe,Clock,stateAt,timing,ROOMS,route,seat,desk}=context.TheaterCore;
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
const event=(seq,type,extra={})=>({seq,arm:'folio',stage:'search',type,...extra});
const sequence=compileEvents([
 event(1,'prepared',{stage:'inbox'}),event(2,'index',{stage:'inbox',message:'建立索引：a.md'}),event(3,'indexed',{stage:'inbox',message:'a.md 索引就绪'}),
 event(4,'tool_start',{toolCallId:'t1'}),event(5,'tool_end',{toolCallId:'t1'}),
 event(6,'settled',{stage:'approval',state:'waiting',armStatus:'awaiting_approval'}),
 event(7,'apply_start',{stage:'approval'}),event(8,'applied',{stage:'delivery',state:'done'}),event(9,'apply_end',{stage:'approval'}),
 event(10,'settled',{stage:'delivery',state:'done',armStatus:'completed'})]);
assert.deepEqual(Array.from(sequence.slice(0,6),b=>b.work.worker),[0,1,1,2,2,3]);
assert(sequence.slice(5,9).every(b=>b.work.worker===3&&b.work.id===sequence[5].work.id),'same reviewer through human waiting and apply');
assert.equal(sequence[9].work.worker,4);
const overlap=compileEvents([...Array.from({length:7},(_,i)=>event(i+1,'tool_start',{toolCallId:'p'+i})),event(8,'tool_end',{toolCallId:'p1'}),event(9,'tool_end',{toolCallId:'p6'})]);
assert.equal(new Set(overlap.slice(0,6).map(b=>b.work.worker)).size,6);
assert.equal(overlap[6].work.worker,null,'six busy workers queue the presentation without inventing a seventh worker');
assert.equal(overlap[7].work.worker,1);assert.equal(overlap[7].promotions[0].worker,1);assert.equal(overlap[8].work.worker,1);
const sides=compileEvents([event(1,'tool_start',{arm:'native',toolCallId:'a'}),event(2,'tool_start',{toolCallId:'b'})]);assert.equal(sides[0].work.worker,0);assert.equal(sides[1].work.worker,0);assert.notEqual(sides[0].work.id,sides[1].work.id);
const stopped=compileEvents([event(1,'tool_start',{toolCallId:'a'}),event(2,'settled',{stage:'delivery',armStatus:'cancelled'})]);assert.equal(stopped[1].releases.length,1);assert.equal(stopped[1].mode,'stop');
for(const a of Object.keys(ROOMS))for(const b of Object.keys(ROOMS)){const path=route(a==='rest'?seat(0):desk(a),b==='rest'?seat(5):desk(b));assert.equal(path.at(-1).room,b);if(a!==b){assert(path.some(p=>p.x===ROOMS[a].door[0]&&p.y===ROOMS[a].door[1]));assert(path.some(p=>p.x===ROOMS[b].door[0]&&p.y===ROOMS[b].door[1]));}if(ROOMS[a].floor!==ROOMS[b].floor)assert.equal(path.filter(p=>p.x===970).length,2);}
assert.equal(route({x:120,y:1080,room:'hall'},desk('search')).filter(p=>p.x===970).length,2);assert.equal(route(seat(0),{x:120,y:1080,room:'hall'}).at(-1).room,'hall');
const clock=new Clock();let position=0,finished=false;
const first=clock.tween(200,p=>{position=p;}).then(()=>{finished=true;});
clock.frame(100);clock.frame(150);assert.equal(position,0,'paused motion stays frozen');
clock.paused=false;clock.frame(200);assert.equal(position,.25);clock.paused=true;clock.frame(250);assert.equal(position,.25);
clock.speed=2;clock.paused=false;clock.frame(300);assert.equal(position,.75);clock.frame(350);await first;assert(finished);
const cancelled=clock.tween(100,()=>{});clock.cancel();await assert.rejects(cancelled,{name:'AbortError'});clock.dispose();
assert(!html.includes('<script src='),'all theater JS is inline');
assert(html.includes('baseFrequency="0.03"')&&html.includes('scale="2.5"'));
console.log('theater: source order, independent rotation, same-owner tools/indexes/review, busy queue, stop, doors/stairs, write boundary and playback clock passed');
