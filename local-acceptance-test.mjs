// Independent local acceptance: production page modules, real HTTP and SQLite.
// LinkeDOM supplies DOM APIs only. This does NOT prove browser layout, native
// form validation, actual model providers, or installed Claude/Codex behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {parseHTML} from 'linkedom';

const root=process.cwd(),dir=fs.mkdtempSync(path.resolve('.tmp-local-acceptance-'));
const base='http://127.0.0.1:18961',nativeFetch=globalThis.fetch;
const testEnv={...process.env};
for(const name of Object.keys(testEnv))if(/^(DEEPSEEK|QWEN|KIMI|DOUBAO|MINIMAX|FEISHU|WECOM|DIFY|COZE|N8N)_/.test(name))delete testEnv[name];
let server,stderr='',checks=0;
const start=async()=>{
  stderr='';server=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:dir,env:{...testEnv,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'18961',ADMIN_KEY:'local-qa-admin',INGEST_KEY:'local-qa-ingest',READ_KEY:'local-qa-read',CONFIG_ENCRYPTION_KEY:'d'.repeat(64)},stdio:['ignore','pipe','pipe']});
  server.stderr.on('data',chunk=>stderr+=chunk);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(stderr||'server startup timeout')),5000);server.stdout.once('data',()=>{clearTimeout(timer);resolve()});server.once('exit',code=>{clearTimeout(timer);reject(Error('server exited '+code+' '+stderr))})});
};
const stop=async()=>{if(server&&server.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve))}server=null};
const request=async(route,{method='GET',body,key='local-qa-admin',status=200}={})=>{
  const response=await nativeFetch(base+route,{method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();assert.equal(response.status,status,route+': '+JSON.stringify(data));return data;
};
try {
  await start();
  const pageResponse=await nativeFetch(base+'/');assert.equal(pageResponse.status,200);assert.match(pageResponse.headers.get('content-type'),/text\/html; charset=utf-8/);
  const {document}=parseHTML(await pageResponse.text());
  globalThis.document=document;globalThis.window={};globalThis.location={hash:'#overview',origin:base};
  const listeners=new Map();window.addEventListener=(name,callback)=>{const entries=listeners.get(name)||[];entries.push(callback);listeners.set(name,entries)};
  window.removeEventListener=(name,callback)=>listeners.set(name,(listeners.get(name)||[]).filter(fn=>fn!==callback));
  Object.defineProperty(Object.getPrototypeOf(document.createElement('input')),'checked',{configurable:true,get(){return this.hasAttribute('checked')},set(value){value?this.setAttribute('checked',''):this.removeAttribute('checked')}});
  Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??''},set(value){for(const option of this.querySelectorAll('option'))option.value===value?option.setAttribute('selected',''):option.removeAttribute('selected')}});
  globalThis.FormData=class{constructor(form){this.form=form}get(name){const field=this.form.querySelector('[name="'+name+'"]');return field?.disabled?null:field?.type==='checkbox'?(field.checked?field.value||'on':null):field?.value??null}};
  const storage=new Map([['ag-v1','{"tasks":[{"id":"OLD-DEMO","customer":"旧演示客户","cost":9999}],"policies":{}}']]);
  globalThis.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
  const dialog=document.querySelector('#modal');dialog.showModal=()=>dialog.open=true;dialog.close=()=>{dialog.open=false;setImmediate(()=>dialog.onclose?.())};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{}}}});
  const downloads=[],blobs=new Map(),createURL=URL.createObjectURL;URL.createObjectURL=blob=>{const url=createURL(blob);blobs.set(url,blob);return url};
  const create=document.createElement;document.createElement=function(name){const el=create.call(this,name);if(name==='a')el.click=()=>downloads.push({name:el.download,blob:blobs.get(el.href)});return el};
  const pending=new Set(),requests=[];let offline=false;
  globalThis.fetch=(url,options={})=>{
    const entry={url:String(url),method:options.method||'GET',authorization:options.headers?.authorization};requests.push(entry);
    const promise=offline?Promise.reject(new TypeError('simulated local network failure')):nativeFetch(new URL(url,base),options);
    promise.then(response=>entry.status=response.status,()=>{});
    pending.add(promise);promise.finally(()=>pending.delete(promise)).catch(()=>{});return promise;
  };
  const flush=async()=>{for(let i=0;i<8;i++){if(pending.size)await Promise.allSettled([...pending]);await new Promise(resolve=>setImmediate(resolve))}};
  const q=selector=>{const el=document.querySelector(selector);assert.ok(el,'Missing '+selector+'; page: '+document.querySelector('#app')?.textContent.slice(0,500));return el};
  const click=async selector=>{const el=q(selector);assert.ok(!el.disabled,'Disabled '+selector);el.dispatchEvent(new document.defaultView.Event('click',{bubbles:true,cancelable:true}));checks++;await flush()};
  const submit=async selector=>{const form=q(selector);assert.equal(typeof form.onsubmit,'function','Unbound '+selector);form.onsubmit({preventDefault(){},target:form});checks++;await flush()};
  const change=async(selector,value)=>{const el=q(selector);el.value=value;el.dispatchEvent(new document.defaultView.Event('change',{bubbles:true,cancelable:true}));checks++;await flush()};
  const go=async route=>{location.hash='#'+route;for(const fn of listeners.get('hashchange')||[])fn();checks++;await flush();assert.equal(q('#nav a[aria-current="page"]').getAttribute('href'),'#'+route)};
  const field=(name,value,scope=document)=>{const input=scope.querySelector('[name="'+name+'"]');assert.ok(input,name);input.value=value};
  const createTask=(id,policy='research',extra={})=>request('/api/tasks',{method:'POST',body:{id,name:'真实任务 '+id,policy,customer:'本机验收客户',feature:'费用控制',...extra},key:'local-qa-ingest',status:201});
  const event=(id,eventId,cost,extra={})=>request('/api/tasks/'+id+'/events',{method:'POST',body:{id:eventId,cost,tool:'lookup',input:{query:eventId},provider:'DEEPSEEK',model:'qa-model',input_tokens:100,output_tokens:20,...extra},key:'local-qa-ingest'});

  await import('./dist/app.mjs');await flush();
  assert.ok(q('#console-login'));
  assert.doesNotMatch(q('#app').textContent,/OLD-DEMO|旧演示客户|9999/,'old local demo data must never populate the real console');
  field('key','local-qa-admin');await submit('#console-login');
  assert.equal(document.querySelector('#console-login'),null);
  assert.equal((await request('/api/session')).canManage,true);
  assert.equal((await request('/api/tasks')).tasks.length,0,'fresh local DB must start empty');

  // One session is accepted across all real-service modules without re-entering
  // keys. Empty data is allowed; demo datasets are not injected.
  for(const route of ['overview','runs','alerts','cost','policies','coding','usage','integrations']){
    await go(route);assert.ok(q('#app').textContent.trim());
    assert.equal(document.querySelector('#console-login'),null,route+' unexpectedly lost session');
    assert.equal(document.querySelector('#coding-login,#usage-login,#integration-login'),null,route+' must share authentication');
    assert.doesNotMatch(q('#app').textContent,/OLD-DEMO|旧演示客户/);
  }
  assert.ok(requests.some(r=>r.url.startsWith('/api/usage')),'usage page must query the real ledger by default');
  assert.ok(requests.some(r=>r.url==='/api/integrations'),'integration center must use real configuration by default');

  // Policy edits survive reload and affect new tasks, never retroactively mutate
  // an existing task's budget or thresholds.
  await go('runs');await click('[data-task-create]');
  const taskForm=q('#task-create-form');
  for(const [name,value] of Object.entries({id:'before-policy',name:'表单创建的真实任务',customer:'本机验收客户',feature:'费用控制',policy:'support'}))field(name,value,taskForm);
  await submit('#task-create-form');
  const old=(await request('/api/tasks/before-policy')).task;assert.equal(old.name,'表单创建的真实任务');
  field('q','before-policy',q('#task-filters'));await submit('#task-filters');
  assert.match(q('#real-task-rows').textContent,/before-policy/);await click('[data-task-reset]');
  await go('policies');const form=q('[data-policy="support"]');
  for(const [name,value] of Object.entries({budget:'0.05',loop:'2',retries:'1',children:'1',action:'approve'}))field(name,value,form);
  await submit('[data-policy="support"]');
  let policies=await request('/api/policies');const saved=policies.policies.find(p=>p.id==='support');
  assert.equal(saved.budget,.05);assert.equal(saved.action,'approve');assert.ok(saved.revision>0);
  const fresh=await createTask('after-policy','support');
  assert.equal((await request('/api/tasks/before-policy')).task.budget,old.budget??2);
  assert.equal((await request('/api/tasks/after-policy')).task.budget,.05);
  await event('after-policy','budget-trigger',.06);
  assert.equal((await request('/api/tasks/after-policy')).task.status,'approval');

  // Detection must flow through the HTTP ingest path into persisted alerts.
  // Different event IDs distinguish repeated work from transport deduplication.
  for(const kind of ['loop','retry','swarm']){
    await createTask('detect-'+kind,'support',{feature:'异常检测'});
    if(kind==='loop'){
      await event('detect-loop','loop-1',0,{input:{query:'same work'}});
      await event('detect-loop','loop-2',0,{input:{query:'same work'}});
    }else if(kind==='retry')await event('detect-retry','retry-1',0,{error:true});
    else{
      await event('detect-swarm','swarm-1',0,{childId:'child-1'});
      await event('detect-swarm','swarm-2',0,{childId:'child-2'});
    }
    const detected=await request('/api/tasks/detect-'+kind);
    assert.equal(detected.task.status,'approval');assert.ok(detected.task.alerts.some(alert=>alert.type===kind));
  }
  const liveAlerts=(await request('/api/alerts')).alerts;
  for(const kind of ['budget','loop','retry','swarm'])assert.ok(liveAlerts.some(alert=>alert.type===kind));

  // Real approvals through the UI change the durable task and append its audit.
  await go('alerts');assert.match(q('#app').textContent,/after-policy/);
  await click('[data-task-review="after-policy"]');field('extraBudget','1');await submit('#task-approval-form');
  const approved=await request('/api/tasks/after-policy');assert.equal(approved.task.status,'running');assert.ok(approved.task.budget>=1.06);
  assert.ok(approved.audit.some(entry=>entry.action==='approve'&&entry.actor==='admin'));
  await click('[data-task-review="detect-loop"]');await click('[data-task-reject]');
  const rejected=await request('/api/tasks/detect-loop');assert.equal(rejected.task.status,'stopped');assert.ok(rejected.audit.some(entry=>entry.action==='reject'));
  await change('#alert-status','approval');assert.equal(document.querySelector('[data-task-detail="detect-loop"]'),null);
  await change('#alert-status','');assert.ok(q('[data-task-detail="detect-loop"]'));
  await go('runs');await click('[data-task-detail="after-policy"]');assert.match(dialog.textContent,/budget-trigger/);await click('#modal .close');
  await click('[data-task-detail="after-policy"]');
  await click('[data-task-stop="after-policy"]');
  // The UI may intentionally require confirmation before the stop POST.
  const confirm=document.querySelector('#task-confirm');if(confirm)await click('#task-confirm');
  assert.equal((await request('/api/tasks/after-policy')).task.status,'stopped');
  assert.equal((await request('/api/tasks/after-policy/decision',{key:'local-qa-ingest'})).decision,'stop');

  // Success cost includes failed work and is backed by real task/ledger data.
  await createTask('successful','research',{feature:'结果核算'});await event('successful','success-call',.2);
  await createTask('failed','research',{feature:'结果核算'});await event('failed','failed-call',.4,{error:true});
  await go('runs');
  for(const [id,status] of [['successful','success'],['failed','failed']]){
    await click('[data-task-detail="'+id+'"]');await click('[data-task-finish="'+status+'"]');await click('#task-confirm');
    const ended=await request('/api/tasks/'+id);assert.equal(ended.task.status,status);assert.ok(ended.audit.some(entry=>entry.action==='finish'));
  }
  const costs=await request('/api/costs'),group=costs.groups.find(g=>g.customer==='本机验收客户'&&g.feature==='结果核算');
  assert.ok(group);assert.ok(Math.abs(group.cost-.6)<1e-10);assert.equal(group.success,1);assert.equal(group.completed,2);assert.equal(group.rate,.5);assert.ok(Math.abs(group.unit-.6)<1e-10);
  assert.ok(costs.models.some(m=>m.provider==='DEEPSEEK'&&m.model==='qa-model'));
  await go('cost');assert.match(q('#cost-groups').textContent,/本机验收客户/);assert.match(q('#cost-models').textContent,/qa-model/);
  await click('[data-cost-export]');const exported=JSON.parse(await downloads.at(-1).blob.text());assert.equal(exported.source,'server');assert.ok(exported.groups.some(g=>g.feature==='结果核算'&&Math.abs(g.unit-.6)<1e-10));
  await go('overview');assert.match(q('#app').textContent,/真实任务|successful|after-policy/);

  // A failed backend request renders an explicit error and cannot substitute
  // legacy demo data. A later refresh recovers the actual records.
  offline=true;await click('[data-console-refresh]');assert.match(q('#console-message').textContent,/无法|失败|网络|连接/);assert.doesNotMatch(q('#app').textContent,/OLD-DEMO|旧演示客户/);offline=false;await click('[data-console-refresh]');

  // Restart the actual local process using the same temporary SQLite volume.
  await stop();await start();await click('[data-console-refresh]');
  policies=await request('/api/policies');assert.equal(policies.policies.find(p=>p.id==='support').revision,saved.revision);
  const restarted=await request('/api/tasks/after-policy');assert.equal(restarted.task.status,'stopped');assert.ok(restarted.audit.some(entry=>entry.action==='approve'));
  assert.ok(Math.abs((await request('/api/costs')).groups.find(g=>g.feature==='结果核算').unit-.6)<1e-10);

  // Read-only session sees the same real state but cannot mutate it, even by
  // manually sending the corresponding HTTP request.
  await click('[data-console-logout]');field('key','local-qa-read');await submit('#console-login');
  await go('policies');const readForm=q('[data-policy="support"]');assert.ok(readForm.querySelector('[type="submit"]').disabled);assert.ok(readForm.querySelector('[name="budget"]').disabled);
  await request('/api/policies/support',{method:'PUT',key:'local-qa-read',body:{...saved,budget:999},status:403});
  await request('/api/tasks/before-policy/stop',{method:'POST',key:'local-qa-read',body:{},status:403});
  await go('runs');await click('[data-task-detail="before-policy"]');assert.equal(document.querySelector('[data-task-stop]:not([disabled]),[data-task-review]:not([disabled]),[data-task-finish]:not([disabled])'),null);await click('#modal .close');
  await go('coding');assert.equal(document.querySelector('#coding-create-form'),null);
  await go('integrations');await click('[data-integration-edit="DEEPSEEK"]');assert.ok(q('#integration-form [type="submit"]').disabled);await click('#modal .close');
  await go('overview');await click('[data-console-logout]');
  for(const route of ['overview','runs','alerts','cost','policies']){await go(route);assert.ok(q('#console-login'));assert.doesNotMatch(q('#app').textContent,/本机验收客户|successful/,'logout must clear real records')}
  assert.ok(!JSON.stringify([...storage]).includes('local-qa-admin'));
  assert.ok(!JSON.stringify([...storage]).includes('local-qa-read'));
  assert.deepEqual(requests.filter(item=>item.status>=400).map(({url,method,status})=>({url,method,status})),[],'normal UI actions must not hide failed HTTP responses');
  console.log(`PASS: ${checks} local acceptance DOM actions; all five real console pages, shared authentication, policy enforcement, approval audit, cost groups, SQLite restart, read-only permissions and no demo fallback. Browser and real clients remain separate acceptance gates.`);
} finally {
  globalThis.fetch=nativeFetch;
  await stop();fs.rmSync(dir,{recursive:true,force:true});
}
