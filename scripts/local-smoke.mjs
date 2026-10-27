// Disposable loopback integration test. Never reads .env or calls real providers.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {projectRoot,requireNode} from './setup-local.mjs';
import {checkProvider} from './check-provider.mjs';

export async function localSmoke({root=projectRoot}={}){
 requireNode();const dir=fs.mkdtempSync(path.join(root,'.tmp-release-smoke-'));
 const admin=crypto.randomBytes(32).toString('hex'),read=crypto.randomBytes(32).toString('hex'),ingest=crypto.randomBytes(32).toString('hex');
 const mock=http.createServer(async(req,res)=>{for await(const _chunk of req){}res.setHeader('content-type','application/json');if(req.url==='/models')res.end(JSON.stringify({data:[{id:'local-mock'}]}));else res.end(JSON.stringify({model:'local-mock',choices:[{message:{role:'assistant',content:'local test'}}],usage:{prompt_tokens:100,completion_tokens:20}}))});let child;
 try{
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  // Port 0 is supported by server; learn the actual bound port from stdout.
  child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:dir,env:{PATH:process.env.PATH||'',NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',ADMIN_KEY:admin,READ_KEY:read,INGEST_KEY:ingest,CONFIG_ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),DEEPSEEK_BASE_URL:'http://127.0.0.1:'+mock.address().port,DEEPSEEK_API_KEY:'local-mock-key',DEEPSEEK_MODEL:'local-mock',DEEPSEEK_INPUT_CNY_PER_M:'1',DEEPSEEK_OUTPUT_CNY_PER_M:'2'},stdio:['ignore','pipe','pipe']});
  const port=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('本机测试服务启动超时')),5000);child.stdout.on('data',chunk=>{output+=chunk.toString();const match=output.match(/port\s+(\d+)/);if(match&&Number(match[1])>0){clearTimeout(timeout);resolve(Number(match[1]))}});child.once('exit',()=>{clearTimeout(timeout);reject(Error('本机测试服务启动失败'))});child.once('error',()=>{clearTimeout(timeout);reject(Error('无法启动本机测试进程'))});});
  const base='http://127.0.0.1:'+port;
  const call=async(route,{method='GET',body,key=admin,headers={}}={})=>{const response=await fetch(base+route,{method,headers:{authorization:'Bearer '+key,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(5000)});assert.equal(response.ok,true,route+' HTTP '+response.status);return response.json()};
  assert.equal((await call('/api/session')).canManage,true);
  assert.equal((await call('/api/session',{key:read})).canManage,false);
  const html=await fetch(base+'/');assert.equal(html.status,200);assert.match(await html.text(),/AgentGuard/);
  await call('/api/tasks',{method:'POST',key:ingest,body:{id:'local-smoke-call',policy:'research',customer:'local-test',feature:'smoke'}});
  const output=await call('/v1/chat/completions',{method:'POST',key:ingest,headers:{'x-task-id':'local-smoke-call','x-provider':'deepseek'},body:{messages:[{role:'user',content:'local test only'}],max_tokens:20}});assert.equal(output.model,'local-mock');
  await call('/api/tasks/local-smoke-call/finish',{method:'POST',key:ingest,body:{status:'success'}});
  // Exercise the explicit provider-check command against this isolated mock only.
  const probe=await checkProvider({base,admin,ingest,provider:'DEEPSEEK',budget:.1,confirm:true});
  assert.match(probe.task_id,/^local-probe-/);assert.notEqual(probe.task_id,'local-smoke-call');assert.equal(probe.model,'local-mock');assert.equal(probe.budget,.1);assert.equal(probe.decision,'allow');assert.ok(probe.cost>0);assert.deepEqual(probe.usage,{prompt_tokens:100,completion_tokens:20});
  const probeDetail=await call('/api/tasks/'+probe.task_id,{key:read});assert.equal(probeDetail.task.status,'success');assert.equal(probeDetail.task.budget,.1);assert.equal(probeDetail.task.cost,probe.cost);
  const ledger=await call('/api/usage',{key:read});assert.equal(ledger.summary.requests,2);assert.ok(ledger.summary.cost>0);
  const probeRow=ledger.rows.find(row=>row.task_id===probe.task_id);assert.ok(probeRow);assert.equal(probeRow.input_tokens,100);assert.equal(probeRow.output_tokens,20);assert.equal(probeRow.cost,probe.cost);
  await call('/api/tasks',{method:'POST',key:ingest,body:{id:'local-smoke-approval',policy:'research'}});
  const paused=await call('/api/tasks/local-smoke-approval/events',{method:'POST',key:ingest,body:{id:'budget',tool:'local-test',cost:10.1}});assert.equal(paused.decision,'approval');
  const approved=await call('/api/tasks/local-smoke-approval/approve',{method:'POST',body:{approved:true,extraBudget:1}});assert.equal(approved.decision,'allow');
  const stopped=await call('/api/tasks/local-smoke-approval/stop',{method:'POST',body:{}});assert.equal(stopped.decision,'stop');
  for(const route of ['/api/overview','/api/tasks','/api/tasks/local-smoke-call','/api/policies','/api/costs'])await call(route,{key:read});
  return {ok:true,checks:['same-origin UI','admin/read permissions','proxy request and billing','provider probe contract (local mock)','SQLite usage ledger','budget approval and stop','five console APIs'],externalCalls:false,persistentDataModified:false};
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
  if(mock.listening)await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});
 }
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 if(process.argv.length>2){console.error('用法：node scripts/local-smoke.mjs（只运行隔离的本机测试）');process.exitCode=1;}else try{console.log(JSON.stringify(await localSmoke(),null,2))}catch(error){console.error('本机隔离联调未通过：'+error.message);process.exitCode=1;}
}
