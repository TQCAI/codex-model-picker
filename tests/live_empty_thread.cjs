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
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'codex-empty-thread-'));
 const writable=fs.mkdtempSync(path.join(os.tmpdir(),'codex-empty-policy-'));
 const methods=new Map();
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
  const id='msg_'+requests.length,text=req.url.startsWith('/ds/')?'DS_OK':'GPT_OK';
  const item={id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
  const reasoning={id:'rs_'+requests.length,type:'reasoning',summary:[],content:[{type:'reasoning_text',text:'DS_REASONING_CONTEXT'}],encrypted_content:null};
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
  if(e.id!=null){const p=pending.get(e.id);if(p){pending.delete(e.id);e.error?p.reject(Error(methods.get(e.id)+': '+e.error.message)):p.resolve(e.result);}return;}
  notifications.push({method:e.method,suppressed:picker.ignoreNotification('local',e.method,e.params)});
  if(e.method==='turn/completed'){
   const id=e.params.turn.id;completed.set(id,e.params.turn);waiters.get(id)?.(e.params.turn);waiters.delete(id);
  }
 });
 function rpc(method,params){return new Promise((resolve,reject)=>{const id=++sequence;methods.set(id,method);pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n')});}
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
 const deadline=setTimeout(()=>{child.kill('SIGTERM');process.exitCode=1;console.error('Empty-thread integration timed out')},120000);
 try{
  await rpc('initialize',{clientInfo:{name:'empty_thread_regression',version:'0.3.1'},capabilities:{experimentalApi:true}});
  child.stdin.write('{"method":"initialized"}\n');
  const checks=[];
  async function fresh(model='gpt-6.1-sol'){
   const result=await send('thread/start',{model,cwd:home,config:{web_search:'disabled'},sandbox:'read-only',historyMode:'paginated'});
   assert(!fs.existsSync(result.thread.path),'Expected a lazily created rollout');return result.thread.id;
  }
  const first=await fresh(),firstTurn=await turn(first,'FIRST_GPT');checks.push('first GPT message');
  const settings=await fresh();await send('thread/settings/update',{threadId:settings,model:'gpt-6.1-sol'});const settingsTurn=await turn(settings,'GPT_AFTER_SETTINGS');checks.push('settings before first input');
  const cross=await fresh();await send('thread/settings/update',{threadId:cross,model:'deepseek-v4-pro'});await turn(cross,'DS_FIRST');checks.push('switch before first input');
  const reverse=await fresh('deepseek-v4-pro');
  const policy={type:'workspaceWrite',writableRoots:[fs.realpathSync(writable)],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true};
  await send('thread/settings/update',{threadId:reverse,sandboxPolicy:policy,approvalPolicy:'on-request',disabledPluginIds:['test-disabled'],effort:'high'});
  await send('thread/settings/update',{threadId:reverse,model:'gpt-6.1-sol'});
  const actual=await rpc('thread/resume',{threadId:reverse,excludeTurns:true});
  assert.equal(actual.modelProvider,'openai');assert.equal(actual.sandbox.type,policy.type);
  assert.deepEqual(actual.sandbox.writableRoots,policy.writableRoots);assert.equal(actual.sandbox.networkAccess,false);assert.equal(actual.sandbox.excludeSlashTmp,true);assert.equal(actual.approvalPolicy,'on-request');
  assert.deepEqual(actual.disabledPluginIds,['test-disabled']);assert.equal(actual.reasoningEffort,'high');
  await turn(reverse,'GPT_FIRST_AFTER_DS_SELECTION');checks.push('reverse empty switch preserves edited permissions');
  await send('modelPicker/history/edit',{threadId:first,turnId:firstTurn,action:'delete'});
  assert.deepEqual((await rpc('thread/turns/list',{threadId:first})).data,[]);
  await turn(first,'AFTER_DELETE_ONLY_TURN');assert(!requests.at(-1).history.includes('FIRST_GPT'));checks.push('send after deleting only turn');
  await send('modelPicker/history/edit',{threadId:settings,turnId:settingsTurn,action:'rewind'});
  assert.deepEqual((await rpc('thread/turns/list',{threadId:settings})).data,[]);
  await turn(settings,'AFTER_REWIND_ALL');assert(!requests.at(-1).history.includes('GPT_AFTER_SETTINGS'));checks.push('send after rewinding all turns');
  assert.deepEqual(fs.existsSync(originalConfig)?fs.readFileSync(originalConfig):null,before);
  assert.deepEqual(requests.map(r=>r.path),['/gpt/v1/responses','/gpt/v1/responses','/ds/v1/responses','/gpt/v1/responses','/gpt/v1/responses','/gpt/v1/responses']);
  console.log(JSON.stringify({passed:true,checks,compiledNativeWrapper,paths:requests.map(r=>r.path)},null,2));
 }finally{
  clearTimeout(deadline);child.kill('SIGTERM');await new Promise(resolve=>child.once('close',resolve));
  lines.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(home,{recursive:true,force:true});fs.rmSync(writable,{recursive:true,force:true});
 }
}
main().catch(e=>{console.error(e);process.exitCode=1});
