// Explicit real-account regression. Temporary CODEX_HOME; two short API calls.
// Usage: node tests/real_reasoning_switch.cjs --catalog /absolute/local/catalog.json
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {createModelPicker}=require('../src/router.js');
async function main(){
 const index=process.argv.indexOf('--catalog');assert(index>=0,'Provide --catalog explicitly to use real providers');
 const catalog=JSON.parse(fs.readFileSync(process.argv[index+1],'utf8')),provider=catalog.providers[0],model=provider.models[0].id;
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'codex-real-reasoning-'));
 const auth=process.env.CODEX_TEST_AUTH||path.join(os.homedir(),'.codex/auth.json');
 fs.copyFileSync(auth,path.join(home,'auth.json'));fs.chmodSync(path.join(home,'auth.json'),0o600);
 const config=path.join(os.homedir(),'.codex/config.toml'),before=fs.readFileSync(config);
 const binary=process.env.CODEX_TEST_BINARY||'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
 const child=spawn(binary,['app-server','--listen','stdio://'],{env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','ignore']});
 const pending=new Map(),completed=new Map(),listeners=new Map(),messages=new Map();let sequence=0;
 const lines=readline.createInterface({input:child.stdout});
 lines.on('line',line=>{
  const e=JSON.parse(line);
  if(e.id!=null){const p=pending.get(e.id);if(p){pending.delete(e.id);e.error?p.reject(Error(e.error.message)):p.resolve(e.result)}return}
  if(e.method==='item/completed'&&e.params.item.type==='agentMessage')messages.set(e.params.turnId,(messages.get(e.params.turnId)||'')+e.params.item.text);
  if(e.method==='turn/completed'){const t=e.params.turn;completed.set(t.id,t);listeners.get(t.id)?.(t);listeners.delete(t.id)}
 });
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n')});
 const picker=createModelPicker(catalog),send=(m,p)=>picker.run('local',m,p,q=>rpc(m,q),rpc);
 const timeout=setTimeout(()=>{child.kill('SIGTERM');console.error('Real-provider regression timed out');process.exitCode=1},120000);
 async function turn(id,text){
  const {turn}=await send('turn/start',{threadId:id,input:[{type:'text',text,text_elements:[]}]});
  const done=completed.get(turn.id)||await new Promise(resolve=>listeners.set(turn.id,resolve));
  assert.equal(done.status,'completed',JSON.stringify(done.error));return messages.get(turn.id)||'';
 }
 try{
  await rpc('initialize',{clientInfo:{name:'reasoning_compat_regression',version:'0.2.1'},capabilities:{experimentalApi:true}});
  child.stdin.write('{"method":"initialized"}\n');
  const initial=await send('thread/start',{model,cwd:home,sandbox:'read-only',historyMode:'paginated'}),id=initial.thread.id;
  await rpc('thread/inject_items',{threadId:id,items:[
   {type:'reasoning',summary:[],content:[{type:'reasoning_text',text:'The prior intermediate result is the word kiwi.'}],encrypted_content:null},
   {type:'message',role:'assistant',content:[{type:'output_text',text:'Ready.'}],phase:'final_answer'}]});
  await send('thread/settings/update',{threadId:id,model:'gpt-6.1-sol'});
  const gpt=await turn(id,'What was the word in the prior intermediate result? Reply with that word only. Do not use tools.');
  assert(gpt.toLowerCase().includes('kiwi'),'GPT did not retain the reasoning context');
  await send('thread/settings/update',{threadId:id,model});
  const ds=await turn(id,'Reply exactly OK. Do not use tools.');assert(ds.includes('OK'));
  assert.deepEqual(fs.readFileSync(config),before);
  const final=await rpc('thread/read',{threadId:id,includeTurns:false});assert.equal(final.thread.id,id);
  console.log(JSON.stringify({passed:true,historyMode:initial.thread.historyMode,realGptStatus:'completed',gptRecalledReasoningWord:true,realDeepSeekStatus:'completed',sameThreadId:true,globalConfigUnchanged:true},null,2));
 }finally{
  clearTimeout(timeout);child.kill('SIGTERM');if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve));
  lines.close();fs.rmSync(home,{recursive:true,force:true});
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
