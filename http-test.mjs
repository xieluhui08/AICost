import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';
test('HTTP auth, event idempotency, approval and final cost',async()=>{const cwd=fs.mkdtempSync(path.resolve('.tmp-http-'));const child=spawn(process.execPath,[path.resolve('server.mjs')],{cwd,env:{...process.env,PORT:'18939',INGEST_KEY:'test-ingest',ADMIN_KEY:'test-admin'},stdio:['ignore','pipe','pipe']});try{await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('startup timeout')),4000);child.stdout.once('data',()=>{clearTimeout(timeout);resolve()});child.once('exit',()=>reject(Error('server exited')))});const call=async(p,b,key='test-ingest')=>{const r=await fetch('http://localhost:18939'+p,{method:b?'POST':'GET',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:r.status,data:await r.json()}};
assert.equal((await call('/api/tasks',null,'wrong')).status,401);
assert.equal((await call('/api/tasks',{id:'run1',policy:'research',customer:'客户',feature:'研究'})).status,201);
assert.equal((await call('/api/tasks',{id:'run1',policy:'research'})).status,409);
const event={id:'a',tool:'search',cost:11};assert.equal((await call('/api/tasks/run1/events',event)).data.decision,'approval');
await call('/api/tasks/run1/events',event);assert.equal((await call('/api/tasks/run1/decision')).data.cost,11);
assert.equal((await call('/api/tasks/run1/approve',{approved:true,extraBudget:5})).status,403);
assert.equal((await call('/api/tasks/run1/approve',{approved:true,extraBudget:5},'test-admin')).data.budget,16);
assert.equal((await call('/api/tasks/run1/finish',{status:'success'})).status,200);
assert.equal((await call('/api/tasks')).data.metrics.unit,11);
await call('/api/tasks',{id:'history',policy:'research'});
const history={id:'old-usage',at:'2026-10-01T16:00:00Z',provider:'KIMI',model:'model-history',source:'import',input_tokens:100,output_tokens:25,cached_tokens:50,cost:.2};
assert.equal((await call('/api/tasks/history/events',history)).status,200);await call('/api/tasks/history/events',history);
const historyUsage=(await call('/api/usage?from=2026-10-02&to=2026-10-02&model=model-history',null,'test-admin')).data;assert.equal(historyUsage.summary.requests,1);assert.equal(historyUsage.summary.cost,.2);assert.equal(historyUsage.rows[0].input_tokens,100);
assert.equal((await call('/api/tasks/history/events',{id:'bad',cost:1,input_tokens:10,cached_tokens:20})).status,400);
assert.equal((await call('/api/tasks/history/decision')).data.cost,.2);

}finally{child.kill();await new Promise(resolve=>child.once('exit',resolve))}});
