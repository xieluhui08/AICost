import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {Ledger} from './ledger.mjs';
import {CodingService} from './coding.mjs';
import {flatten,normalize} from './telemetry.mjs';
import {guardRun,clientConfig} from './scripts/guard-run.mjs';
import {runHook} from './scripts/claude-hook.mjs';

const envelope=attrs=>({resourceLogs:[{scopeLogs:[{logRecords:[{attributes:Object.entries({'event.timestamp':'2026-10-27T08:00:00Z',...attrs}).map(([key,value])=>({key,value:typeof value==='boolean'?{boolValue:value}:{stringValue:String(value)}}))}]}]}]});
const usage=(extra={})=>envelope({'event.name':'api_request','session.id':'s',request_id:'r1',model:'test',input_tokens:10,output_tokens:3,cache_read_tokens:0,cache_creation_tokens:0,...extra});
function fixture(){const dir=fs.mkdtempSync(path.resolve('.tmp-telemetry-regression-')),ledger=new Ledger(dir);let state=ledger.state;const service=new CodingService({ledger,getState:()=>state,setState:s=>state=s,alert:async()=>{}});return {ledger,service,state:()=>state,close(){ledger.close();fs.rmSync(dir,{recursive:true,force:true})}}}
const config={name:'regression',source:'claude-code',mode:'managed',budget:1,usdToCny:7};

test('terminal heartbeat replay cannot settle approved tasks or impersonate another runner',async()=>{
 const f=fixture();try{const c=f.service.create(config),task=()=>Object.values(f.state().tasks)[0];
  const beat=async b=>{let result;await f.service.handle({method:'POST',headers:{authorization:'Bearer '+c.token}},null,new URL('http://localhost/api/telemetry/'+c.id+'/heartbeat'),{admin:false,read:false,send:(r,status,data)=>result={status,data},body:async()=>b});return result};
  assert.equal((await beat({runner:'A',state:'completed'})).status,409,'must claim before final status');
  assert.equal((await beat({runner:'A',state:'running'})).status,409,'must claim before running');
  assert.equal((await beat({runner:'A',state:'starting'})).status,200);
  assert.equal((await beat({runner:'B',state:'starting'})).status,409);
  await beat({runner:'A',state:'running'});
  await beat({runner:'A',state:'starting'});assert.equal(f.state().coding[c.id].controller.state,'running','late starting does not regress status');
  await beat({runner:'A',state:'stopped'});
  // An administrator approving a paused run restores running before the next claim.
  task().status='running';f.ledger.save(f.state());
  assert.equal((await beat({runner:'A',state:'stopped'})).status,200,'exact final retry is idempotent');assert.equal(task().status,'running');
  assert.equal((await beat({runner:'A',state:'completed'})).status,409);assert.equal(task().status,'running');
  assert.equal((await beat({runner:'A',state:'running'})).status,409);
  assert.equal((await beat({runner:'A',state:'starting'})).status,409,'run IDs cannot be reused');
  assert.equal((await beat({runner:'B',state:'starting'})).status,200);
  assert.equal((await beat({runner:'A',state:'stopped'})).status,409,'old runner cannot terminate new claim');
  f.state().coding[c.id].enabled=false;
  assert.equal((await beat({runner:'B',state:'running'})).status,409);
  assert.equal((await beat({runner:'B',state:'stopped'})).status,200,'revoked runner must still confirm shutdown');
  assert.equal(task().status,'stopped');
 }finally{f.close()}
});

