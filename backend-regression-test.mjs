import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import Database from 'better-sqlite3';
import {Ledger,usageRow} from './ledger.mjs';
import {task} from './dist/engine.mjs';

test('usage export snapshot freezes offsets during new ingestion',()=>{
 const dir=fs.mkdtempSync(path.resolve('.tmp-snapshot-')),ledger=new Ledger(dir);
 try{const state=structuredClone(ledger.state),t=task('snapshot');state.tasks[t.id]=t;
  const rows=Array.from({length:3},(_,i)=>usageRow(t,{id:'e'+i,at:`2026-10-2${i+1}T00:00:00Z`,cost:i+1}));
  ledger.save(state,rows);const first=ledger.query(new URLSearchParams('limit=1'));assert.equal(first.snapshot,3);
  ledger.save(state,[usageRow(t,{id:'new',at:'2026-10-27T00:00:00Z',cost:100})]);
  const remaining=ledger.query(new URLSearchParams('limit=500&offset=1&snapshot='+first.snapshot));
  assert.deepEqual([...first.rows,...remaining.rows].map(r=>r.event_id),['e2','e1','e0']);assert.equal(remaining.summary.requests,3);assert.equal(remaining.summary.cost,6);
  assert.equal(ledger.query(new URLSearchParams()).summary.requests,4);
  for(const snapshot of ['-1','x','1.5','9007199254740992'])assert.throws(()=>ledger.query(new URLSearchParams({snapshot})),/快照/);
 }finally{ledger.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('HTTP UTF-8 boundaries, evaluation rollback, failed SQLite rollback and safe restart',async()=>{
 const dir=fs.mkdtempSync(path.resolve('.tmp-backend-regression-')),base='http://127.0.0.1:18953';let child,db;
 const start=async()=>{child=spawn(process.execPath,[path.resolve('server.mjs')],{cwd:dir,env:{...process.env,NODE_ENV:'test',PORT:'18953',ADMIN_KEY:'qa-admin',INGEST_KEY:'qa-ingest',READ_KEY:'qa-read'},stdio:['ignore','pipe','pipe']});await new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('startup timeout')),4000);child.stdout.once('data',()=>{clearTimeout(timer);r()});child.once('exit',()=>{clearTimeout(timer);j(Error('server exited'))})})};
 const stop=async()=>{if(child){child.kill();await new Promise(r=>child.once('exit',r));child=null}};
 const call=async(route,body,raw=false)=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer qa-admin','content-type':'application/json'},body:body===undefined?undefined:raw?body:JSON.stringify(body)});return{status:r.status,data:await r.json()}};
 try{await start();
  const bytes=Buffer.from(JSON.stringify({id:'utf8',policy:'research',customer:'中文🙂',feature:'测试'})),split=bytes.indexOf(Buffer.from('中'))+1;
  const response=await new Promise((resolve,reject)=>{const req=http.request(base+'/api/tasks',{method:'POST',headers:{authorization:'Bearer qa-admin','content-type':'application/json'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))}))});req.on('error',reject);req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),20)});
  assert.equal(response.status,201);assert.equal(response.data.customer,'中文🙂');
  const deep='{"id":"deep","tool":"tool","cost":1,"input":'+('{"n":'.repeat(10000))+'0'+('}'.repeat(10000))+'}';
  assert.equal((await call('/api/tasks/utf8/events',deep,true)).status,400);
  let current=(await call('/api/tasks')).data.tasks[0];assert.equal(current.cost,0);assert.equal(current.events.length,0);
  db=new Database(path.join(dir,'data/agentguard.sqlite'));db.exec("CREATE TRIGGER qa_fail BEFORE UPDATE ON app_state BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
  const event={id:'retry-me',cost:1,tool:'lookup',input:{q:'x'}};
  assert.equal((await call('/api/tasks/utf8/events',event)).status,503);
  current=(await call('/api/tasks')).data.tasks[0];assert.equal(current.cost,0);assert.equal(current.events.length,0);
  assert.equal((await call('/api/usage')).data.summary.requests,0);
  assert.equal((await call('/api/tasks/utf8/decision')).status,503,'decisions fail closed after storage fault');
  db.exec('DROP TRIGGER qa_fail');assert.equal((await call('/api/tasks/utf8/events',event)).status,503,'operator restart is required after storage repair');
  db.close();db=null;await stop();await start();
  assert.equal((await call('/api/tasks/utf8/events',event)).status,200);assert.equal((await call('/api/tasks/utf8/events',event)).status,200);
  current=(await call('/api/tasks')).data.tasks[0];assert.equal(current.cost,1);assert.equal(current.events.length,1);assert.equal((await call('/api/usage')).data.summary.requests,1);
 }finally{db?.close();await stop();fs.rmSync(dir,{recursive:true,force:true})}
});

