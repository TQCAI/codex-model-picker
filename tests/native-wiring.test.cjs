const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createModelPicker} = require('../src/router.js');
const asset = 'candidate/app-initial-90eb42395b7d.js';
const source = fs.existsSync(asset) ? fs.readFileSync(asset,'utf8') : null;
const nativeTest = (name, fn) => test(name, {skip:source == null ? 'Build the version-matched native candidate locally to run this check' : false}, fn);
const catalog = {providers:[{id:'picker_ds',name:'DeepSeek',config:{base_url:'http://127.0.0.1:1',wire_api:'responses',requires_openai_auth:false},models:[{id:'deepseek-v4-pro',name:'V4 Pro',efforts:['low','high','max'],defaultEffort:'high'}]}]};
nativeTest('compiled native request wrapper lists DS and routes creation through original scheduler',async()=>{
 const start=source.indexOf('enqueueRequest(e,t,n,...r){');
 assert(start>=0);
 const end=source.indexOf('__pickerEnqueue(e,t,n,r=t=>{',start);
 const method=source.slice(start,end);
 const picker=createModelPicker(catalog), sent=[];
 const C=vm.runInNewContext(`(class {hostId='local'; ${method} __pickerEnqueue(method,p){capture(method,p);return Promise.resolve(method==='model/list'?{data:[{id:'gpt',model:'gpt',isDefault:true}]}:{thread:{id:'test',modelProvider:p.modelProvider}})} })`,{__codexModelPicker:picker,capture:(m,p)=>sent.push([m,p])});
 const client=new C();
 const list=await client.enqueueRequest('model/list',{});
 assert.equal(list.data[1].displayName,'DeepSeek · V4 Pro');
 await client.enqueueRequest('thread/start',{model:'deepseek-v4-pro'});
 assert.equal(sent[1][1].modelProvider,'picker_ds');
 assert.equal(sent[1][1].config.model_providers.picker_ds.base_url,'http://127.0.0.1:1');
});
nativeTest('compiled native model filter admits DS without removing official choices',()=>{
 const begin=source.indexOf('function uvo('),end=source.indexOf('function dvo(',begin);
 assert(begin>0&&end>begin);
 const filter=vm.runInNewContext('('+source.slice(begin,end)+')');
 const defaults={additionalAvailableModels:new Set(),authMethod:'chatgpt',availableModels:new Set(['native']),useHiddenModels:true};
 assert.equal(filter({...defaults,model:{model:'deepseek-v4-pro',_modelPickerExternal:true}}),true);
 assert.equal(filter({...defaults,model:{model:'native'}}),true);
 assert.equal(filter({...defaults,model:{model:'other'}}),false);
});
nativeTest('compiled external selection does not write the shared default',async()=>{
 const anchor='setDefaultModelConfig(e,t,n){',begin=source.indexOf(anchor),end=source.indexOf('onNotification(',begin);
 assert(begin>0&&end>begin);
 const C=vm.runInNewContext('(class {'+source.slice(begin,end)+'getHostId(){return "local"}defaultTurnConfig={writeModel(){throw Error("Global config write")}}})',{__codexModelPicker:createModelPicker(catalog)});
 const result=await new C().setDefaultModelConfig('deepseek-v4-pro','high',null);
 assert.equal(result.status,'okOverridden');
});
