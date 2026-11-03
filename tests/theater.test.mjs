import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const html=await fs.readFile('web/client/public/theater.html','utf8');
for(const [index,script]of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].entries())new vm.Script(script[1],{filename:'theater-inline-'+index});
const core=html.match(/<script id="director-core">([\s\S]*?)<\/script>/)[1];
const context=vm.createContext({requestAnimationFrame:()=>1,cancelAnimationFrame(){}});
vm.runInContext(core,context);
const {compileEvents,describe,Clock,stateAt,timing,ROOMS,route,seat,desk,reconcileSelection,bubblePlacement,STAGES,locationLabel}=context.TheaterCore;
for(const [key,name]of STAGES)assert.equal(ROOMS[key].name,name,'room sign, navigation and stage use the same everyday wording');
assert.equal(locationLabel('p.45:L7'),'第45页第7行');assert.equal(locationLabel('¶7:L1'),'第7段第1行');
const paired=compileEvents([
 {seq:1,arm:'folio',stage:'search',type:'tool_start',tool:'folio_search',toolCallId:'same',args:{query:'报销期限'}},
 {seq:2,arm:'native',stage:'evidence',type:'tool_start',tool:'read',toolCallId:'same',args:{path:'/workspace/核对文件.md'}},
 {seq:3,arm:'folio',stage:'search',type:'tool_start',tool:'folio_search',toolCallId:'other',args:{query:'备份'}},
 {seq:4,arm:'folio',stage:'evidence',type:'tool_end',tool:'folio_search',toolCallId:'same',references:[{label:'p.45'}]},
 {seq:5,arm:'native',stage:'evidence',type:'tool_end',tool:'read',toolCallId:'same'},
]);
const pairedText=describe(paired[3].event,paired[3].work.start);
assert(pairedText.caption.includes('报销期限'));assert(!pairedText.caption.includes('备份'));assert(pairedText.text.includes('第45页'));
assert(describe(paired[4].event,paired[4].work.start).caption.includes('核对文件.md'),'end events reuse their own matched start arguments without mixing sides');
const unknown=describe({type:'tool_start',tool:'bash',stage:'search',arm:'native',args:{command:'arbitrary-command --all-pages'}});
assert(unknown.caption.includes('查找'));assert(!/arbitrary|全部|翻遍|--all/.test(unknown.caption),'native commands are not reverse engineered into invented actions');
assert.doesNotThrow(()=>describe({type:'tool_start',tool:'read',arm:'native'}));
const long=describe({type:'tool_start',tool:'folio_search',arm:'folio',args:{query:'中文😀'.repeat(100)}});
assert(Array.from(long.text).length<=32);assert(!/\ud83d(?!\ude00)/.test(long.text));assert(long.text.includes('…'));
const noHits=describe({type:'tool_end',tool:'folio_search',arm:'folio',detail:'no hits for "报销期限" (all documents)'});
assert(noHits.text.includes('没有匹配'));assert.equal(noHits.emotion,'sweat');assert(!noHits.caption.includes('继续搜索'),'no future search is invented');
const incomplete=describe({type:'tool_end',tool:'folio_search',arm:'folio',detail:'incomplete search; no matches observed for "test"'});
assert(incomplete.text.includes('未完成'));assert(incomplete.caption.includes('不能判断'));
assert.equal(describe({type:'tool_end',tool:'read',detail:'quoted text: no hits for x',arm:'native'}).emotion,'normal');
const related=describe({type:'tool_end',tool:'folio_page',arm:'folio',references:[{label:'p.45'}]});
assert(related.text.includes('相关内容'));assert(!related.text.includes('答案'));assert(related.caption.includes('还要核对'));
for(const tool of ['edit','write','folio_revise']){
 const d=describe({type:'tool_end',tool,arm:tool==='folio_revise'?'folio':'native',state:'done'});
 assert(!['stamp','nativeWrite'].includes(d.action));assert(!d.text.includes('保存成功'));
}
assert(describe({type:'tool_end',tool:'folio_revise',arm:'folio',state:'done'}).text.includes('还没改'));
assert.equal(describe({type:'native_write',arm:'native'}).action,'nativeWrite');
const addedOnly=describe({type:'native_write',arm:'native'},undefined,[{status:'unchanged'},{status:'added'}]);
assert.equal(addedOnly.stampText,'新增文件');assert(addedOnly.text.includes('原有文件没改'));
assert.equal(describe({type:'native_write',arm:'native'},undefined,[{status:'modified'}]).stampText,'副本有改动');
assert(!describe({type:'native_write',arm:'native'}).text.includes('已改变'),'a legacy event alone does not identify an original-file edit');
assert.equal(describe({type:'applied',arm:'folio',state:'done'}).action,'stamp');
for(const e of [{type:'applied',state:'error'},{type:'tool_end',tool:'folio_page',state:'error',references:[{label:'p.1'}]},{type:'settled',armStatus:'failed'}]){
 const d=describe({...e,arm:'folio'});assert.equal(d.action,'error');assert.equal(d.emotion,'shock');
}
assert.equal(describe({type:'settled',arm:'native',armStatus:'cancelled'}).action,'stop');
assert(describe({type:'settled',arm:'folio',armStatus:'awaiting_approval'}).caption.includes('还没有'));
const centered=bubblePlacement({x:200,y:180,footX:200,footY:260},180,60,500,400);
assert.equal(centered.left+centered.tailX,200);assert.equal(centered.top+60+12,180);assert(!centered.below);
const edge=bubblePlacement({x:22,y:180,footX:22,footY:260},180,60,500,400);
assert.equal(edge.left,8);assert.equal(edge.left+edge.tailX,22,'clamping the balloon keeps its tail on the speaker');
const crowded=bubblePlacement({x:200,y:25,footX:204,footY:120},180,60,500,400);
assert(crowded.below);assert.equal(crowded.top,132);assert.equal(crowded.left+crowded.tailX,204);
assert(!bubblePlacement({x:-20,y:100},180,60,500,400).visible,'offscreen speakers do not put balloons above another actor');
assert(!bubblePlacement({x:200,y:450},180,60,500,400).visible);
const picked=reconcileSelection(new Set(['a']),new Set(['a','b']),[{id:'a',status:'ready'},{id:'b',status:'ready'},{id:'c',status:'ready'},{id:'scan',status:'no_text'}],true);assert.deepEqual(Array.from(picked),['a','c']);
assert.deepEqual(Array.from(reconcileSelection(picked,new Set(['a','b','c']),[{id:'c',status:'ready',name:'renamed.md'}],true)),['c']);
assert.deepEqual(Array.from(reconcileSelection(picked,new Set(['a','c']),[{id:'a',status:'parse_failed'}],true)),[]);
const entry=await fs.readFile('web/client/index.html','utf8');assert(entry.includes('target.search=location.search'));assert(!entry.includes('main.tsx'));assert(!html.includes('回到工坊'));assert(html.includes('id="files-button"'));
const elapsed=timing({startedAt:'2026-11-01T00:00:00Z',awaitingSince:'2026-11-01T00:00:05Z',confirmationMs:0},Date.parse('2026-11-01T00:00:10Z'));assert.equal(elapsed.execution,5000);assert.equal(elapsed.human,5000);
assert.equal(stateAt([],'native'),'queued');assert.equal(stateAt([{arm:'native',type:'tool_start'}],'native'),'running');assert.equal(stateAt([{arm:'native',armStatus:'failed'}],'native'),'failed');
for(const name of ['pdf','edit','delete']){
 const c=JSON.parse(await fs.readFile(`web/demos/${name}.json`,'utf8'));
 const beats=compileEvents(c.events);
 assert(beats.length>10);
 assert.deepEqual(Array.from(beats,b=>b.id),c.events.filter(e=>beats.some(b=>b.id===e.seq)).map(e=>e.seq));
 for(const arm of ['native','folio'])assert.deepEqual(Array.from(beats.filter(b=>b.arm===arm),b=>b.event.originalSeq),c.events.filter(e=>e.arm===arm&&beats.some(b=>b.id===e.seq)).map(e=>e.originalSeq));
 assert(beats.filter(b=>describe(b.event,b.work?.start).action==='stamp').every(b=>b.event.type==='applied'&&b.event.state==='done'));
 assert(beats.every(b=>Array.from(describe(b.event,b.work?.start).text).length<=32),'short readable dialogue');
 const before=JSON.stringify(c.events);compileEvents(c.events);assert.equal(JSON.stringify(c.events),before,'presentation leaves historical events unchanged');
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
