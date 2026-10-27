import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {task,presets} from './dist/engine.mjs';

test('proxy reservations, downgrade, provider usage and stopped-state protection',async()=>{
 const requests=[];let waiting,received;
 const upstream=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const b=JSON.parse(body);requests.push(b);if(b.messages[0].content==='hold'){received?.();await new Promise(r=>waiting=r)}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok'}}],usage:{prompt_tokens:10,completion_tokens:b.max_tokens,prompt_cache_hit_tokens:8}}))});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const cwd=fs.mkdtempSync(path.resolve('.tmp-http-'));
 fs.mkdirSync(path.join(cwd,'data'));fs.writeFileSync(path.join(cwd,'data/state.json'),JSON.stringify({tasks:{recovered:task('recovered','research',{status:'stopped',reserved:1})},policies:presets}));
 const child=spawn(process.execPath,[path.resolve('server.mjs')],{cwd,env:{...process.env,PORT:'18940',ADMIN_KEY:'test-admin',INGEST_KEY:'test-ingest',READ_KEY:'test-read',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+upstream.address().port,DEEPSEEK_API_KEY:'fake-test-key',DEEPSEEK_MODEL:'test-primary',DEEPSEEK_FALLBACK_MODEL:'test-fallback',DEEPSEEK_INPUT_CNY_PER_M:'0',DEEPSEEK_OUTPUT_CNY_PER_M:'6000',DEEPSEEK_FALLBACK_INPUT_CNY_PER_M:'1000',DEEPSEEK_FALLBACK_CACHE_INPUT_CNY_PER_M:'100',DEEPSEEK_FALLBACK_OUTPUT_CNY_PER_M:'100'},stdio:['ignore','pipe','pipe']});
 const call=async(p,b,key='test-ingest',extra={})=>{const r=await fetch('http://127.0.0.1:18940'+p,{method:b?'POST':'GET',headers:{authorization:'Bearer '+key,'content-type':'application/json',...extra},body:b?JSON.stringify(b):undefined});return {status:r.status,data:await r.json()}};
 const proxy=(id,text='test',tokens=1000)=>call('/v1/chat/completions',{messages:[{role:'user',content:text}],max_tokens:tokens},'test-ingest',{'x-task-id':id,'x-provider':'deepseek'});
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),4000);child.stdout.once('data',()=>{clearTimeout(timer);resolve()});child.once('exit',()=>reject(Error('server exited')))});
  assert.equal((await call('/api/tasks/recovered/decision')).data.decision,'stop');assert.equal((await call('/api/tasks/recovered/decision')).data.cost,1);
  const staticPage=await fetch('http://127.0.0.1:18940/');assert.equal(staticPage.status,200);assert.match(await staticPage.text(),/AgentGuard/);
  await call('/api/tasks',{id:'manual',policy:'research'});assert.equal((await call('/api/tasks/manual/stop',{})).status,403);assert.equal((await call('/api/tasks/manual/stop',{},'test-admin')).data.decision,'stop');assert.equal((await proxy('manual')).status,409);
  for(const id of ['__proto__','constructor','prototype'])assert.equal((await call('/api/tasks',{id,policy:'research'})).status,400);
  assert.equal((await call('/api/tasks/constructor/decision')).status,404);
  await call('/api/tasks',{id:'concurrent',policy:'research'});
  const entered=new Promise(r=>received=r);const first=proxy('concurrent','hold');await entered;
  assert.equal((await call('/api/tasks/concurrent/decision')).data.reserved,6);
  assert.equal((await call('/api/tasks/concurrent/finish',{status:'success'})).status,409);
  assert.equal((await proxy('concurrent')).data.decision,'approval');
  assert.equal((await call('/api/tasks/concurrent/approve',{approved:'false',extraBudget:5},'test-admin')).status,400);
  await call('/api/tasks/concurrent/approve',{approved:false},'test-admin');
  waiting();await first;
  const ended=(await call('/api/tasks/concurrent/decision')).data;
  assert.equal(ended.decision,'stop');assert.equal(ended.cost,6);assert.equal(ended.reserved,0);
  assert.equal((await proxy('concurrent')).status,409);assert.equal(requests.length,1);
  await call('/api/tasks',{id:'downgrade',policy:'content'});
  assert.equal((await proxy('downgrade')).data.decision,'degrade');
  assert.equal(requests.length,1);
  assert.equal((await proxy('downgrade')).status,200);
  assert.equal(requests.at(-1).model,'test-fallback');
  assert.equal((await call('/api/tasks/downgrade/decision')).data.cost,.1028);
  assert.equal((await call('/api/usage',null,'test-ingest')).status,401);const usage=await call('/api/usage?model=test-fallback',null,'test-read');assert.equal(usage.status,200);assert.equal(usage.data.summary.requests,1);assert.equal(usage.data.summary.output_tokens,1000);assert.equal(usage.data.summary.cached_tokens,8);assert.equal(usage.data.rows[0].cost,.1028);assert.equal(JSON.parse(usage.data.rows[0].pricing).cached_input,100);assert.equal(usage.data.rows[0].basis,'usage_priced');assert.equal(usage.data.rows[0].provider,'DEEPSEEK');assert.equal(usage.data.rows[0].requested_model,'test-fallback');assert.ok(usage.data.rows[0].duration_ms>=0);assert.equal((await call('/api/tasks',null,'test-read')).status,200);assert.equal((await call('/api/usage?from=2026-02-30',null,'test-read')).status,400);
  assert.equal((await call('/v1/chat/completions',{messages:[{role:'user',content:[{type:'image_url'}]}]},'test-ingest',{'x-task-id':'downgrade','x-provider':'deepseek'})).status,400);
 }finally{waiting?.();child.kill();await new Promise(r=>child.once('exit',r));await new Promise(r=>upstream.close(r));fs.rmSync(cwd,{recursive:true,force:true})}
});
