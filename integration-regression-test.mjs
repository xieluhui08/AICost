import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {parseEnv} from 'node:util';
import {IntegrationStore} from './integrations.mjs';
import {envFile,validateConfig} from './dist/integration-core.mjs';

const values={BASE_URL:'https://example.test/v1',API_KEY:'secret',MODEL:'main',INPUT_CNY_PER_M:'0',OUTPUT_CNY_PER_M:'2',FALLBACK_MODEL:'backup',FALLBACK_INPUT_CNY_PER_M:'0',FALLBACK_OUTPUT_CNY_PER_M:'1'};
test('Node and Docker exports preserve exact credentials using their distinct parsers',()=>{
  const supplied={...values,API_KEY:'a#hash$dollar`tick"quote'};
  assert.equal(parseEnv(envFile('DEEPSEEK',supplied)).DEEPSEEK_API_KEY,supplied.API_KEY);
  for(const key of ["single'quote\\nliteral","both'\"quotes"]){assert.equal(parseEnv(envFile('DEEPSEEK',{...values,API_KEY:key})).DEEPSEEK_API_KEY,key)}
  // Docker env-file values are literal after the first '=', unlike Node dotenv.
  // Contract: https://docs.docker.com/reference/cli/docker/container/run/#set-environment-variables--e---env---env-file
  const docker=envFile('DEEPSEEK',supplied,'docker');
  const parsed=Object.fromEntries(docker.split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)]}));
  assert.equal(parsed.DEEPSEEK_API_KEY,supplied.API_KEY);
  assert.equal(parsed.DEEPSEEK_BASE_URL,values.BASE_URL);
  assert.equal(parsed.DEEPSEEK_INPUT_CNY_PER_M,'0');
  assert.throws(()=>envFile('DEEPSEEK',values,'unknown'),/格式/);
});
test('configuration rejects embedded control characters before producing files or HTTP headers',()=>{
  for(const char of ['\x00','\x01','\t','\n','\r','\x1b','\x7f'])assert.throws(()=>validateConfig('DEEPSEEK',{...values,API_KEY:'key'+char+'suffix'}),/控制字符/);
});
test('webhook tests require explicit channel-specific success acknowledgement',async()=>{
  const db=new Database(':memory:'),original=globalThis.fetch,store=new IntegrationStore(db,{CONFIG_ENCRYPTION_KEY:'c'.repeat(64)});
  try{
    for(const channel of ['FEISHU','WECOM']){
      store.save(channel,{revision:0,enabled:true,values:{WEBHOOK:'https://example.test/webhook'}});
      for(const body of [{},null,[],{message:'ok'},{code:1},{errcode:1},channel==='FEISHU'?{errcode:0}:{code:0}]){
        globalThis.fetch=async()=>({ok:true,json:async()=>body});
        const result=await store.test(channel);assert.equal(result.ok,false,channel+' '+JSON.stringify(body));
        assert.equal(store.snapshot(channel).verification.ok,false);
      }
      globalThis.fetch=async()=>({ok:true,json:async()=>channel==='FEISHU'?{code:0}:{errcode:0}});
      assert.equal((await store.test(channel)).ok,true);
    }
  }finally{globalThis.fetch=original;db.close()}
});
test('provider verification includes configured fallback and tolerates null model entries',async()=>{
  const db=new Database(':memory:'),original=globalThis.fetch,store=new IntegrationStore(db,{CONFIG_ENCRYPTION_KEY:'c'.repeat(64)});
  try{
    store.save('DEEPSEEK',{revision:0,enabled:true,values});
    globalThis.fetch=async()=>({ok:true,json:async()=>({data:[null,{id:'main'}]})});
    const missing=await store.test('DEEPSEEK');assert.equal(missing.ok,false);assert.match(missing.message,/备用模型/);
    globalThis.fetch=async()=>({ok:true,json:async()=>({data:[{id:'main'},{id:'backup'}]})});
    assert.equal((await store.test('DEEPSEEK')).ok,true);
  }finally{globalThis.fetch=original;db.close()}
});
test('environment-configured provider base URL trailing slash produces one models separator',async()=>{
  const db=new Database(':memory:'),original=globalThis.fetch;
  const env=Object.fromEntries(Object.entries({...values,BASE_URL:'https://example.test/v1/'}).map(([k,v])=>['DEEPSEEK_'+k,v]));
  try{const store=new IntegrationStore(db,env);globalThis.fetch=async url=>{assert.equal(url,'https://example.test/v1/models');return{ok:true,json:async()=>({data:[{id:'main'},{id:'backup'}]})}};assert.equal((await store.test('DEEPSEEK')).ok,true)}finally{globalThis.fetch=original;db.close()}
});
