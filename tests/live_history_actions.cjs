// Real bundled app-server + local Responses mocks, no real accounts or API usage.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const vm=require('node:vm');
const {createModelPicker}=require('../src/router.js');
async function main(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'codex-provider-switch-'));
 const requests=[],notifications=[],pending=new Map(),completed=new Map(),waiters=new Map();
 const originalConfig=path.join(os.homedir(),'.codex/config.toml');
 const before=fs.existsSync(originalConfig)?fs.readFileSync(originalConfig):null;
 const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(404);res.end();return;}
  let body='';for await(const data of req)body+=data;const input=JSON.parse(body);
  requests.push({path:req.url,model:input.model,history:JSON.stringify(input.input)});
  if(req.url.startsWith('/gpt/') && input.input.some(i=>i.type==='reasoning'&&i.content?.length)){
   res.writeHead(400,{'Content-Type':'application/json'});
   res.end(JSON.stringify({error:{message:"Invalid reasoning.content: array too long",type:'invalid_request_error',code:'array_above_max_length'}}));return;
  }
  const id='msg_'+requests.length,text='REPLY_'+(JSON.stringify(input.input.at(-1)).match(/INPUT_([A-D])_TOKEN/)?.[1]||'PROBE')+'_TOKEN';
  const item={id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
  const reasoning={id:'rs_'+requests.length,type:'reasoning',summary:[],content:[{type:'reasoning_text',text:'THINK_'+(JSON.stringify(input.input.at(-1)).match(/INPUT_([A-D])_TOKEN/)?.[1]||'PROBE')+'_TOKEN'}],encrypted_content:null};
  const ds=req.url.startsWith('/ds/');
  const outputIndex=ds?1:0;
  const response={id:'resp_'+requests.length,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:input.model,output:ds?[reasoning,item]:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
   {type:'response.output_item.added',output_index:outputIndex,item:{...item,status:'in_progress',content:[]}},
   {type:'response.content_part.added',output_index:outputIndex,item_id:id,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
   {type:'response.output_text.delta',output_index:outputIndex,item_id:id,content_index:0,delta:text},
   {type:'response.output_text.done',output_index:outputIndex,item_id:id,content_index:0,text},
   {type:'response.output_item.done',output_index:outputIndex,item}, {type:'response.completed',response}];
  if(ds)events.splice(1,0,{type:'response.output_item.done',output_index:0,item:reasoning});
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 // A disposable, fake API credential for the local native-provider mock only.
 fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'local-test-only'}),{mode:0o600});
 const binary=process.env.CODEX_TEST_BINARY||'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
 const child=spawn(binary,['-c','openai_base_url='+JSON.stringify(`http://127.0.0.1:${port}/gpt/v1`),'app-server','--listen','stdio://'],{env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','ignore']});
 let sequence=0;
 const picker=createModelPicker({providers:[{id:'picker_ds',name:'DeepSeek',config:{name:'DeepSeek',base_url:`http://127.0.0.1:${port}/ds/v1`,wire_api:'responses',requires_openai_auth:false,supports_websockets:false},runtimeConfig:{web_search:'disabled'},models:[{id:'deepseek-v4-pro'}]}]});
 const lines=readline.createInterface({input:child.stdout});
 lines.on('line',line=>{
  const e=JSON.parse(line);
  if(e.id!=null){const p=pending.get(e.id);if(p){pending.delete(e.id);e.error?p.reject(Error(e.error.message)):p.resolve(e.result);}return;}
  notifications.push({method:e.method,suppressed:picker.ignoreNotification('local',e.method,e.params)});
  if(e.method==='turn/completed'){
   const id=e.params.turn.id;completed.set(id,e.params.turn);waiters.get(id)?.(e.params.turn);waiters.delete(id);
  }
 });
 function rpc(method,params){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n')});}
 let compiledNativeWrapper=false,send;
 const asset=path.join(__dirname,'../candidate/app-initial-90eb42395b7d.js');
 if(fs.existsSync(asset)){
  const source=fs.readFileSync(asset,'utf8'),begin=source.indexOf('enqueueRequest(e,t,n,...r){'),end=source.indexOf('__pickerEnqueue(e,t,n,r=t=>{',begin);
  assert(begin>=0&&end>begin);
  const C=vm.runInNewContext('(class {hostId="local";'+source.slice(begin,end)+'__pickerEnqueue(m,p){return rpc(m,p)}})',{__codexModelPicker:picker,rpc});
  const client=new C();send=(m,p)=>client.enqueueRequest(m,p);compiledNativeWrapper=true;
 }else send=(m,p)=>picker.run('local',m,p,q=>rpc(m,q),rpc);
 async function turn(id,label){
  const {turn}=await send('turn/start',{threadId:id,input:[{type:'text',text:label,text_elements:[]}]});
  const done=completed.get(turn.id)||await new Promise(resolve=>waiters.set(turn.id,resolve));
  assert.equal(done.status,'completed',JSON.stringify(done.error));return turn.id;
 }
 const deadline=setTimeout(()=>{child.kill('SIGTERM');process.exitCode=1;console.error('Provider-switch integration timed out')},90000);
 try{
  await rpc('initialize',{clientInfo:{name:'history_actions_regression',version:'0.3.0'},capabilities:{experimentalApi:true}});
  child.stdin.write('{"method":"initialized"}\n');
  async function startFour(inject=false){
   const initial=await send('thread/start',{model:'deepseek-v4-pro',cwd:home,config:{web_search:'disabled'},sandbox:'read-only',historyMode:'paginated'}),id=initial.thread.id,ids=[];
   for(const name of ['A','B','C','D']){
    ids.push(await turn(id,'INPUT_'+name+'_TOKEN'));
    if(inject&&name==='C')await rpc('thread/inject_items',{threadId:id,items:[
     {type:'function_call',name:'lookup',arguments:'{"query":"TOOL_C_TOKEN"}',call_id:'call_c'},
     {type:'function_call_output',call_id:'call_c',output:'OUTPUT_C_TOKEN'}]});
   }
   return {id,ids,initial};
  }
  const visible=async id=>(await rpc('thread/turns/list',{threadId:id,limit:100,sortDirection:'asc'})).data.map(t=>t.id);
  function checkContext(keep,remove){
   const text=requests.at(-1).history;
   for(const name of keep)assert(text.includes('INPUT_'+name+'_TOKEN'),'Missing retained input '+name);
   for(const name of remove)for(const prefix of ['INPUT_','REPLY_','THINK_','TOOL_','OUTPUT_'])assert(!text.includes(prefix+name+'_TOKEN'),'Deleted context survived: '+prefix+name);
  }
  const a=await startFour(true),unrelated=await startFour();
  const removed=await send('modelPicker/history/edit',{threadId:a.id,turnId:a.ids[2],action:'delete'});
  assert.deepEqual(removed.removedTurnIds,[a.ids[2]]);assert.deepEqual(await visible(a.id),[a.ids[0],a.ids[1],a.ids[3]]);
  await turn(a.id,'AFTER_DELETE');checkContext(['A','B','D'],['C']);
  const stored=await rpc('thread/read',{threadId:a.id,includeTurns:false});
  assert.equal(stored.thread.id,a.id);assert(removed.backups.every(p=>fs.existsSync(p)));
  assert.deepEqual(await visible(unrelated.id),unrelated.ids);
  await rpc('thread/archive',{threadId:a.id});await rpc('thread/unarchive',{threadId:a.id});
  await send('thread/resume',{threadId:a.id,model:'deepseek-v4-pro',excludeTurns:true});
  await turn(a.id,'REOPEN_AFTER_DELETE');checkContext(['A','B','D'],['C']);
  const b=await startFour();
  const undone=await send('modelPicker/history/edit',{threadId:b.id,turnId:b.ids[2],action:'rewind'});
  assert.deepEqual(undone.removedTurnIds,b.ids.slice(2));assert.deepEqual(await visible(b.id),b.ids.slice(0,2));
  await turn(b.id,'AFTER_REWIND');checkContext(['A','B'],['C','D']);
  await send('thread/settings/update',{threadId:b.id,model:'gpt-6.1-sol'});
  await turn(b.id,'GPT_AFTER_REWIND');checkContext(['A','B'],['C','D']);
  assert(requests.at(-1).path.startsWith('/gpt/'));assert(!JSON.parse(requests.at(-1).history).some(i=>i.type==='reasoning'&&i.content?.length));
  const c=await startFour();
  await send('modelPicker/history/edit',{threadId:c.id,turnId:c.ids[3],action:'rewind'});
  await send('modelPicker/history/edit',{threadId:c.id,turnId:c.ids[1],action:'delete'});
  assert.deepEqual(await visible(c.id),[c.ids[0],c.ids[2]]);
  await turn(c.id,'AFTER_REPEATED_EDIT');checkContext(['A','C'],['B','D']);
  const failure=await startFour();let fail=true;
  const failingRpc=async(m,p)=>{
   if(m==='fs/writeFile'&&fail){fail=false;await rpc(m,{...p,dataBase64:Buffer.from('broken').toString('base64')});throw Error('Injected partial write')}
   return rpc(m,p);
  };
  await assert.rejects(picker.run('local','modelPicker/history/edit',{threadId:failure.id,turnId:failure.ids[2],action:'delete'},async()=>({}),failingRpc),/Injected partial write/);
  assert.deepEqual(await visible(failure.id),failure.ids);
  await turn(failure.id,'AFTER_FAILED_DELETE');checkContext(['A','B','C','D'],[]);
  // A new backend process must also exclude the removed turn; an in-memory
  // filter or a hidden DOM row cannot satisfy this check.
  await new Promise(resolve=>{child.once('close',resolve);child.kill('SIGTERM')});
  const restarted=spawn(binary,['-c','openai_base_url='+JSON.stringify(`http://127.0.0.1:${port}/gpt/v1`),'app-server','--listen','stdio://'],{env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','ignore']});
  const readers=readline.createInterface({input:restarted.stdout}),outstanding=new Map(),doneTurns=new Map(),waiting=new Map();let counter=0;
  readers.on('line',line=>{
   const e=JSON.parse(line);
   if(e.id!=null){const p=outstanding.get(e.id);if(p){outstanding.delete(e.id);e.error?p.reject(Error(e.error.message)):p.resolve(e.result)}}
   if(e.method==='turn/completed'){doneTurns.set(e.params.turn.id,e.params.turn);waiting.get(e.params.turn.id)?.(e.params.turn)}
  });
  const call=(method,params)=>new Promise((resolve,reject)=>{const id=++counter;outstanding.set(id,{resolve,reject});restarted.stdin.write(JSON.stringify({id,method,params})+'\n')});
  try{
   await call('initialize',{clientInfo:{name:'history_restart_test',version:'0.3.0'},capabilities:{experimentalApi:true}});restarted.stdin.write('{"method":"initialized"}\n');
   const freshPicker=createModelPicker({providers:[{id:'picker_ds',name:'DeepSeek',config:{name:'DeepSeek',base_url:`http://127.0.0.1:${port}/ds/v1`,wire_api:'responses',requires_openai_auth:false,supports_websockets:false},runtimeConfig:{web_search:'disabled'},models:[{id:'deepseek-v4-pro'}]}]});
   const invoke=(m,p)=>freshPicker.run('local',m,p,q=>call(m,q),call);
   await invoke('thread/resume',{threadId:a.id,model:'deepseek-v4-pro',excludeTurns:true});
   const reply=await invoke('turn/start',{threadId:a.id,input:[{type:'text',text:'PROBE_AFTER_RESTART',text_elements:[]}]});
   const completed=doneTurns.get(reply.turn.id)||await new Promise(resolve=>waiting.set(reply.turn.id,resolve));assert.equal(completed.status,'completed');
   checkContext(['A','B','D'],['C']);
  }finally{restarted.kill('SIGTERM');if(restarted.exitCode===null)await new Promise(resolve=>restarted.once('close',resolve));readers.close()}
  assert.deepEqual(fs.existsSync(originalConfig)?fs.readFileSync(originalConfig):null,before);
  console.log(JSON.stringify({passed:true,compiledNativeWrapper,deleteContext:'ABD',rewindContext:'AB',removedReplyReasoningAndTools:true,repeatedEdits:true,modelSwitchAfterRewind:true,reopenPersists:true,backendRestartPersists:true,partialWriteRollback:true,otherThreadUnchanged:true,globalConfigUnchanged:true},null,2));
 }finally{
  clearTimeout(deadline);child.kill('SIGTERM');if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve));
  lines.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(home,{recursive:true,force:true});
 }
}
main().catch(e=>{console.error(e);process.exitCode=1});
