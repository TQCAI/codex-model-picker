/* codex-model-picker 0.2.0: per-thread routing and reversible provider switching */
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
  async function changeProvider(params, target, rpc, commit) {
    const id = params.threadId;
    if (!rpc) throw Error('模型切换组件未加载，请安装新版菜单补丁。');
    const {thread} = await rpc('thread/read',{threadId:id,includeTurns:false});
    remember({thread});
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
    if (oldProvider === target) return commit(params);
    if (oldProvider !== 'openai' && !providerById(oldProvider)) throw Error('原 provider 未登记，无法安全切换或回滚。');
    const restoreSettings = {cwd:saved.cwd, approvalPolicy:saved.approvalPolicy,
      approvalsReviewer:saved.approvalsReviewer, sandboxPolicy:saved.sandbox,
      disabledPluginIds:saved.disabledPluginIds};
    const resume = {threadId:id,excludeTurns:true,cwd:saved.cwd,
      runtimeWorkspaceRoots:saved.runtimeWorkspaceRoots,approvalPolicy:saved.approvalPolicy,
      approvalsReviewer:saved.approvalsReviewer,sandbox:'read-only'};
    // Archiving/unarchiving unloads the idle runtime. A plain resume would silently
    // keep its previous provider. The same ID and persisted history are retained.
    let archived=false;
    switching.add(id);
    try {
      await rpc('thread/archive',{threadId:id}); archived=true;
      await rpc('thread/unarchive',{threadId:id}); archived=false;
      const desired=providerConfig({...resume,model:modelOf(params)},providerById(target));
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
          await rpc('thread/archive',{threadId:id}); archived=true;
          await rpc('thread/unarchive',{threadId:id}); archived=false;
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
        if (['turn/start','thread/settings/update'].includes(method) && modelOf(params)!=null) {
          let current=threads.get(key);
          if (current==null && rpc) { const read=await rpc('thread/read',{threadId:key,includeTurns:false});remember(read);current=threads.get(key); }
          const target=providerForModel(modelOf(params))?.id ?? 'openai';
          if (current!==target && (providerById(current) || providerById(target))) return changeProvider(params,target,rpc,next);
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
if (typeof module!=='undefined') module.exports={createModelPicker};
