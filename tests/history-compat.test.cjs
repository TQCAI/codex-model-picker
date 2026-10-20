const {test}=require('node:test');
const assert=require('node:assert/strict');
const {compatibleRollout}=require('../src/router.js');
const provider=model=>model==='ds'?{id:'external'}:undefined;
const line=(type,payload)=>JSON.stringify({type,payload})+'\n';
test('reasoning conversion retains exact Unicode text without annotations, duplicate summary or changed tool items',()=>{
 const reasoning={type:'reasoning',summary:[{type:'summary_text',text:'duplicate summary'}],content:[{type:'reasoning_text',text:'推理\nα'}],encrypted_content:null};
 const context=line('turn_context',{model:'ds'}),raw=line('response_item',reasoning);
 const call=line('response_item',{type:'function_call',call_id:'call1',name:'lookup',arguments:'{}'});
 const result=line('response_item',{type:'function_call_output',call_id:'call1',output:'answer'});
 const source=context+raw+call+result,first=compatibleRollout(source,'openai',provider,'external');
 assert(first.changed);assert(first.text.startsWith(context));assert(first.text.endsWith(call+result));
 const record=JSON.parse(first.text.split('\n')[1]);assert.deepEqual(record.payload.content,[{type:'output_text',text:'推理\nα'}]);
 assert(!JSON.stringify(record.payload).includes('duplicate summary'));
 assert.deepEqual(record.codex_model_picker_reasoning.payload,reasoning);
 assert.equal(compatibleRollout(first.text,'openai',provider,'openai').changed,false);
 const restored=compatibleRollout(first.text,'external',provider,'openai');
 assert.deepEqual(JSON.parse(restored.text.split('\n')[1]).payload,reasoning);
});
test('native encrypted reasoning stays native for GPT and is not forwarded to an external service',()=>{
 const source=line('turn_context',{model:'gpt'})+line('response_item',{type:'reasoning',summary:[],encrypted_content:'native-private-blob'});
 assert.equal(compatibleRollout(source,'openai',provider,'openai').text,source);
 const converted=compatibleRollout(source,'external',provider,'openai');
 const payload=JSON.parse(converted.text.split('\n')[1]).payload;
 assert.equal(payload.encrypted_content,null);assert.equal(payload.content.length,0);
 const restored=compatibleRollout(converted.text,'openai',provider,'external');
 assert.equal(JSON.parse(restored.text.split('\n')[1]).payload.encrypted_content,'native-private-blob');
});
test('malformed history fails closed instead of dropping records',()=>{
 assert.throws(()=>compatibleRollout('{broken\n','openai',provider,'external'),SyntaxError);
});
