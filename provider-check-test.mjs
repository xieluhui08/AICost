import test from 'node:test';
import assert from 'node:assert/strict';
import {checkProvider} from './scripts/check-provider.mjs';
const options={admin:'test-admin',ingest:'test-ingest',provider:'DEEPSEEK',confirm:true,budget:.1};
const response=(data,status=200)=>({ok:status<400,status,headers:{get:()=> 'application/json'},json:async()=>data});
const configuration=()=>({integrations:[{id:'DEEPSEEK',enabled:true,hasSecret:{API_KEY:true},values:{MODEL:'model-test',INPUT_CNY_PER_M:'1',OUTPUT_CNY_PER_M:'2'}}]});
test('paid local probe requires explicit opt-in and rejects remote destinations before requesting',async()=>{
  let requests=0;const request=async()=>{requests++;throw Error('unexpected request')};
  await assert.rejects(checkProvider({...options,confirm:false,request}),/confirm-paid-request/);
  for(const base of ['https://remote.example','http://127.0.0.1/path','http://user:secret@127.0.0.1','http://127.0.0.1/?token=x'])await assert.rejects(checkProvider({...options,base,request}),/仅允许本机/);
  for(const budget of [-1,0,2,NaN])await assert.rejects(checkProvider({...options,budget,request}),/预算/);
  assert.equal(requests,0);
});
test('paid local probe uses a separate bounded task and one generation, preserving cost evidence',async()=>{
  const routes=[];let taskId;
  const request=async(url,opts)=>{const route=new URL(url).pathname;routes.push(route);assert.equal(opts.redirect,'error');const body=opts.body?JSON.parse(opts.body):null;
    if(route==='/api/integrations')return response(configuration());
    if(route==='/api/tasks'){assert.equal(body.budget,.1);assert.equal(body.customer,'本机联调');taskId=body.id;return response({id:taskId},201)}
    if(route==='/v1/chat/completions'){assert.equal(body.max_tokens,16);assert.equal(opts.headers['x-task-id'],taskId);return response({model:'model-test',usage:{prompt_tokens:8,completion_tokens:1}})}
    if(route.endsWith('/decision'))return response({decision:'allow',cost:.00001});
    if(route.endsWith('/finish')){assert.equal(body.status,'success');return response({})}
    throw Error('unexpected request');
  };
  const result=await checkProvider({...options,request});assert.equal(result.task_id,taskId);assert.equal(result.cost,.00001);assert.equal(routes.filter(r=>r==='/v1/chat/completions').length,1);assert.ok(routes.at(-1).endsWith('/finish'));
});
test('price preflight prevents oversized probe and provider errors request stop without erasing task',async()=>{
  let requests=0;await assert.rejects(checkProvider({...options,budget:.0000001,request:async()=>{requests++;return response(configuration())}}),/预留超过/);assert.equal(requests,1);
  const routes=[];await assert.rejects(checkProvider({...options,request:async(url)=>{const p=new URL(url).pathname;routes.push(p);if(p==='/api/integrations')return response(configuration());if(p==='/api/tasks')return response({},201);if(p==='/v1/chat/completions')return response({error:'UPSTREAM_SECRET_MUST_NOT_BE_ECHOED'},502);if(p.endsWith('/stop'))return response({});throw Error('unexpected request')}}),error=>/HTTP 502/.test(error.message)&&!error.message.includes('UPSTREAM_SECRET'));
  assert.ok(routes.at(-1).endsWith('/stop'));assert.equal(routes.filter(p=>p==='/v1/chat/completions').length,1);
});
