const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {rolloutTurnSegments,replayHistory,createModelPicker}=require('../src/router.js');
const row=(type,payload,ordinal)=>JSON.stringify({type,payload,ordinal})+'\n';
const turn=(id,text)=>row('event_msg',{type:'task_started',turn_id:id},1)+row('response_item',{type:'message',role:'user',content:[{type:'input_text',text}]},2)+row('response_item',{type:'function_call',call_id:id,name:'lookup',arguments:'{}'},3)+row('response_item',{type:'function_call_output',call_id:id,output:'result'},4)+row('event_msg',{type:'task_complete',turn_id:id},5);
test('single-turn replay retains ABD and whole tool pairs, with fresh contiguous ordinals',()=>{
 const original=rolloutTurnSegments(row('session_meta',{id:'chat'},0)+turn('A','a')+turn('B','b')+turn('C','remove')+turn('D','d'));
 const prefix=row('session_meta',{id:'chat',history_base:{end_ordinal_exclusive:0}},0);
 const result=replayHistory(prefix,['A','B','D'],original.turns),parsed=rolloutTurnSegments(result);
 assert.deepEqual([...parsed.turns.keys()],['A','B','D']);assert(!result.includes('remove'));
 assert.deepEqual(parsed.records.map(r=>r.ordinal),parsed.records.map((_,i)=>i));
 assert.equal(parsed.records.filter(r=>r.payload?.type==='function_call').length,3);
 assert.equal(parsed.records.filter(r=>r.payload?.type==='function_call_output').length,3);
});
test('replay excludes compaction snapshots that could contain deleted context',()=>{
 const original=rolloutTurnSegments(turn('D','keep')+row('compacted',{message:'deleted text'},6)+row('response_item',{type:'compaction',encrypted_content:'stale'},7));
 const result=replayHistory(row('session_meta',{id:'chat'},0),['D'],original.turns);
 assert(!result.includes('deleted text'));assert(!result.includes('stale'));assert(result.includes('keep'));
});
test('replay fails before writing when a retained turn is missing or reset is not empty',()=>{
 assert.throws(()=>replayHistory(turn('A','a'),[],new Map()),/未清空/);
 assert.throws(()=>replayHistory(row('session_meta',{id:'chat'},0),['X'],new Map()),/缺失/);
});
test('history actions reject running threads without mutations',async()=>{
 const picker=createModelPicker({providers:[]}),calls=[];
 const rpc=async(m,p)=>{calls.push(m);if(m==='thread/read')return {thread:{id:'chat',historyMode:'paginated',status:{type:'active'}}};throw Error('Unexpected '+m)};
 await assert.rejects(picker.run('local','modelPicker/history/edit',{threadId:'chat',turnId:'C',action:'delete'},async()=>({}),rpc),/任务结束/);
 assert.deepEqual(calls,['thread/read']);
});
function controls(){
 let request,release,cursor=0;const states=[],ref={current:false};
 const context={__codexModelPickerHistory:p=>{request=p;return new Promise(resolve=>release=resolve)}};
 const jsx=(type,props,key)=>({type,props,key});
 const component=vm.runInNewContext(fs.readFileSync('src/history-buttons.js','utf8')+';__codexHistoryActionsUI',context);
 const render=hostId=>{cursor=0;return component({threadId:'chat',turnId:'C',hostId,useState:v=>{const i=cursor++;if(!(i in states))states[i]=v;return [states[i],x=>states[i]=x]},useRef:()=>ref,jsx,jsxs:jsx,Button:'button',Tooltip:'tooltip'})};
 return {render,states,getRequest:()=>request,release:()=>release?.()};
}
test('trash and rotating-arrow controls invoke real history actions for the exact thread and turn',async()=>{
 const f=controls(),tree=f.render('local'),buttons=tree.props.children.map(t=>t.props.children);
 assert.deepEqual(Array.from(buttons,b=>b.props['data-model-picker-history-action']),['delete','rewind']);
 assert(buttons.every(b=>b.props.children.type==='svg'));
 buttons[0].props.onClick();assert.equal(f.getRequest(),undefined);
 const confirm=f.render('local').props.children.at(-1).props.children[1];
 const pending=confirm.props.onClick();await confirm.props.onClick();
 assert.equal(f.getRequest().action,'delete');assert.equal(f.getRequest().threadId,'chat');assert.equal(f.getRequest().turnId,'C');
 f.release();await pending;
});
test('cancelled confirmation and remote chats cannot invoke local history changes',async()=>{
 const f=controls();f.render('local').props.children[0].props.children.props.onClick();
 f.render('local').props.children.at(-1).props.children[2].props.onClick();assert.equal(f.getRequest(),undefined);
 assert.equal(f.render('remote-host'),null);
});
