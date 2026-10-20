const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createModelPicker} = require('../src/router.js');
const catalog = {providers:[{id:'external',name:'External',config:{name:'External',base_url:'http://127.0.0.1:1234/v1',wire_api:'responses',requires_openai_auth:false},models:[{id:'external-model'},{id:'external-model-2'}]}]};
test('per-thread provider injection leaves original request and global config untouched',async()=>{
 const picker=createModelPicker(catalog), p={model:'external-model',config:{web_search:'disabled'}};
 let sent;
 await picker.run('local','thread/start',p,async q=>{sent=q;return {thread:{id:'one',modelProvider:q.modelProvider}}});
 assert.equal(sent.modelProvider,'external');assert.equal(sent.config.web_search,'disabled');
 assert.equal(sent.config.model_providers.external.base_url,catalog.providers[0].config.base_url);
 assert.equal(p.modelProvider,undefined);assert.equal(p.config.model_providers,undefined);
 let turn;
 await picker.run('local','turn/start',{threadId:'one',model:'external-model-2'},async q=>{turn=q;return {}});
 assert.equal(turn.model,'external-model-2');

});
test('official and remote requests pass through unchanged',async()=>{
 const picker=createModelPicker(catalog),p={model:'gpt-native'};
 await picker.run('local','thread/start',p,async q=>{assert.equal(q,p);return {thread:{id:'official',modelProvider:'openai'}}});
 await picker.run('remote','thread/start',{model:'external-model'},async q=>{assert.equal(q.modelProvider,undefined);return {}});

});
test('model list retains all native metadata; collisions fail instead of hijacking a native name',async()=>{
 const picker=createModelPicker(catalog),native={model:'native',isDefault:true};
 const result=await picker.run('local','model/list',{},async()=>({data:[native],nextCursor:null}));
 assert.equal(result.data[0],native);assert.equal(result.data[1]._modelPickerExternal,true);
 await assert.rejects(picker.run('local','model/list',{},async()=>({data:[{model:'external-model'}]})),/冲突/);
});
test('resume re-injects provider after reading stored thread metadata',async()=>{
 const picker=createModelPicker(catalog);
 await picker.run('local','thread/read',{threadId:'saved'},async()=>({thread:{id:'saved',modelProvider:'external'}}));
 await picker.run('local','thread/resume',{threadId:'saved'},async q=>{assert.equal(q.modelProvider,'external');return {}});
});

test('native history filters include external provider threads after restart',async()=>{
 const picker=createModelPicker(catalog),params={modelProviders:['openai']};
 await picker.run('local','thread/list',params,async p=>{assert.deepEqual(p.modelProviders,['openai','external']);return {data:[{id:'saved',modelProvider:'external'}]}});
 assert.deepEqual(params.modelProviders,['openai']);
 await picker.run('local','thread/resume',{threadId:'saved'},async p=>{assert.equal(p.modelProvider,'external');return {}});
});
