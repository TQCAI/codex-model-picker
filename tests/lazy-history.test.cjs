const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createModelPicker}=require('../src/router.js');
async function fixture(fresh=true,message='No such file or directory (os error 2)') {
 const picker=createModelPicker({providers:[]}),calls=[];
 const thread={id:'empty',path:'/test/rollout-empty.jsonl',modelProvider:'openai',model:'gpt',ephemeral:false,status:{type:'idle'}};
 const rpc=async(m,p)=>{
  calls.push([m,p]);
  if(m==='thread/read')return {thread};
  if(m==='fs/getMetadata')throw Error(message);
  throw Error('Unexpected RPC '+m);
 };
 if(fresh)await picker.run('local','thread/start',{},async()=>({thread}),rpc);
 return {picker,thread,rpc,calls,send:(method,params={},next=async()=>({}))=>picker.run('local',method,{threadId:thread.id,...params},next,rpc)};
}
test('a new GPT chat can submit its first message before lazy history exists',async()=>{
 const f=await fixture();let committed=0;
 await f.send('thread/settings/update',{model:'gpt'});
 await f.send('turn/start',{input:[]},async()=>{committed++;return {turn:{id:'one'}}});
 assert.equal(committed,1);assert(!f.calls.some(([m])=>m==='fs/writeFile'||m==='thread/archive'));
 await assert.rejects(f.send('turn/start'),/No such file/,'An accepted turn retires the empty-thread exception');
});
test('missing existing history and filesystem permission failures never count as empty',async()=>{
 const existing=await fixture(false);await assert.rejects(existing.send('turn/start'),/No such file/);
 const denied=await fixture(true,'Permission denied (os error 13)');await assert.rejects(denied.send('turn/start'),/Permission denied/);
 for(const f of [existing,denied])assert(!f.calls.some(([m])=>m==='thread/archive'||m==='fs/writeFile'));
});
test('injected context and externally started turns retire the fresh-thread exception',async()=>{
 const injected=await fixture();await injected.send('thread/inject_items',{items:[]});
 await assert.rejects(injected.send('turn/start'),/No such file/);
 const external=await fixture();external.picker.ignoreNotification('local','turn/started',{threadId:'empty',turn:{id:'one'}});
 await assert.rejects(external.send('turn/start'),/No such file/);
});
test('a failed native resume of an unused thread does not block its first message',async()=>{
 const f=await fixture();
 await assert.rejects(f.send('thread/resume',{},async()=>{throw Error('no rollout found')}),/no rollout/);
 let sent=false;await f.send('turn/start',{},async()=>{sent=true;return {}});assert(sent);
});