test('blank and boolean telemetry prices never turn unknown charges into free calls',()=>{
 for(const cost of ['', '   ', false, true]){const e=normalize(flatten(usage({cost_usd:cost}))[0],'claude-code',config);assert.equal(e.basis,'unpriced',JSON.stringify(cost))}
 for(const micros of ['', ' ', true]){const e=normalize(flatten(usage({cost_usd_micros:micros}))[0],'claude-code',config);assert.equal(e.basis,'unpriced')}
 const zero=normalize(flatten(usage({cost_usd:'0'}))[0],'claude-code',config);assert.equal(zero.cost,0);assert.equal(zero.basis,'telemetry_estimate');
 const tokens=normalize(flatten(usage({input_tokens:true,output_tokens:' ',cost_usd:'0.1'}))[0],'claude-code',config);assert.equal(tokens.input_tokens,null);assert.equal(tokens.output_tokens,null);
 const proto=normalize(flatten(usage({model:'constructor'}))[0],'claude-code',{prices:{}});assert.equal(proto.basis,'unpriced','unknown model must not resolve Object prototype');
 const f=fixture();try{const c=f.service.create(config);f.service.ingest(c,usage({cost_usd:' '}));assert.equal(f.service.decision(c).decision,'approval');assert.equal(f.service.list().connections[0].tasks[0].unknown_cost,1)}finally{f.close()}
});

test('client process environment excludes service secrets and stale connection credentials',()=>{
 const env={PATH:process.env.PATH,ADMIN_KEY:'admin',READ_KEY:'read',INGEST_KEY:'ingest',CONFIG_ENCRYPTION_KEY:'encryption',AG_CONNECTION_TOKEN:'old-connection',AG_GUARD_TOKEN:'old-hook',AG_GUARD_ORIGIN:'https://old.example',AG_GUARD_CONNECTION:'conn-old',AG_OTEL_AUTH:'Bearer old-auth',OPENAI_API_KEY:'client-key'};
 const codex=clientConfig('codex','http://127.0.0.1:8080','conn-new','new-token',env).env;
 for(const key of ['ADMIN_KEY','READ_KEY','INGEST_KEY','CONFIG_ENCRYPTION_KEY','AG_CONNECTION_TOKEN','AG_GUARD_TOKEN','AG_GUARD_ORIGIN','AG_GUARD_CONNECTION'])assert.equal(codex[key],undefined,key);
 assert.equal(codex.OPENAI_API_KEY,'client-key');assert.equal(codex.AG_OTEL_AUTH,'Bearer new-token');
 const claude=clientConfig('claude-code','http://127.0.0.1:8080','conn-new','new-token',env).env;
 assert.equal(claude.AG_GUARD_TOKEN,'new-token');assert.equal(claude.AG_GUARD_CONNECTION,'conn-new');assert.equal(claude.AG_OTEL_AUTH,undefined);
});

test('all managed entry points validate HTTPS origin and refuse credential-bearing redirects',async()=>{
 const unsafe=['http://example.invalid','https://user:password@example.invalid','https://example.invalid/path','https://example.invalid/?q=x'];
 for(const base of unsafe){assert.throws(()=>clientConfig('codex',base,'conn-test','secret'));await assert.rejects(guardRun({base,connection:'conn-test',token:'secret',command:process.execPath}));await assert.rejects(runHook({}, {AG_GUARD_ORIGIN:base,AG_GUARD_CONNECTION:'conn-test',AG_GUARD_TOKEN:'secret'}))}
 let redirectsReached=0;const server=http.createServer((req,res)=>{if(req.url==='/redirect-target'){redirectsReached++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({decision:'allow',mode:'managed'}))}else{res.writeHead(307,{location:'/redirect-target'});res.end()}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,dir=fs.mkdtempSync(path.resolve('.tmp-import-redirect-'));try{
  await assert.rejects(guardRun({base,connection:'conn-test',token:'secret',command:process.execPath,args:['-e','process.exit(0)']}));
  await assert.rejects(runHook({hook_event_name:'PreToolUse',session_id:'session',tool_use_id:'tool',tool_name:'Read',tool_input:{}},{AG_GUARD_ORIGIN:base,AG_GUARD_CONNECTION:'conn-test',AG_GUARD_TOKEN:'secret'}));
  const file=path.join(dir,'history.json');fs.writeFileSync(file,JSON.stringify({resourceLogs:[]}));
  const child=spawn(process.execPath,[path.resolve('scripts/import-telemetry.mjs'),'conn-test',file],{env:{...process.env,AG_URL:base,AG_CONNECTION_TOKEN:'secret'},stdio:'ignore'});const code=await new Promise(r=>child.once('exit',r));assert.equal(code,1);assert.equal(redirectsReached,0);
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
});
