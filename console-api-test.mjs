import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import Database from 'better-sqlite3';

async function fixture(){
 const dir=fs.mkdtempSync(path.resolve('.tmp-console-api-'));let child,base;
 const start=async()=>{child=spawn(process.execPath,[path.resolve('server.mjs')],{cwd:dir,env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',ADMIN_KEY:'qa-admin',INGEST_KEY:'qa-ingest',READ_KEY:'qa-read'},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),5000);let out='',error='';child.stderr.on('data',c=>error+=c);child.stdout.on('data',c=>{out+=c;const m=out.match(/port (\d+)/);if(m){base='http://127.0.0.1:'+m[1];clearTimeout(timer);resolve()}});child.once('exit',()=>{clearTimeout(timer);reject(Error(error||'server exited'))})})};
 const stop=async()=>{if(child){child.kill();if(child.exitCode===null)await new Promise(r=>child.once('exit',r));child=null}};
 const call=async(route,{method='GET',body,key='qa-admin'}={})=>{const res=await fetch(base+route,{method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json()}};
 await start();return{call,dir,restart:async()=>{await stop();await start()},close:async()=>{await stop();fs.rmSync(dir,{recursive:true,force:true})}};
}

test('real console authentication, zero-state overview, filters and read-only boundaries',async()=>{
 const f=await fixture();try{
  assert.equal((await f.call('/api/session',{key:'wrong'})).status,401);
  assert.equal((await f.call('/api/session',{key:'qa-ingest'})).status,401);
  assert.deepEqual((await f.call('/api/session',{key:'qa-read'})).data,{role:'read',canManage:false,storageReady:true});
  assert.equal((await f.call('/api/session')).data.role,'admin');
  const empty=(await f.call('/api/overview',{key:'qa-read'})).data;assert.equal(empty.counts.total,0);assert.equal(empty.metrics.cost,0);assert.deepEqual(empty.latestTasks,[]);assert.equal(empty.usage.requests,0);
  assert.equal((await f.call('/api/tasks',{method:'POST',key:'qa-read',body:{id:'no',policy:'research'}})).status,403);
  for(const [id,customer,feature]of [['first','客户甲','研究'],['second','客户乙','内容']])assert.equal((await f.call('/api/tasks',{method:'POST',key:'qa-ingest',body:{id,policy:'research',name:id+' name',customer,feature}})).status,201);
  const filtered=(await f.call('/api/tasks?q=first&customer='+encodeURIComponent('客户甲')+'&feature='+encodeURIComponent('研究'),{key:'qa-read'})).data;assert.equal(filtered.total,1);assert.equal(filtered.tasks[0].id,'first');assert.equal(filtered.canManage,false);assert.equal(filtered.tasks[0].budget,10);assert.equal(filtered.tasks[0].policyName,'研究智能体');
  assert.equal((await f.call('/api/tasks?status=invalid')).status,400);assert.equal((await f.call('/api/tasks?limit=501')).status,400);assert.equal((await f.call('/api/tasks/absent')).status,404);
  for(const action of ['stop','approve','finish'])assert.equal((await f.call('/api/tasks/first/'+action,{method:'POST',key:'qa-read',body:{}})).status,403);
  assert.equal((await f.call('/api/tasks/first/stop',{method:'POST',body:{}})).status,200);
  assert.equal((await f.call('/api/tasks?status=stopped')).data.total,1);
  assert.equal((await f.call('/api/tasks?offset=1&limit=1')).data.tasks.length,1);
 }finally{await f.close()}
});

test('policy revisions persist, reject stale writes, and only change future task/connection snapshots',async()=>{
 const f=await fixture();try{
  const policies=(await f.call('/api/policies',{key:'qa-read'})).data;assert.equal(policies.policies.length,3);const before=policies.policies.find(p=>p.id==='research');
  const make=(id,budget)=>f.call('/api/tasks',{method:'POST',body:{id,policy:'research',...(budget===undefined?{}:{budget})}});
  await make('old');
  const codingBody={name:'old-code',source:'claude-code',mode:'managed',policy:'research',budget:8,usdToCny:7};
  const oldCode=(await f.call('/api/coding/connections',{method:'POST',body:codingBody})).data;
  const oldTask=(await f.call('/api/coding/connections')).data.connections.find(c=>c.id===oldCode.id).tasks[0];
  for(let i=0;i<2;i++)assert.equal((await f.call('/api/coding/connections/'+oldCode.id+'/stop',{method:'POST',body:{}})).status,200);
  const stopped=(await f.call('/api/tasks/'+oldTask.id)).data;assert.equal(stopped.audit.length,1);assert.equal(stopped.audit[0].action,'stop');assert.equal(stopped.audit[0].connection_id,oldCode.id);assert.deepEqual(stopped.audit[0].before,{status:'running',budget:8});
  const update={...before,budget:3,loop:2,retries:2,children:2,action:'approve'};
  assert.equal((await f.call('/api/policies/research',{method:'PUT',key:'qa-read',body:update})).status,403);
  assert.equal((await f.call('/api/policies/research',{method:'PUT',body:{...update,loop:13}})).status,400);
  const saved=await f.call('/api/policies/research',{method:'PUT',body:update});assert.equal(saved.status,200);assert.equal(saved.data.revision,1);
  assert.equal((await f.call('/api/policies/research',{method:'PUT',body:update})).status,409);
  await make('new');await make('override',.25);
  assert.equal((await make('invalid',0)).status,400);
  const newer=(await f.call('/api/coding/connections',{method:'POST',body:{...codingBody,name:'new-code'}})).data;
  assert.equal(oldCode.policy_snapshot.loop,4);assert.equal(newer.policy_snapshot.loop,2);assert.equal(newer.policy_revision,1);
  const managedTask=(await f.call('/api/coding/connections')).data.connections.find(c=>c.id===newer.id).tasks[0];assert.equal((await f.call('/api/tasks/'+managedTask.id+'/finish',{method:'POST',body:{status:'success'}})).status,409);
  for(const [id,budget,revision]of [['old',10,0],['new',3,1],['override',.25,1]]){const t=(await f.call('/api/tasks/'+id)).data.task;assert.equal(t.budget,budget);assert.equal(t.policy_revision,revision)}
  for(const id of ['old','new'])await f.call('/api/tasks/'+id+'/events',{method:'POST',key:'qa-ingest',body:{id:'cost',tool:'once',cost:4}});
  assert.equal((await f.call('/api/tasks/old')).data.task.status,'running');assert.equal((await f.call('/api/tasks/new')).data.task.status,'approval');
  // Modified research loop threshold is effective for new managed coding tasks.
  const payload={resourceLogs:[{scopeLogs:[{logRecords:Array.from({length:2},(_,i)=>({timeUnixNano:String(BigInt(Date.now()+i)*1000000n),attributes:Object.entries({'event.name':'tool_result','session.id':'s',tool_use_id:'tool-'+i,tool_name:'Read',tool_input:'{"file":"same"}',success:true}).map(([key,value])=>({key,value:{stringValue:String(value)}}))}))}]}]};
  assert.equal((await f.call('/api/telemetry/'+newer.id+'/v1/logs',{method:'POST',key:newer.token,body:payload})).status,200);
  const codeTask=(await f.call('/api/coding/connections')).data.connections.find(c=>c.id===newer.id).tasks[0];assert.equal(codeTask.status,'stopped');assert.equal(codeTask.alerts[0].type,'loop');
  await f.restart();const read=(await f.call('/api/policies')).data;assert.equal(read.policies.find(p=>p.id==='research').revision,1);assert.equal(read.audit.length,1);assert.equal(read.audit[0].before.budget,10);assert.equal(read.audit[0].after.budget,3);
  assert.equal((await f.call('/api/tasks/old')).data.task.budget,10);
 }finally{await f.close()}
});

test('real approval audit, overview and business/model costs reconcile with ledger and persist restart',async()=>{
 const f=await fixture();try{
  for(const id of ['success','failed','pending'])await f.call('/api/tasks',{method:'POST',body:{id,policy:'research',customer:'团队',feature:'研究'}});
  const event=(id,cost,model)=>f.call('/api/tasks/'+id+'/events',{method:'POST',key:'qa-ingest',body:{id:'usage',cost,tool:'one',provider:'DEEPSEEK',model,input_tokens:100,output_tokens:20}});
  await event('success',2,'a');await event('failed',1,'a');await event('pending',11,'b');
  await f.call('/api/tasks/success/finish',{method:'POST',body:{status:'success'}});await f.call('/api/tasks/failed/finish',{method:'POST',body:{status:'failed'}});
  const alerts=(await f.call('/api/alerts?status=approval',{key:'qa-read'})).data;assert.equal(alerts.total,1);assert.equal(alerts.alerts[0].task_id,'pending');assert.equal(alerts.alerts[0].budget,10);
  let overview=(await f.call('/api/overview')).data;assert.equal(overview.metrics.cost,14);assert.equal(overview.counts.approval,1);assert.equal(overview.metrics.success,1);assert.equal(overview.metrics.completed,2);assert.equal(overview.riskCount,1);
  const costs=(await f.call('/api/costs',{key:'qa-read'})).data;assert.equal(costs.summary.cost,14);assert.equal(costs.usage.cost,14);assert.equal(costs.groups[0].cost,14);assert.equal(costs.groups[0].unit,14);assert.equal(costs.models.find(x=>x.model==='a').cost,3);assert.equal(costs.models.find(x=>x.model==='a').unit,3);assert.equal(costs.models.find(x=>x.model==='b').unit,null);
  assert.equal((await f.call('/api/tasks/pending/approve',{method:'POST',body:{approved:true,extraBudget:5}})).data.budget,16);
  assert.equal((await f.call('/api/tasks/pending/approve',{method:'POST',body:{approved:true,extraBudget:5}})).status,409);
  await f.call('/api/tasks/pending/stop',{method:'POST',body:{}});await f.call('/api/tasks/pending/stop',{method:'POST',body:{}});
  await f.restart();const detail=(await f.call('/api/tasks/pending',{key:'qa-read'})).data;assert.equal(detail.task.status,'stopped');assert.equal(detail.audit.length,2);assert.equal(detail.audit[0].action,'approve');assert.deepEqual(detail.audit[0].before,{status:'approval',budget:10});assert.deepEqual(detail.audit[0].after,{status:'running',budget:16});assert.equal(detail.audit[0].actor,'admin');assert.equal(detail.audit[1].action,'stop');
  assert.equal((await f.call('/api/audit?task_id=pending',{key:'qa-read'})).data.total,2);
  overview=(await f.call('/api/overview')).data;assert.equal(overview.counts.approval,0);assert.equal(overview.metrics.completed,3);assert.equal(overview.metrics.cost,14);
 }finally{await f.close()}
});

test('failed policy and approval writes roll back their state and audit atomically',async()=>{
 const f=await fixture();let db;try{
  db=new Database(path.join(f.dir,'data/agentguard.sqlite'));
  const fail=()=>db.exec("CREATE TRIGGER console_fail BEFORE UPDATE ON app_state BEGIN SELECT RAISE(ABORT,'injected console write failure'); END");
  const repair=()=>db.exec('DROP TRIGGER console_fail');
  const p=(await f.call('/api/policies')).data.policies.find(p=>p.id==='research');
  fail();assert.equal((await f.call('/api/policies/research',{method:'PUT',body:{...p,budget:1}})).status,503);
  let policies=(await f.call('/api/policies')).data;assert.deepEqual(policies.policies.find(x=>x.id==='research'),p);assert.equal(policies.audit.length,0);assert.equal((await f.call('/api/session')).data.storageReady,false);
  repair();await f.restart();
  await f.call('/api/tasks',{method:'POST',body:{id:'pending',policy:'research'}});await f.call('/api/tasks/pending/events',{method:'POST',body:{id:'budget',cost:11}});
  fail();assert.equal((await f.call('/api/tasks/pending/approve',{method:'POST',body:{approved:true,extraBudget:5}})).status,503);
  let detail=(await f.call('/api/tasks/pending')).data;assert.equal(detail.task.status,'approval');assert.equal(detail.task.budget,10);assert.equal(detail.audit.length,0);
  repair();await f.restart();detail=(await f.call('/api/tasks/pending')).data;assert.equal(detail.task.status,'approval');assert.equal(detail.task.budget,10);assert.equal(detail.audit.length,0);assert.equal((await f.call('/api/costs')).data.summary.cost,11);
 }finally{db?.close();await f.close()}
});

test('monitor-only telemetry cannot be mistaken for process control or confirmed completion',async()=>{
 const f=await fixture();try{
  const c=(await f.call('/api/coding/connections',{method:'POST',body:{name:'observed',source:'claude-code',mode:'monitor',policy:'research',budget:5,usdToCny:7}})).data;
  const payload={resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:String(BigInt(Date.now())*1000000n),attributes:Object.entries({'event.name':'tool_result','session.id':'observe-session',tool_use_id:'tool',tool_name:'Read',tool_input:'{}',success:true}).map(([key,value])=>({key,value:{stringValue:String(value)}}))}]}]}]};
  assert.equal((await f.call('/api/telemetry/'+c.id+'/v1/logs',{method:'POST',key:c.token,body:payload})).status,200);
  const t=(await f.call('/api/coding/connections')).data.connections.find(x=>x.id===c.id).tasks[0];
  for(const action of ['stop','approve','finish'])assert.equal((await f.call('/api/tasks/'+t.id+'/'+action,{method:'POST',body:{status:'success',approved:true,extraBudget:1}})).status,409);
  assert.equal((await f.call('/api/coding/connections/'+c.id+'/stop',{method:'POST',body:{}})).status,409);
  assert.equal((await f.call('/api/coding/connections/'+c.id+'/revoke',{method:'POST',body:{}})).status,200);
  const detail=(await f.call('/api/tasks/'+t.id)).data;assert.equal(detail.task.status,'running');assert.equal(detail.audit.length,0);
  assert.equal((await f.call('/api/telemetry/'+c.id+'/v1/logs',{method:'POST',key:c.token,body:payload})).status,403);
 }finally{await f.close()}
});
