const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createModelPicker}=require('../src/router.js');
const catalog={providers:[{id:'external',name:'DS',config:{wire_api:'responses',base_url:'http://127.0.0.1:1',requires_openai_auth:false},models:[{id:'ds'}]}]};
async function fixture(provider='external',status='idle') {
 const picker=createModelPicker(catalog),calls=[];
 const state={id:'same-chat',modelProvider:provider,model:provider==='external'?'ds':'gpt',status:{type:status},path:'/test/rollout-same-chat.jsonl',ephemeral:false,cwd:'/workspace'};
 const files=new Map([[state.path,Buffer.from('{"type":"turn_context","payload":{"model":"ds"}}\n').toString('base64')]]);
 const sandbox={type:'workspaceWrite',writableRoots:['/workspace'],networkAccess:false};
 let loaded=true,archived=false;
 const rpc=async(method,p)=>{
  calls.push([method,p]);
  if(method==='fs/getMetadata')return {isFile:true,isSymlink:false};
  if(method==='fs/readFile')return {dataBase64:files.get(p.path)};
  if(method==='fs/writeFile'){files.set(p.path,p.dataBase64);return {}};
  if(method==='fs/copy'){files.set(p.destinationPath,files.get(p.sourcePath));return {}};
  if(method==='thread/backgroundTerminals/list'||method==='thread/list')return {data:[]};
  if(method==='thread/goal/get')return {goal:null};
  if(method==='thread/read')return {thread:{...state,status:loaded?state.status:{type:'notLoaded'}}};
  if(method==='thread/archive'){assert.equal(picker.ignoreNotification('local','thread/archived',{threadId:state.id}),true);archived=true;loaded=false;return {}};
  if(method==='thread/unarchive'){archived=false;return {thread:{...state}}};
  if(method==='thread/resume'){
   if(!loaded){state.model=p.model;state.modelProvider=p.modelProvider;loaded=true;}
   return {thread:{...state},model:state.model,modelProvider:state.modelProvider,cwd:state.cwd,sandbox,approvalPolicy:'on-request',approvalsReviewer:'user',disabledPluginIds:['disabled-tool']};
  }
  if(method==='thread/settings/update'){if(p.model)state.model=p.model;return {}};
  throw Error('Unexpected RPC '+method);
 };
 await picker.run('local','thread/read',{threadId:state.id},p=>rpc('thread/read',p));calls.length=0;
 const select=(model,commit=p=>rpc('thread/settings/update',p))=>picker.run('local','thread/settings/update',{threadId:state.id,model},commit,rpc);
 return {picker,state,calls,select,rpc,sandbox,files,isArchived:()=>archived};
}
test('DeepSeek -> GPT -> DeepSeek keeps the same chat, restores permissions and clears external provider',async()=>{
 const f=await fixture();await f.select('gpt');assert.equal(f.state.modelProvider,'openai');assert.equal(f.state.id,'same-chat');
 const nativeResume=f.calls.find(([m,p])=>m==='thread/resume'&&p.model==='gpt')[1];
 assert.equal(nativeResume.modelProvider,'openai');assert.equal(nativeResume.config,undefined);
 assert(f.calls.some(([m,p])=>m==='thread/settings/update'&&p.sandboxPolicy===f.sandbox&&p.approvalPolicy==='on-request'));
 assert.equal(f.picker.providerFor('same-chat'),'openai');
 await f.select('ds');assert.equal(f.state.modelProvider,'external');assert.equal(f.picker.providerFor('same-chat'),'external');
 assert.equal(f.isArchived(),false);assert(!f.calls.some(([m])=>m.startsWith('config/')));
});
test('a busy conversation never archives or interrupts the running task',async()=>{
 const f=await fixture('external','active');await assert.rejects(f.select('gpt'),/等待当前任务结束/);
 assert(!f.calls.some(([m])=>m==='thread/archive'||m==='turn/interrupt'));
});
test('failed target settings restore the original provider and keep chat visible',async()=>{
 const f=await fixture();await assert.rejects(f.select('gpt',async()=>{throw Error('settings rejected')}),/settings rejected/);
 assert.equal(f.state.modelProvider,'external');assert.equal(f.state.model,'ds');assert.equal(f.isArchived(),false);
 assert.equal(f.picker.providerFor('same-chat'),'external');assert.equal(f.picker.ignoreNotification('local','thread/archived',{threadId:'same-chat'}),false);
});
test('rapid opposite selections are serialized and finish on the last provider',async()=>{
 const f=await fixture();await Promise.all([f.select('gpt'),f.select('ds'),f.select('gpt')]);
 assert.equal(f.state.modelProvider,'openai');assert.equal(f.state.model,'gpt');assert.equal(f.isArchived(),false);
});

