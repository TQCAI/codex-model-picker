/* codex-model-picker 0.1.0: per-thread routing, no global provider writes */
function createModelPicker(catalog) {
  const models = new Map();
  const threads = new Map();
  const pending = new Map();
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (models.has(model.id)) throw Error('Model IDs must be unique: ' + model.id);
      models.set(model.id, {provider, model});
    }
  }
  function entry(params) {
    const direct = params?.collaborationMode?.settings?.model ?? params?.model;
    return models.get(direct);
  }
  function providerConfig(params, provider) {
    return {...params, modelProvider: provider.id, config: {
      ...params.config, ...provider.runtimeConfig,
      model_providers: {...params.config?.model_providers, [provider.id]: provider.config}
    }};
  }
  function remember(result) {
    if (result?.thread?.id && result.thread.modelProvider) {
      threads.set(result.thread.id, result.thread.modelProvider);
    }
    if (result?.data) for (const thread of result.data) {
      if (thread.id && thread.modelProvider) threads.set(thread.id, thread.modelProvider);
    }
  }
  return {
    has: id => models.has(id),
    async run(host, method, params, next) {
      if (host !== 'local') return next(params);
      const selected = entry(params);
      if (method === 'thread/list' && Array.isArray(params?.modelProviders) && params.modelProviders.length) {
        params = {...params, modelProviders:[...new Set([...params.modelProviders, ...catalog.providers.map(p => p.id)])]};
      }
      if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') {
        const knownProvider = threads.get(params.threadId);
        if (knownProvider && selected && knownProvider !== selected.provider.id) throw Error('切换模型服务需要新建聊天。');
        const provider = selected?.provider ?? catalog.providers.find(p => p.id === knownProvider);
        if (provider) params = providerConfig(params, provider);
      }
      if (method === 'turn/start' || method === 'thread/settings/update') {
        const current = threads.get(params.threadId);
        if ((selected && current !== selected.provider.id) ||
            (!selected && (params.collaborationMode?.settings?.model ?? params.model) != null &&
             catalog.providers.some(p => p.id === current))) {
          throw Error('切换到其他模型服务需要新建聊天；当前聊天的 provider 保持不变。');
        }
      }
      // Serialize settings/turn mutations for a thread without blocking unrelated threads.
      const key = params?.threadId;
      const previous = key && pending.get(key);
      if (previous) await previous.catch(() => {});
      const request = Promise.resolve().then(() => next(params));
      if (key) pending.set(key, request);
      try {
        let result = await request;
        remember(result);
        if (method === 'model/list') {
          const ids = new Set(result.data.map(m => m.model));
          const added = [];
          for (const [id, {provider, model}] of models) {
            if (ids.has(id)) throw Error('外部模型 ID 与原生模型冲突：' + id);
            added.push({id, model:id, displayName:provider.name + ' · ' + (model.name || id),
              description:'外部服务 · 新建聊天时选择 · ' + provider.name,
              hidden:false, isDefault:false, upgrade:null, inputModalities:['text'],
              supportedReasoningEfforts:(model.efforts || ['low']).map(effort=>({reasoningEffort:effort,description:effort})),
              defaultReasoningEffort:model.defaultEffort || 'low', supportsPersonality:false,
              _modelPickerExternal:true});
          }
          result = {...result, data:[...result.data, ...added]};
        }
        return result;
      } finally {
        if (key && pending.get(key) === request) pending.delete(key);
      }
    }
  };
}
if (typeof module !== 'undefined') module.exports = {createModelPicker};
