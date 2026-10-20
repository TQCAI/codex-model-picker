/* codex-model-picker 0.2.1: retain reasoning across provider switches */
function compatibleRollout(source, target, providerForModel, fallback) {
  let provider=fallback, changed=false;
  const field='codex_model_picker_reasoning';
  const text=source.split('\n').map(line=>{
    if(!line.trim())return line;
    const record=JSON.parse(line), p=record.payload;
    if(record.type==='turn_context' && p?.model) provider=providerForModel(p.model)?.id ?? 'openai';
    if(record.type!=='response_item')return line;
    const saved=record[field];
    if(saved && (saved.version!==1 || saved.payload?.type!=='reasoning'))throw Error('无法识别历史推理备份格式。');
    const original=saved?.payload ?? p, origin=saved?.provider ?? provider;
    if(original?.type!=='reasoning')return line;
    const raw=(original.content??[]).filter(x=>x.type==='reasoning_text').map(x=>x.text);
    let desired=original;
    if((target==='openai' && raw.length) || (origin!==target && (raw.length || original.encrypted_content))) {
      const parts=raw.length?raw:(original.summary??[]).filter(x=>x.type==='summary_text').map(x=>x.text);
      // No per-item annotations or duplicated summaries in the model context.
      desired=parts.length ? {type:'message',role:'assistant',content:parts.map(text=>({type:'output_text',text})),phase:'commentary'} :
        {type:'reasoning',summary:[],content:[],encrypted_content:null};
    }
    if(JSON.stringify(desired)===JSON.stringify(p))return line;
    if(!saved)record[field]={version:1,provider:origin,payload:original};
    record.payload=desired;changed=true;return JSON.stringify(record);
  }).join('\n');
  return {text,changed};
}
function createModelPicker(catalog) {
  const models = new Map(), threads = new Map(), pending = new Map(), switching = new Set();
  for (const provider of catalog.providers) for (const model of provider.models) {
    if (models.has(model.id)) throw Error('Model IDs must be unique: ' + model.id);
    models.set(model.id, {provider, model});
  }
  const modelOf = p => p?.collaborationMode?.settings?.model ?? p?.model;
  const providerForModel = model => models.get(model)?.provider;
  const providerById = id => catalog.providers.find(p => p.id === id);
  function providerConfig(params, provider) {
    if (!provider) return {...params, modelProvider:'openai'};
    return {...params, modelProvider:provider.id, config:{...params.config, ...provider.runtimeConfig,
      model_providers:{...params.config?.model_providers, [provider.id]:provider.config}}};
  }
  function remember(result) {
    if (result?.thread?.id && result.thread.modelProvider) threads.set(result.thread.id, result.thread.modelProvider);
    if (Array.isArray(result?.data)) for (const t of result.data) if (t.id && t.modelProvider) threads.set(t.id,t.modelProvider);
  }
  const decode=data=>new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(data),c=>c.charCodeAt(0)));
  function encode(text) {
    const bytes=new TextEncoder().encode(text);let binary='';
    for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    return btoa(binary);
  }
  async function historyPlan(thread,target,rpc) {
    if(!thread.path || thread.ephemeral)return null;
    if(!thread.path.startsWith('/') || thread.path.split('/').includes('..') || !thread.path.endsWith('.jsonl') || !thread.path.split('/').pop().includes(thread.id))
      throw Error('无法安全确认聊天历史文件，未修改。');
    const meta=await rpc('fs/getMetadata',{path:thread.path});
    if(!meta.isFile || meta.isSymlink)throw Error('聊天历史必须是普通文件，未修改。');
    const {dataBase64}=await rpc('fs/readFile',{path:thread.path});
    if(dataBase64.length>64*1024*1024)throw Error('聊天历史过大，请在新聊天中切换模型。');
    const plan=compatibleRollout(decode(dataBase64),target,providerForModel,thread.modelProvider);
    return {...plan,path:thread.path,before:dataBase64,after:plan.changed?encode(plan.text):dataBase64};
  }
  async function changeProvider(params, target, rpc, commit) {
    const id = params.threadId;
    if (!rpc) throw Error('模型切换组件未加载，请安装新版菜单补丁。');
    const {thread} = await rpc('thread/read',{threadId:id,includeTurns:false});
    remember({thread});
    // Existing in-flight same-provider updates/steering keep the native path.
    // Never inspect a rollout while an active turn may be appending to it.
    if(thread.modelProvider===target && thread.status?.type==='active')return commit(params);
    const plan=await historyPlan(thread,target,rpc);
    if(thread.modelProvider===target && !plan?.changed)return commit(params);
    if (thread.status?.type !== 'idle' || thread.ephemeral || !thread.path) {
      throw Error('请等待当前任务结束后再切换模型；临时聊天请新建聊天。');
    }
    const terminals=await rpc('thread/backgroundTerminals/list',{threadId:id,limit:1});
    const descendants=await rpc('thread/list',{ancestorThreadId:id,archived:false,limit:1,sourceKinds:['subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther']});
    const {goal}=await rpc('thread/goal/get',{threadId:id});
    if (terminals.data.length || descendants.data.length || goal?.status==='active' || goal?.status==='paused') {
      throw Error('当前聊天有后台终端、子聊天或未结束目标；请先结束它们，或新建聊天切换模型。');
    }
    const saved = await rpc('thread/resume',{threadId:id,excludeTurns:true});
    const oldProvider = saved.modelProvider ?? thread.modelProvider;
    if (oldProvider !== 'openai' && !providerById(oldProvider)) throw Error('原 provider 未登记，无法安全切换或回滚。');
    const restoreSettings = {cwd:saved.cwd, approvalPolicy:saved.approvalPolicy,
      approvalsReviewer:saved.approvalsReviewer, sandboxPolicy:saved.sandbox,
      disabledPluginIds:saved.disabledPluginIds};
    const resume = {threadId:id,excludeTurns:true,cwd:saved.cwd,
      runtimeWorkspaceRoots:saved.runtimeWorkspaceRoots,approvalPolicy:saved.approvalPolicy,
      approvalsReviewer:saved.approvalsReviewer,sandbox:'read-only'};
    // Archiving/unarchiving unloads the idle runtime. A plain resume would silently
    // keep its previous provider. The same ID and persisted history are retained.
    let archived=false, historyUndo=null;
    switching.add(id);
    try {
      await rpc('thread/archive',{threadId:id}); archived=true;
      await rpc('thread/unarchive',{threadId:id}); archived=false;
      const unloaded=await rpc('thread/read',{threadId:id,includeTurns:false});
      if(unloaded.thread.status?.type!=='notLoaded')throw Error('聊天仍在运行，未转换历史。');
      const fresh=await historyPlan(unloaded.thread,target,rpc);
      if(fresh?.changed) {
        const backup=fresh.path+'.model-picker-'+Date.now()+'-'+Math.random().toString(16).slice(2)+'.bak';
        await rpc('fs/copy',{sourcePath:fresh.path,destinationPath:backup});
        const copied=await rpc('fs/readFile',{path:backup});
        const current=await rpc('fs/readFile',{path:fresh.path});
        if(copied.dataBase64!==fresh.before || current.dataBase64!==fresh.before)throw Error('历史文件已变化，未转换。');
        historyUndo=fresh;
        await rpc('fs/writeFile',{path:fresh.path,dataBase64:fresh.after});
        const verified=await rpc('fs/readFile',{path:fresh.path});
        if(verified.dataBase64!==fresh.after)throw Error('历史兼容转换校验失败。');
      }
      const desired=providerConfig({...resume,model:modelOf(params)??saved.model},providerById(target));
      const resumed=await rpc('thread/resume',desired);
      if (resumed.modelProvider !== target) throw Error('后端未切换到目标模型服务。');
      await rpc('thread/settings/update',restoreSettingsWithId(id,restoreSettings));
      const result=await commit({...restoreSettings,...params});
      threads.set(id,target);
      return result;
    } catch (error) {
      try {
        if (archived) { await rpc('thread/unarchive',{threadId:id}); archived=false; }
        // A successful target resume may already have loaded a new runtime.
        // Unload it before restoring the original provider and permissions.
        const current=await rpc('thread/read',{threadId:id,includeTurns:false});
        if (current.thread.status?.type !== 'notLoaded') {
          if(current.thread.status?.type!=='idle')throw Error('聊天已有新任务，未覆盖历史；原文备份已保留。');
          await rpc('thread/archive',{threadId:id}); archived=true;
          await rpc('thread/unarchive',{threadId:id}); archived=false;
        }
        if(historyUndo) {
          await rpc('fs/writeFile',{path:historyUndo.path,dataBase64:historyUndo.before});
          const verified=await rpc('fs/readFile',{path:historyUndo.path});
          if(verified.dataBase64!==historyUndo.before)throw Error('原始历史恢复校验失败，备份已保留。');
        }
        const restored=await rpc('thread/resume',providerConfig({...resume,model:saved.model},providerById(oldProvider)));
        if (restored.modelProvider !== oldProvider) throw Error('恢复的 provider 不匹配');
        await rpc('thread/settings/update',restoreSettingsWithId(id,restoreSettings));
        threads.set(id,oldProvider);
      } catch (rollbackError) {
        // Best effort to leave the original chat visible even if resume failed.
        if (archived) await rpc('thread/unarchive',{threadId:id}).catch(()=>{});
        throw Error('模型切换失败，恢复原会话也失败；请重新打开聊天。'+String(error)+' / '+String(rollbackError));
      }
      throw error;
    } finally { switching.delete(id); }
  }
  function restoreSettingsWithId(id,settings) {
    return Object.fromEntries(Object.entries({threadId:id,...settings}).filter(([,value])=>value!==undefined));
  }
  const api = {
    has:id=>models.has(id),
    providerFor:id=>threads.get(id),
    ignoreNotification(host,method,params) {
      return host==='local' && switching.has(params?.threadId ?? params?.thread?.id) &&
        ['thread/archived','thread/unarchived','thread/closed'].includes(method);
    },
    async run(host,method,params,next,rpc) {
      if (host!=='local') return next(params);
      const key=params?.threadId;
      // Install the tail synchronously: simultaneous selections cannot race each other.
      const previous=key ? pending.get(key) : null;
      const operation=(async()=>{
        if (previous) await previous.catch(()=>{});
        if (method==='thread/list' && Array.isArray(params?.modelProviders) && params.modelProviders.length) {
          params={...params,modelProviders:[...new Set([...params.modelProviders,...catalog.providers.map(p=>p.id)])]};
        }
        if (['thread/start','thread/resume','thread/fork'].includes(method)) {
          const provider=providerForModel(modelOf(params)) ?? providerById(threads.get(key));
          if (provider) params=providerConfig(params,provider);
        }
        if (['turn/start','thread/settings/update'].includes(method) && rpc) {
          let current=threads.get(key);
          if (current==null && rpc) { const read=await rpc('thread/read',{threadId:key,includeTurns:false});remember(read);current=threads.get(key); }
          const target=modelOf(params)==null ? current : providerForModel(modelOf(params))?.id ?? 'openai';
          if (current!==target && (providerById(current) || providerById(target))) return changeProvider(params,target,rpc,next);
          // Also repair chats already switched by 0.2.0, including turns whose
          // model is omitted. No archive/write when the history is compatible.
          if(target==='openai')return changeProvider(params,target,rpc,next);
        }
        let result=await next(params);
        remember(result);
        if (method==='model/list') {
          const ids=new Set(result.data.map(m=>m.model)),added=[];
          for (const [id,{provider,model}] of models) {
            if (ids.has(id)) throw Error('外部模型 ID 与原生模型冲突：'+id);
            added.push({id,model:id,displayName:provider.name+' · '+(model.name||id),description:'外部服务 · '+provider.name,
              hidden:false,isDefault:false,upgrade:null,inputModalities:['text'],
              supportedReasoningEfforts:(model.efforts||['low']).map(effort=>({reasoningEffort:effort,description:effort})),
              defaultReasoningEffort:model.defaultEffort||'low',supportsPersonality:false,_modelPickerExternal:true});
          }
          result={...result,data:[...result.data,...added]};
        }
        return result;
      })();
      if (key) pending.set(key,operation);
      try {return await operation;} finally {if(key&&pending.get(key)===operation)pending.delete(key);}
    }
  };
  return api;
}
if (typeof module!=='undefined') module.exports={createModelPicker,compatibleRollout};