test('background activity prevents archival reload and leaves the chat untouched',async()=>{
 const f=await fixture();const rpc=(m,p)=>m==='thread/backgroundTerminals/list'?Promise.resolve({data:[{processId:'running'}]}):f.rpc(m,p);
 await assert.rejects(f.picker.run('local','thread/settings/update',{threadId:f.state.id,model:'gpt'},async()=>({}),rpc),/后台终端/);
 assert(!f.calls.some(([m])=>m==='thread/archive'));assert.equal(f.state.modelProvider,'external');
});

const rawReasoning={type:'reasoning',id:'rs_ds',summary:[],content:[{type:'reasoning_text',text:'中间结论 α\nkeep this constraint'}],encrypted_content:null};
function addReasoning(f) {
 const source=JSON.stringify({type:'turn_context',payload:{model:'ds'}})+'\n'+JSON.stringify({type:'response_item',payload:rawReasoning})+'\n';
 f.files.set(f.state.path,Buffer.from(source).toString('base64'));return source;
}
test('legacy GPT chat repairs DS reasoning before a turn with no explicit model, preserving text and backup',async()=>{
 const f=await fixture('openai'),source=addReasoning(f);
 await f.picker.run('local','turn/start',{threadId:f.state.id,input:[]},async()=>({turn:{id:'new'}}),f.rpc);
 const converted=Buffer.from(f.files.get(f.state.path),'base64').toString();
 const record=JSON.parse(converted.trim().split('\n')[1]);
 assert.equal(record.payload.type,'message');assert.equal(record.payload.content[0].text,rawReasoning.content[0].text);
 assert.deepEqual(record.codex_model_picker_reasoning.payload,rawReasoning);
 assert([...f.files].some(([p,v])=>p.endsWith('.bak')&&Buffer.from(v,'base64').toString()===source));
 assert(f.calls.some(([m])=>m==='thread/archive'));
 f.calls.length=0;await f.select('gpt');assert(!f.calls.some(([m])=>m==='thread/archive'||m==='fs/writeFile'));
 await f.select('ds');
 const restored=JSON.parse(Buffer.from(f.files.get(f.state.path),'base64').toString().trim().split('\n')[1]);
 assert.deepEqual(restored.payload,rawReasoning);
});
test('history conversion and original bytes roll back if target settings fail',async()=>{
 const f=await fixture(),source=addReasoning(f);
 await assert.rejects(f.select('gpt',async()=>{throw Error('settings rejected')}),/settings rejected/);
 assert.equal(Buffer.from(f.files.get(f.state.path),'base64').toString(),source);
 assert.equal(f.state.modelProvider,'external');
});
test('a failed partial history write restores original bytes before resuming',async()=>{
 const f=await fixture(),source=addReasoning(f);let failed=false;
 const rpc=async(m,p)=>{
  if(m==='fs/writeFile'&&!failed){failed=true;f.files.set(p.path,'broken');throw Error('partial write')}
  return f.rpc(m,p);
 };
 await assert.rejects(f.picker.run('local','thread/settings/update',{threadId:f.state.id,model:'gpt'},async()=>({}),rpc),/partial write/);
 assert.equal(Buffer.from(f.files.get(f.state.path),'base64').toString(),source);
 assert.equal(f.state.modelProvider,'external');
});
