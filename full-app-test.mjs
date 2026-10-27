// Explicit demo shell + real coding/config/usage modules + real HTTP server + SQLite. This is a DOM
// integration test, not a browser/layout test. Providers are local test doubles.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {parseHTML} from 'linkedom';
import {integrations} from './dist/integration-core.mjs';
import {openDialog,closeDialog,jsonRequest} from './dist/ui-core.mjs';

const dir=fs.mkdtempSync(path.resolve('.tmp-full-app-'));
const nativeFetch=globalThis.fetch, nativeInterval=globalThis.setInterval;
const upstream=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'qa-model'}]}))});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const server=spawn(process.execPath,[path.resolve('server.mjs')],{cwd:dir,env:{...process.env,PORT:'18949',ADMIN_KEY:'qa-admin',READ_KEY:'qa-read',INGEST_KEY:'qa-ingest',CONFIG_ENCRYPTION_KEY:'c'.repeat(64)},stdio:['ignore','pipe','pipe']});
let serverError='';server.stderr.on('data',c=>serverError+=c);
let checks=0;
try {
  await new Promise((r,j)=>{const t=setTimeout(()=>j(Error(serverError||'server startup timeout')),5000);server.stdout.once('data',()=>{clearTimeout(t);r()});server.once('exit',()=>{clearTimeout(t);j(Error(serverError||'server exited'))})});
  const base='http://127.0.0.1:18949';
  const {document}=parseHTML(fs.readFileSync('dist/demo.html','utf8'));
  globalThis.document=document;const window={};globalThis.window=window;
  const inputProto=Object.getPrototypeOf(document.createElement('input'));
  Object.defineProperty(inputProto,'checked',{configurable:true,get(){return this.hasAttribute('checked')},set(v){v?this.setAttribute('checked',''):this.removeAttribute('checked')}});
  const selectProto=Object.getPrototypeOf(document.createElement('select'));
  Object.defineProperty(selectProto,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??''},set(v){for(const o of this.querySelectorAll('option'))o.value===v?o.setAttribute('selected',''):o.removeAttribute('selected')}});
  globalThis.FormData=class{constructor(f){this.form=f}get(k){const e=this.form.querySelector('[name="'+k+'"]');return e?.disabled?null:e?.type==='checkbox'?(e.checked?e.value||'on':null):e?.value??null}};
  const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v))};
  globalThis.location={hash:'#overview',origin:base};
  const listeners={};window.addEventListener=(name,fn)=>listeners[name]=fn;
  const modal=document.querySelector('#modal');modal.showModal=()=>modal.open=true;
  modal.close=()=>{modal.open=false;setImmediate(()=>modal.onclose?.())};
  let clipboardFails=false,copied='';Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>{if(clipboardFails)throw Error('denied');copied=value}}}});
  const blobs=new Map(),downloads=[],originalURL=URL.createObjectURL;
  URL.createObjectURL=b=>{const u=originalURL(b);blobs.set(u,b);return u};
  const create=document.createElement;document.createElement=function(name){const el=create.call(this,name);if(name==='a')el.click=()=>downloads.push({name:el.download,blob:blobs.get(el.href)});return el};
  let intervals=new Map(),nextInterval=0;globalThis.setInterval=fn=>{intervals.set(++nextInterval,fn);return nextInterval};globalThis.clearInterval=id=>intervals.delete(id);
  const pending=new Set();let responseHold=null,held=null,networkError=null,requestCount=0;const requests=[];
  globalThis.fetch=(url,options)=>{requestCount++;requests.push({url:String(url),method:options?.method});const operation=(async()=>{if(networkError)throw networkError;const response=await nativeFetch(new URL(url,base),options);if(responseHold?.(String(url),options)){await new Promise(r=>held=r)}return response})();pending.add(operation);operation.finally(()=>pending.delete(operation)).catch(()=>{});return operation};
  const flush=async()=>{for(let i=0;i<5;i++){if(!held&&pending.size)await Promise.allSettled([...pending]);await new Promise(r=>setImmediate(r))}};
  const q=s=>{const el=document.querySelector(s);assert.ok(el,'missing '+s);return el};
  const click=async s=>{const el=q(s);assert.ok(!el.disabled,'disabled '+s);assert.equal(typeof el.onclick,'function','unbound '+s);el.onclick({preventDefault(){}});checks++;await flush()};
  const submit=async s=>{const f=q(s);assert.equal(typeof f.onsubmit,'function','unbound '+s);f.onsubmit({preventDefault(){},target:f});checks++;await flush()};
  const go=async route=>{location.hash='#'+route;listeners.hashchange();checks++;await flush();assert.equal(q('#nav a[aria-current="page"]').getAttribute('href'),'#'+route)};
  const field=(name,value)=>{q('[name="'+name+'"]').value=value};
  const tick=async n=>{for(let i=0;i<n;i++)for(const fn of [...intervals.values()])fn();await flush()};
  const api=async(url,method='GET',body,key='qa-admin')=>{const r=await nativeFetch(base+url,{method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,url+': '+r.status);return r.json()};
  await import('./dist/demo-app.mjs');await flush();
  // Every route uses the actual production imports; no page replacement stubs.
  for(const route of ['overview','runs','alerts','coding','usage','cost','policies','integrations','deploy']){
    await go(route);assert.ok(q('#app').textContent.trim());
    for(const b of document.querySelectorAll('#app button'))assert.ok(b.onclick||b.closest('form')||b.disabled,'unbound button: '+route+' '+b.outerHTML);
    for(const a of document.querySelectorAll('#app a[href]')){const href=a.getAttribute('href');assert.notEqual(href,'#');if(!href.startsWith('#')){const r=await nativeFetch(new URL(href,base));assert.equal(r.status,200,href)}}
  }
  // Native delayed close from the old editor cannot erase the next view.
  await go('integrations');await click('[data-integration-edit="DEEPSEEK"]');
  const oldClose=modal.onclose;closeDialog();openDialog('<h2>new dialog</h2>');oldClose();assert.match(modal.textContent,/new dialog/);closeDialog();
  // All seven editable providers/channels, every workflow export, draft retention.
  const beforeDraft=requestCount;
  for(const def of integrations){await click('[data-integration-edit="'+def.id+'"]');assert.ok(q('#integration-form'));for(const f of def.fields)assert.ok(q('[name="'+f.key+'"]'));q('[name="enabled"]').checked=false;await submit('#integration-form');await click('[data-integration-edit="'+def.id+'"]');assert.equal(q('[name="enabled"]').checked,false);await click('[data-env-export]');assert.match(q('#integration-editor-status').textContent,/停用状态/);await click('[data-editor-cancel]')}
  for(const platform of ['Dify','Coze','n8n']){await click('[data-workflow="'+platform+'"]');field('url',base);field('task','qa-'+platform.toLowerCase());await submit('#workflow-form');const result=JSON.parse(await downloads.at(-1).blob.text());assert.equal(result.platform,platform);assert.equal(result.steps.length,3);for(const step of result.steps)assert.ok(step.url.startsWith(base));await click('#modal .close')}
  assert.equal(requestCount,beforeDraft,'drafts must not send credentials');
  // Real encrypted saves + /models probes for every provider, then read-only UI.
  await click('[data-integrations-mode="server"]');field('key','qa-admin');await submit('#integration-login');
  for(const def of integrations.filter(d=>d.type==='provider')){await click('[data-integration-edit="'+def.id+'"]');for(const [k,v] of Object.entries({BASE_URL:'http://127.0.0.1:'+upstream.address().port+'/v1',API_KEY:'qa-upstream-key',MODEL:'qa-model',INPUT_CNY_PER_M:'0',OUTPUT_CNY_PER_M:'2'}))field(k,v);q('[name="enabled"]').checked=true;await submit('#integration-form');assert.match(q('#integration-message').textContent,/即时生效/);await click('[data-integration-edit="'+def.id+'"]');assert.equal(q('[name="API_KEY"]').value,'');assert.equal(q('[name="INPUT_CNY_PER_M"]').value,'0');await click('[data-integration-test]');assert.match(q('#integration-editor-status').textContent,/主模型/);await click('[data-editor-cancel]')}
  // Save response from a closed editor must not close the next editor.
  await click('[data-integration-edit="DEEPSEEK"]');field('MODEL','qa-model');responseHold=(url,o)=>url==='/api/integrations/DEEPSEEK'&&o.method==='PUT';
  const saving=q('#integration-form');saving.onsubmit({preventDefault(){},target:saving});while(!held)await new Promise(r=>setImmediate(r));
  await click('[data-editor-cancel]');await click('[data-integration-edit="QWEN"]');responseHold=null;held();held=null;await flush();assert.equal(modal.open,true);assert.match(modal.textContent,/通义千问/);await click('[data-editor-cancel]');
  await click('[data-integration-disconnect]');field('key','qa-read');await submit('#integration-login');await click('[data-integration-edit="DEEPSEEK"]');assert.ok(q('#integration-form [type="submit"]').disabled);assert.ok(q('[name="MODEL"]').disabled);await click('[data-editor-cancel]');
  // Actual coding API permissions and creation for both clients/modes.
  await go('coding');field('key','qa-read');await submit('#coding-login');assert.equal(document.querySelector('#coding-create-form'),null);assert.match(q('#coding-content').textContent,/只读连接/);
  await click('[data-coding-disconnect]');field('key','qa-admin');await submit('#coding-login');
  let managedId,monitorId,managedToken;
  for(const source of ['claude-code','codex']){field('name','QA '+source);field('source',source);field('mode',source==='codex'?'managed':'monitor');field('project','qa-project');field('fx','7');if(source==='codex'){field('model','qa-model');for(const k of ['input','output','cached','creation'])field(k,'1')}await submit('#coding-create-form');assert.ok(document.querySelector('#coding-secret'),q('#coding-message').textContent);const token=q('#coding-secret').value;assert.ok(token.length>20);if(source==='codex')managedToken=token;const list=(await api('/api/coding/connections')).connections;const id=list.find(c=>c.source===source).id;if(source==='codex')managedId=id;else monitorId=id;
    clipboardFails=source==='claude-code';await click('[data-secret-copy]');if(clipboardFails){assert.equal(q('#coding-secret').type,'text');assert.match(q('#copy-status').textContent,/已显示/)}else assert.equal(copied,token);await click('#modal .close');assert.equal(modal.innerHTML,'');
  }
  // Drive real managed approval decisions through telemetry, including double-submit.
  const envelope=attrs=>({resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:String(BigInt(Date.now())*1000000n),attributes:Object.entries(attrs).map(([key,value])=>({key,value:{stringValue:String(value)}}))}]}]}]});
  const unknownUsage=id=>envelope({'event.name':'codex.sse_event','event.kind':'response.completed','conversation.id':'qa-session','response.id':id,model:'unpriced-model',input_token_count:10,output_token_count:2,cached_token_count:0,cache_write_token_count:0});
  await api('/api/telemetry/'+managedId+'/v1/logs','POST',unknownUsage('unknown-1'),managedToken);await click('[data-coding-refresh]');field('extra','2');
  const approval=q('[data-coding-approve]'),taskId=approval.dataset.codingApprove,beforeApproval=requests.filter(r=>r.url.endsWith('/approve')).length;
  approval.onsubmit({preventDefault(){},target:approval});approval.onsubmit({preventDefault(){},target:approval});await flush();
  assert.equal(requests.filter(r=>r.url.endsWith('/approve')).length,beforeApproval+1,'double-submit must not send two approvals');
  assert.equal((await api('/api/coding/connections')).connections.find(c=>c.id===managedId).tasks.find(t=>t.id===taskId).budget,12);
  await api('/api/telemetry/'+managedId+'/v1/logs','POST',unknownUsage('unknown-2'),managedToken);await click('[data-coding-refresh]');await click('[data-coding-reject]');
  assert.equal((await api('/api/coding/connections')).connections.find(c=>c.id===managedId).tasks[0].status,'stopped');
  // Form errors, both confirm/cancel actions, and a late response isolation check.
  await click('[data-coding-setup="'+managedId+'"]');assert.match(modal.textContent,/guard-run/);await click('#modal .close');
  await click('[data-coding-action="stop"]');await click('#modal .close');await click('[data-coding-action="stop"]');await click('[data-confirm-action]');assert.match(q('#coding-content').textContent,/QA codex/);
  await click('[data-coding-select="'+monitorId+'"]');await click('[data-coding-import]');assert.match(q('#coding-message').textContent,/请选择/);
  q('#coding-file').files=[{size:2,text:async()=>'{bad'}];await click('[data-coding-import]');assert.ok(q('#coding-message').textContent.length);
  q('#coding-file').files=[{size:19,text:async()=>'{"resourceLogs":[]}'}];await click('[data-coding-import]');assert.match(q('#coding-message').textContent,/导入 0 条/);
  const imported={resourceLogs:[{scopeLogs:[{logRecords:Array.from({length:51},(_,i)=>envelope({'event.name':'tool_result','session.id':'qa-history',tool_use_id:'tool-'+i,tool_name:'Read',success:true}).resourceLogs[0].scopeLogs[0].logRecords[0])}]}]};
  q('#coding-file').files=[{size:30000,text:async()=>JSON.stringify(imported)}];await click('[data-coding-import]');assert.match(q('#coding-message').textContent,/导入 51 条/);
  await click('[data-coding-next]');assert.match(q('#coding-detail .usage-pagination').textContent,/51–51/);await click('[data-coding-prev]');
  await click('[data-coding-action="revoke"][data-id="'+monitorId+'"]');await click('[data-confirm-action]');assert.match(q('#coding-content').textContent,/凭证已撤销/);
  // A completed create must not lose its one-time token when the user navigates.
  field('name','QA delayed creation');field('fx','7');responseHold=(url,o)=>url==='/api/coding/connections'&&o.method==='POST';
  const createForm=q('#coding-create-form');createForm.onsubmit({preventDefault(){},target:createForm});while(!held)await new Promise(r=>setImmediate(r));
  await go('overview');responseHold=null;held();held=null;await flush();assert.equal(modal.open,false);await go('coding');await click('[data-new-setup]');assert.ok(q('#coding-secret').value.length>20);await click('#modal .close');assert.equal(document.querySelector('[data-new-setup]'),null);
  // Real usage ledger through production UI, all tabs, filters and exports.
  await api('/api/tasks','POST',{id:'qa-usage',policy:'research',customer:'QA',feature:'qa-feature'},'qa-ingest');
  for(let i=0;i<51;i++)await api('/api/tasks/qa-usage/events','POST',{id:'event-'+i,cost:.01,tool:'step',input:{i},provider:'DEEPSEEK',model:'qa-model',source:'test',input_tokens:100,output_tokens:10},'qa-ingest');
  await go('usage');await click('[data-mode="server"]');field('key','qa-read');await submit('#usage-login');assert.match(q('.side-status strong').textContent,/服务端/);await click('[data-days="0"]');
  for(const days of ['1','7','30','90','365','0'])await click('[data-days="'+days+'"]');
  await click('[data-tab="models"]');await click('[data-model-filter]');await click('[data-call]');assert.match(modal.textContent,/qa-model/);await click('#modal .close');await click('[data-next]');assert.match(q('.usage-pagination').textContent,/51–51/);await click('[data-prev]');
  await click('[data-csv]');const exported=await downloads.at(-1).blob.text();assert.match(exported,/qa-model/);assert.equal(exported.trim().split('\n').length,52);
  await click('[data-tab="overview"]');await click('.usage-trend [data-day]');assert.match(q('#usage-results').textContent,/qa-model/);
  await click('[data-reset]');field('from','2026-10-27');field('to','2026-10-01');await submit('#usage-filters');assert.match(q('#usage-message').textContent,/不能晚于/);await click('[data-reset]');
  field('customer','QA');field('feature','qa-feature');field('source','test');await submit('#usage-filters');assert.match(q('#usage-results').textContent,/QA/);await click('[data-refresh]');await click('[data-disconnect]');
  // Wrong credentials / network failure must not advertise a working connection.
  field('key','wrong');await submit('#usage-login');assert.match(q('.environment').textContent,/连接失败/);assert.ok(q('[data-retry-login]'));await click('[data-retry-login]');
  networkError=new TypeError('network unavailable');field('key','qa-read');await submit('#usage-login');assert.match(q('#usage-message').textContent,/无法连接服务/);networkError=null;
  // All five simulation scenarios, controls, policies, deploy checklist and export.
  for(const scenario of ['loop','retry','swarm','budget','normal']){await go('overview');await click('header [data-demo]');field('scenario',scenario);field('policy','support');await submit('#demo-form');await tick(6);assert.ok(JSON.parse(storage.get('ag-v1')).tasks[0].status!=='running')}
  await go('policies');for(const policy of ['support','research','content'])await submit('[data-policy="'+policy+'"]');
  await go('runs'); q('#search').value='nothing';q('#search').oninput();assert.match(q('#rows').textContent,/没有匹配/);q('#search').value='';q('#search').oninput();await click('[data-detail]');await go('integrations');assert.equal(modal.open,false,'route change closes stale task dialog');
  await go('deploy');for(const b of document.querySelectorAll('[data-check]')){b.checked=true;b.onchange()}await go('cost');await click('[data-export]');assert.equal(downloads.at(-1).name,'agentguard-runs.json');await go('deploy');for(const b of document.querySelectorAll('[data-check]'))assert.ok(b.checked);
  // Check every direct local asset and module import returned by the actual server.
  for(const filename of fs.readdirSync('dist').filter(x=>/\.(html|mjs|css|md|gz)$/.test(x))){const r=await nativeFetch(base+'/'+filename);assert.equal(r.status,200,filename);if(filename.endsWith('.html'))assert.match(await r.text(),/charset=["']?UTF-8/i)}
  const timeoutFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new DOMException('timed out','TimeoutError')};await assert.rejects(jsonRequest('/unused',{},'unavailable'),/请求超时/);globalThis.fetch=timeoutFetch;
  assert.ok(!JSON.stringify([...storage]).includes('qa-admin'));assert.ok(!JSON.stringify([...storage]).includes('qa-upstream-key'));
  console.log('PASS: '+checks+' full-app DOM actions; explicit demo routes + real service modules, real HTTP/SQLite, 5 providers, 7 draft editors, 3 workflow exports, 2 coding clients, read-only access, pagination/CSV, delayed dialog/save, errors, all local assets. External providers mocked; browser layout not covered.');
} finally {
  globalThis.setInterval=nativeInterval;globalThis.fetch=nativeFetch;
  server.kill();if(server.exitCode===null)await new Promise(r=>server.once('exit',r));
  await new Promise(r=>upstream.close(r));fs.rmSync(dir,{recursive:true,force:true});
}
