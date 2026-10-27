import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {setupLocal,requireNode} from './scripts/setup-local.mjs';
import {localEnvironment,startLocal} from './scripts/start-local.mjs';
import {diagnose} from './scripts/doctor.mjs';
import {localSmoke} from './scripts/local-smoke.mjs';

function fixture(){const root=fs.mkdtempSync(path.resolve('.tmp-release-local-'));fs.copyFileSync('.env.example',path.join(root,'.env.example'));return root}
test('local setup creates private distinct keys without overwriting config or existing data',()=>{
 const root=fixture();try{
  const first=setupLocal(root);assert.equal(first.created,true);const filename=path.join(root,'.env'),original=fs.readFileSync(filename,'utf8'),env=parseEnv(original);
  const keys=['ADMIN_KEY','INGEST_KEY','READ_KEY','CONFIG_ENCRYPTION_KEY'].map(k=>env[k]);assert.equal(new Set(keys).size,4);for(const key of keys)assert.match(key,/^[a-f0-9]{64}$/);
  if(process.platform!=='win32')assert.equal(fs.statSync(filename).mode&0o777,0o600);
  assert.equal(env.HOST,'127.0.0.1');assert.equal(setupLocal(root).created,false);assert.equal(fs.readFileSync(filename,'utf8'),original);
  fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data','agentguard.sqlite'),'existing-ledger');fs.unlinkSync(filename);assert.throws(()=>setupLocal(root),/恢复原配置/);assert.equal(fs.readFileSync(path.join(root,'data','agentguard.sqlite'),'utf8'),'existing-ledger');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('setup rejects symlink destinations and validates Node version',()=>{
 const root=fixture();try{fs.writeFileSync(path.join(root,'secret-target'),'untouched');fs.symlinkSync(path.join(root,'secret-target'),path.join(root,'.env'));assert.throws(()=>setupLocal(root),/普通文件/);assert.equal(fs.readFileSync(path.join(root,'secret-target'),'utf8'),'untouched');for(const version of ['18.20.8','20.18.3','invalid'])assert.throws(()=>requireNode(version),/Node.js 20.19/);for(const version of ['20.19.0','20.19.6','22.9.0','24.1.0'])assert.doesNotThrow(()=>requireNode(version))}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('launcher anchors configuration, validates ports and retains explicit environment overrides',()=>{
 const root=fixture();try{setupLocal(root);const env=localEnvironment(root,{});assert.equal(env.PORT,'8080');assert.equal(env.HOST,'127.0.0.1');assert.equal(localEnvironment(root,{PORT:'9090'}).PORT,'9090');for(const PORT of ['0','65536','NaN','1.5'])assert.throws(()=>localEnvironment(root,{PORT}),/PORT/);assert.throws(()=>localEnvironment(root,{READ_KEY:env.ADMIN_KEY}),/不同/);const file=path.join(root,'.env');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/^HOST=.*\n/m,''));assert.equal(localEnvironment(root,{}).HOST,'127.0.0.1','older env files without HOST remain loopback');}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('doctor reports status without exposing secret values or executing external calls',async()=>{
 const root=fixture();try{setupLocal(root);const env=localEnvironment(root,{});const report=await diagnose({root,inherited:{},checkClients:false});assert.equal(report.configuration,'ready');assert.equal(report.server.checked,false);assert.equal(report.keys.CONFIG_ENCRYPTION_KEY,true);for(const name of ['ADMIN_KEY','READ_KEY','INGEST_KEY','CONFIG_ENCRYPTION_KEY'])assert.ok(!JSON.stringify(report).includes(env[name]));assert.deepEqual(report.errors,[])}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('doctor fails configuration readiness when the encryption key is absent or invalid',async()=>{
 const root=fixture();try{setupLocal(root);for(const key of ['','not-a-valid-secret']){const report=await diagnose({root,inherited:{CONFIG_ENCRYPTION_KEY:key},checkClients:false});assert.equal(report.configuration,'invalid');assert.equal(report.keys.CONFIG_ENCRYPTION_KEY,false);assert.ok(report.errors.some(error=>error.includes('CONFIG_ENCRYPTION_KEY')));assert.ok(!JSON.stringify(report).includes('not-a-valid-secret'));}}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('local launcher starts in the selected repository, not the callers current directory',async()=>{
 const root=fixture();try{setupLocal(root);fs.writeFileSync(path.join(root,'server.mjs'),'process.stdout.write(JSON.stringify({cwd:process.cwd(),host:process.env.HOST,port:process.env.PORT}))');const child=startLocal({root,inherited:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',c=>output+=c);assert.equal(await new Promise(r=>child.once('exit',r)),0);assert.deepEqual(JSON.parse(output),{cwd:root,host:'127.0.0.1',port:'8080'});}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('isolated local smoke exercises real HTTP, provider probe and SQLite without modifying user data',async()=>{
 const result=await localSmoke();assert.equal(result.ok,true);assert.equal(result.externalCalls,false);assert.equal(result.persistentDataModified,false);assert.ok(result.checks.includes('provider probe contract (local mock)'));
});
