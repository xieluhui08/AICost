import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {runHook} from './scripts/claude-hook.mjs';
import {guardRun,clientConfig} from './scripts/guard-run.mjs';
const envelope=attrs=>({resourceLogs:[{scopeLogs:[{logRecords:[{attributes:Object.entries(attrs).map(([key,value])=>({key,value:{stringValue:String(value)}}))}]}]}]});
const usage=id=>envelope({'event.name':'api_request','session.id':'s','event.timestamp':new Date().toISOString(),request_id:id,model:'test',input_tokens:10,output_tokens:3,cache_read_tokens:2,cache_creation_tokens:0,cost_usd:1});
const base='http://127.0.0.1:18943';
test('HTTP connection isolation, approval, history import, real process-group termination and fail-closed runner',async()=>{
 const cwd=fs.mkdtempSync(path.resolve('.tmp-coding-http-'));
 const child=spawn(process.execPath,[path.resolve('server.mjs')],{cwd,env:{...process.env,PORT:'18943',INGEST_KEY:'ingest',ADMIN_KEY:'admin',READ_KEY:'read'},stdio:['ignore','pipe','pipe']});
 const call=async(p,data,key='admin')=>{const r=await fetch(base+p,{method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return{status:r.status,data:await r.json()}};
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve()});child.once('exit',()=>reject(Error('server exited')))});
  const cfg={name:'managed',source:'claude-code',mode:'managed',budget:.1,usdToCny:7};
  assert.equal((await call('/api/coding/connections',cfg,'read')).status,403);
  const c=(await call('/api/coding/connections',cfg)).data;
  assert.equal((await call('/api/coding/connections',undefined,c.token)).status,401);
  assert.equal((await call('/api/coding/connections',undefined,'read')).status,200);
  assert.equal((await call('/api/telemetry/'+c.id+'/v1/logs',usage('bad'),'wrong')).status,401);
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const pidFile=path.join(cwd,'grandchild.pid');
  const script=`const{spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const run=guardRun({base,connection:c.id,token:c.token,command:process.execPath,args:['-e',script],stdio:'ignore',pollMs:20,killMs:80,onMessage:()=>{}});
  for(let i=0;i<100&&!fs.existsSync(pidFile);i++)await new Promise(r=>setTimeout(r,20));assert.ok(fs.existsSync(pidFile));
  const hb=await call('/api/telemetry/'+c.id+'/heartbeat',{runner:'other',state:'starting'},c.token);assert.equal(hb.status,409);
  assert.equal((await call('/api/telemetry/'+c.id+'/v1/logs',usage('limit'),c.token)).status,200);
  const result=await run;assert.equal(result.code,75);
  const grandchild=Number(fs.readFileSync(pidFile,'utf8'));let alive=true;try{process.kill(grandchild,0);if(fs.existsSync('/proc/'+grandchild+'/stat'))alive=!/\) Z /.test(fs.readFileSync('/proc/'+grandchild+'/stat','utf8'));}catch{alive=false}assert.equal(alive,false,'grandchild terminated');
  process.kill(unrelated.pid,0);unrelated.kill();
  let list=(await call('/api/coding/connections',undefined,'read')).data.connections;assert.equal(list.find(x=>x.id===c.id).controller.state,'stopped');
  const c2=(await call('/api/coding/connections',{...cfg,name:'approval',action:'approve'})).data;
  await call('/api/telemetry/'+c2.id+'/v1/logs',usage('approve'),c2.token);let d=(await call('/api/telemetry/'+c2.id+'/decision',undefined,c2.token)).data;assert.equal(d.decision,'approval');
  assert.equal((await call('/api/tasks/'+d.task_id+'/approve',{approved:true,extraBudget:10},'read')).status,403);
  assert.equal((await call('/api/tasks/'+d.task_id+'/approve',{approved:true,extraBudget:10})).status,200);
  assert.equal((await call('/api/telemetry/'+c2.id+'/decision',undefined,c2.token)).data.decision,'allow');
  const c3=(await call('/api/coding/connections',{...cfg,name:'silence'})).data;
  const silent=await guardRun({base,connection:c3.id,token:c3.token,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],stdio:'ignore',pollMs:20,killMs:40,maxSilenceMs:60,onMessage:()=>{}});assert.match(silent.reason,/遥测/);
  const c4=(await call('/api/coding/connections',{...cfg,name:'network'})).data;
  const nativeFetch=globalThis.fetch;let reads=0;globalThis.fetch=(url,options)=>{if(String(url).endsWith('/decision')&&++reads>1)return Promise.reject(Error('network down'));return nativeFetch(url,options)};
  try{const lost=await guardRun({base,connection:c4.id,token:c4.token,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],stdio:'ignore',pollMs:20,killMs:40,onMessage:()=>{}});assert.match(lost.reason,/无法确认/)}finally{globalThis.fetch=nativeFetch}
  const hooked=(await call('/api/coding/connections',{...cfg,name:'hooks',budget:100,policy:'support'})).data;
  for(let i=0;i<3;i++){const result=await runHook({hook_event_name:'PreToolUse',session_id:'root',tool_use_id:'t'+i,tool_name:'Bash',tool_input:{cmd:'same command'}},{AG_GUARD_ORIGIN:base,AG_GUARD_CONNECTION:hooked.id,AG_GUARD_TOKEN:hooked.token});assert.equal(result.continue,i===2?false:undefined)}
  const lease=(await call('/api/coding/connections',{...cfg,name:'lease'})).data;const claims=await Promise.all(['a','b'].map(runner=>call('/api/telemetry/'+lease.id+'/heartbeat',{runner,state:'starting'},lease.token)));assert.deepEqual(claims.map(x=>x.status).sort(),[200,409]);
  const history=(await call('/api/coding/connections',{...cfg,name:'history',mode:'monitor'})).data;
  const old=usage('historical');old.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find(a=>a.key==='event.timestamp').value.stringValue='2026-10-01T23:00:00Z';
  assert.equal((await call('/api/coding/connections/'+history.id+'/import',old)).data.accepted,1);
  assert.equal((await call('/api/coding/connections/'+history.id+'/import',old)).data.duplicates,1);
  assert.equal((await call('/api/usage?from=2026-10-02&to=2026-10-02',undefined,'read')).data.summary.requests,1);
  assert.equal((await call('/api/coding/connections/'+history.id+'/revoke',{})).status,200);
  assert.equal((await call('/api/telemetry/'+history.id+'/v1/logs',usage('revoked'),history.token)).status,403);
 }finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));fs.rmSync(cwd,{recursive:true,force:true})}
});
test('client configuration preserves user command arguments without putting credentials on command line',()=>{const c=clientConfig('codex','http://localhost:8080','conn-test','SECRET',{ADMIN_KEY:'admin',AG_CONNECTION_TOKEN:'SECRET'});assert.ok(!JSON.stringify(c.args).includes('SECRET'));assert.equal(c.env.ADMIN_KEY,undefined);assert.equal(c.env.AG_OTEL_AUTH,'Bearer SECRET');assert.throws(()=>clientConfig('codex','http://remote.example','conn-test','secret'));const cl=clientConfig('claude-code','https://private.example','conn-test','secret',{});assert.equal(cl.env.CLAUDE_CODE_ENABLE_TELEMETRY,'1');assert.equal(cl.env.OTEL_LOG_USER_PROMPTS,'0')});