test('unsafe access keys are rejected at startup without printing their values',async()=>{
 const dir=fs.mkdtempSync(path.resolve('.tmp-keys-'));
 try{for(const extra of [{READ_KEY:'admin'},{INGEST_KEY:'replace-with-random-ingest-key'},{NODE_ENV:'production'}]){
  const child=spawn(process.execPath,[path.resolve('server.mjs')],{cwd:dir,env:{...process.env,NODE_ENV:'test',ADMIN_KEY:'admin',INGEST_KEY:'ingest',READ_KEY:'read',...extra},stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',c=>output+=c);const code=await new Promise(r=>child.once('exit',r));assert.notEqual(code,0);assert.match(output,/必须使用不同|不能使用示例|至少需要 32/);assert.ok(!output.includes('replace-with-random-ingest-key'));
 }}finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('proxy stores canonical hashes without prompt text and recovers failed settlement reservations',async()=>{
 const dir=fs.mkdtempSync(path.resolve('.tmp-proxy-failure-'));let release,blocked=false,child,db;
 const upstream=http.createServer(async(req,res)=>{for await(const _chunk of req){}if(blocked)await new Promise(r=>release=r);res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'qa-model',choices:[],usage:{prompt_tokens:10,completion_tokens:1}}))});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:18954';
 const start=async()=>{child=spawn(process.execPath,[path.resolve('server.mjs')],{cwd:dir,env:{...process.env,NODE_ENV:'test',PORT:'18954',ADMIN_KEY:'qa-admin',INGEST_KEY:'qa-ingest',READ_KEY:'qa-read',DEEPSEEK_BASE_URL:'http://127.0.0.1:'+upstream.address().port,DEEPSEEK_API_KEY:'upstream-test',DEEPSEEK_MODEL:'qa-model',DEEPSEEK_INPUT_CNY_PER_M:'1',DEEPSEEK_OUTPUT_CNY_PER_M:'2'},stdio:['ignore','pipe','pipe']});await new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('startup timeout')),4000);child.stdout.once('data',()=>{clearTimeout(timer);r()});child.once('exit',()=>{clearTimeout(timer);j(Error('server exited'))})})};
 const stop=async()=>{if(child){child.kill();await new Promise(r=>child.once('exit',r));child=null}};
 const call=async(route,body,headers={})=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{authorization:'Bearer qa-admin','content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()}};
 try{await start();await call('/api/tasks',{id:'private',policy:'support'});const secret='DO_NOT_PERSIST_THIS_PRIVATE_PROMPT';
  for(let i=0;i<3;i++){const message=i===1?{content:secret,role:'user'}:{role:'user',content:secret};assert.equal((await call('/v1/chat/completions',{messages:[message],max_tokens:5},{'x-task-id':'private','x-provider':'deepseek'})).status,200)}
  const result=(await call('/api/tasks')).data;assert.ok(!JSON.stringify(result).includes(secret));assert.equal(result.tasks[0].status,'stopped');assert.equal(result.tasks[0].alerts[0].type,'loop');
  assert.ok(result.tasks[0].events.every(e=>/^[a-f0-9]{64}$/.test(e.input.messages_sha256)));
  db=new Database(path.join(dir,'data/agentguard.sqlite'));assert.ok(!db.prepare('SELECT payload FROM app_state').get().payload.includes(secret));
  await call('/api/tasks',{id:'recovery',policy:'research'});blocked=true;
  const pending=call('/v1/chat/completions',{messages:[{role:'user',content:secret}],max_tokens:5},{'x-task-id':'recovery','x-provider':'deepseek'});
  for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);
  const reserved=(await call('/api/tasks')).data.tasks.find(t=>t.id==='recovery').reserved;assert.ok(reserved>0);
  db.exec("CREATE TRIGGER qa_fail BEFORE UPDATE ON app_state BEGIN SELECT RAISE(ABORT,'injected settlement failure'); END");release();assert.equal((await pending).status,503);
  let recovery=(await call('/api/tasks')).data.tasks.find(t=>t.id==='recovery');assert.equal(recovery.cost,0);assert.equal(recovery.reserved,reserved);
  db.exec('DROP TRIGGER qa_fail');db.close();db=null;await stop();await start();
  recovery=(await call('/api/tasks')).data.tasks.find(t=>t.id==='recovery');assert.equal(recovery.cost,reserved);assert.equal(recovery.reserved,0);assert.equal(recovery.status,'approval');
  const history=(await call('/api/usage')).data.rows.filter(r=>r.task_id==='recovery');assert.equal(history.length,1);assert.equal(history[0].basis,'reserved_estimate');
 }finally{db?.close();await stop();await new Promise(r=>upstream.close(r));fs.rmSync(dir,{recursive:true,force:true})}
});
