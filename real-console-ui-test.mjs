// Focused regression tests for the real console. The production module graph runs
// against deliberately controlled API responses so logout/navigation races and
// transport failures are reproducible. HTTP persistence is covered separately by
// local-acceptance-test.mjs; LinkeDOM does not establish browser/layout support.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {parseHTML} from 'linkedom';
import {presets, task, metrics} from './dist/engine.mjs';
import {integrations} from './dist/integration-core.mjs';
import {demoQuery} from './dist/usage-core.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject}};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r))};

function setupDOM(){
  const {document}=parseHTML(fs.readFileSync('dist/index.html','utf8'));
  globalThis.document=document;
  const listeners=new Map();
  globalThis.window={addEventListener:(name,fn)=>listeners.set(name,fn)};
  globalThis.location={hash:'#overview',origin:'http://127.0.0.1:18957'};
  const selectProto=Object.getPrototypeOf(document.createElement('select'));
  Object.defineProperty(selectProto,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??''},set(v){for(const o of this.querySelectorAll('option'))o.value===v?o.setAttribute('selected',''):o.removeAttribute('selected')}});
  const inputProto=Object.getPrototypeOf(document.createElement('input'));
  Object.defineProperty(inputProto,'checked',{configurable:true,get(){return this.hasAttribute('checked')},set(v){v?this.setAttribute('checked',''):this.removeAttribute('checked')}});
  globalThis.FormData=class{constructor(form){this.form=form}get(name){const el=this.form.querySelector('[name="'+name+'"]');return el?.disabled?null:el?.type==='checkbox'?(el.checked?el.value||'on':null):el?.value??null}};
  const storage=new Map();
  globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)};
  const modal=document.querySelector('#modal');
  modal.showModal=()=>modal.open=true;
  modal.close=()=>{modal.open=false;setImmediate(()=>modal.onclose?.())};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{}}}});
  const intervals=new Map();let nextInterval=0;
  globalThis.setInterval=fn=>{intervals.set(++nextInterval,fn);return nextInterval};
  globalThis.clearInterval=id=>intervals.delete(id);
  return {document,listeners,storage,modal,intervals};
}

function mockService(){
  const requests=[];
  const tasks=[task('live-task','research',{name:'API fixture task',customer:'Fixture customer',feature:'Fixture feature',cost:1.25,status:'running',created_at:'2026-10-27T10:00:00.000Z'})];
  const policies=Object.entries(presets).map(([id,p])=>({id,...structuredClone(p),revision:0}));
  const usage=()=>({...demoQuery([],new URLSearchParams()),snapshot:0});
  const enrich=t=>({...t,budget:policies.find(p=>p.id===t.policy).budget,policyName:presets[t.policy].name});
  let override=null;
  const fetch=async(url,options={})=>{
    const u=new URL(url,location.origin),method=options.method||'GET';
    const headers=new Headers(options.headers),key=(headers.get('authorization')||'').replace(/^Bearer /,'');
    const req={url:u.pathname+u.search,path:u.pathname,method,key,body:options.body?JSON.parse(options.body):undefined};
    requests.push(req);
    if(override){const response=await override(req);if(response!==undefined)return response}
    const canManage=key==='qa-admin';
    if(!canManage&&key!=='qa-read')return json({error:'需要 READ_KEY 或 ADMIN_KEY'},401);
    if(u.pathname==='/api/session')return json({role:canManage?'admin':'read',canManage,storageReady:true});
    if(u.pathname==='/api/tasks')return json({tasks:tasks.map(enrich),metrics:metrics(tasks),total:tasks.length,offset:0,limit:500,canManage});
    if(u.pathname==='/api/overview')return json({metrics:metrics(tasks),counts:{total:tasks.length,running:1,success:0,stopped:0,approval:0,failed:0},riskCount:0,latestTasks:tasks.map(enrich),latestAlerts:[],usage:usage().summary,canManage});
    if(u.pathname==='/api/alerts')return json({alerts:[],total:0,offset:0,limit:500,canManage});
    if(u.pathname==='/api/costs')return json({summary:metrics(tasks),usage:usage().summary,groups:[{customer:tasks[0].customer,feature:tasks[0].feature,tasks:1,unknown_cost:0,...metrics(tasks)}],models:[],canManage});
    if(u.pathname==='/api/policies')return json({policies:structuredClone(policies),audit:[],canManage});
    if(u.pathname==='/api/coding/connections')return json({connections:[],canManage});
    if(u.pathname==='/api/coding/events')return json({rows:[],total:0});
    if(u.pathname==='/api/usage')return json(usage());
    if(u.pathname==='/api/integrations')return json({canSave:canManage,canManage,integrations:integrations.map(d=>({id:d.id,name:d.name,type:d.type,values:{},hasSecret:{},enabled:false,origin:'environment',revision:0,verification:null}))});
    const detail=u.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if(detail&&method==='GET')return json({task:enrich(tasks.find(t=>t.id===detail[1])),audit:[]});
    throw Error('Unexpected API request '+method+' '+u.pathname);
  };
  return {requests,tasks,policies,fetch,override:fn=>override=fn};
}

test('real console authentication, lifecycle and failure regressions',async t=>{
  const nativeFetch=globalThis.fetch,nativeInterval=globalThis.setInterval,nativeClearInterval=globalThis.clearInterval;
  const {document,listeners,storage,modal}=setupDOM(),service=mockService();
  // Previous releases kept simulated records under this key. They must not be
  // mistaken for service records after upgrading to the real console.
  storage.set('ag-v1',JSON.stringify({tasks:[{id:'OLD-DEMO',name:'Stale simulated customer',cost:9999}],policies:presets}));
  globalThis.fetch=service.fetch;
  const q=selector=>{const el=document.querySelector(selector);assert.ok(el,'missing '+selector);return el};
  const field=(name,value,root=document)=>{const el=root.querySelector('[name="'+name+'"]');assert.ok(el,'missing field '+name);el.value=value};
  const click=async selector=>{const el=q(selector);assert.ok(!el.disabled,'disabled '+selector);el.dispatchEvent(new document.defaultView.Event('click',{bubbles:true,cancelable:true}));await flush()};
  const submit=async selector=>{const form=q(selector);assert.equal(typeof form.onsubmit,'function','unbound '+selector);form.onsubmit({preventDefault(){},target:form});await flush()};
  const go=async route=>{location.hash='#'+route;listeners.get('hashchange')();await flush();assert.equal(q('#nav a[aria-current="page"]').getAttribute('href'),'#'+route)};
  const login=async key=>{field('key',key);await submit('#console-login')};
  const expectNoDemo=()=>assert.doesNotMatch(q('#app').textContent,/OLD-DEMO|Stale simulated customer|市场趋势研究|售后问题处理|深度竞品分析/);
  try{
    await import('./dist/app.mjs');await flush();
    await t.test('failed authentication never unlocks pages or displays browser demo records',async()=>{
      assert.ok(q('#console-login'));
      assert.equal(service.requests.length,0,'an unauthenticated route must not request protected records');
      expectNoDemo();
      await login('invalid-key');
      assert.ok(q('#console-login'));
      assert.match(q('#app').textContent,/READ_KEY|ADMIN_KEY|密钥/);
      assert.equal(service.requests.filter(r=>r.path!=='/api/session').length,0);
      expectNoDemo();
    });
    await t.test('one in-memory login is shared by all nine routes',async()=>{
      await login('qa-admin');
      assert.equal(document.querySelector('#console-login'),null);
      assert.match(q('#app').textContent,/API fixture task/);
      const count=service.requests.filter(r=>r.path==='/api/session').length;
      for(const route of ['runs','alerts','coding','usage','cost','policies','integrations','deploy','overview']){
        await go(route);
        assert.equal(document.querySelector('#console-login,#coding-login,#usage-login,#integration-login'),null,'extra login on '+route);
        expectNoDemo();
      }
      assert.equal(service.requests.filter(r=>r.path==='/api/session').length,count);
      assert.ok(service.requests.filter(r=>r.path!=='/api/session').every(r=>r.key==='qa-admin'));
      assert.ok(![...storage.values()].some(v=>/qa-admin|invalid-key/.test(v)),'credentials must never reach localStorage');
    });
    await t.test('an old coding connection secret cannot cross a logout and same-key login',async()=>{
      await go('coding');const held=deferred();let captured=false;
      service.override(req=>{if(req.path==='/api/coding/connections'&&req.method==='POST'){captured=true;return held.promise}});
      field('name','Old session connection');await submit('#coding-create-form');assert.ok(captured);
      await click('[data-console-logout]');await login('qa-admin');
      held.resolve(json({id:'old-session-connection',name:'Old session connection',source:'codex',mode:'managed',token:'MUST-NOT-CROSS-AUTH-SESSION',project:'fixture',enabled:true,received:0,tasks:[]}));
      await flush();service.override(null);
      assert.ok(q('#coding-create-form'));
      assert.doesNotMatch(q('#app').textContent,/Old session connection|MUST-NOT-CROSS-AUTH-SESSION/);
      assert.doesNotMatch(modal.textContent,/Old session connection|MUST-NOT-CROSS-AUTH-SESSION/);
      assert.ok(!modal.open);
      assert.ok(!q('#coding-create-form [type="submit"]').disabled);
      await go('overview');
    });
    await t.test('task controls respect monitoring, managed process ownership and historical records',async()=>{
      await go('runs');const fixture=service.tasks[0];
      fixture.control='monitor';
      for(const status of ['running','approval']){
        fixture.status=status;
        await click('[data-task-detail="live-task"]');
        assert.match(modal.textContent,/只监测/);
        assert.equal(modal.querySelector('[data-task-stop],[data-task-finish],#task-approval-form,[data-task-reject]'),null);
        await click('#modal .close');
      }
      fixture.status='running';fixture.control='managed';
      await click('[data-task-detail="live-task"]');
      assert.ok(q('#modal [data-task-stop="live-task"]'));
      assert.equal(modal.querySelector('[data-task-finish]'),null,'managed process completion comes from the launcher');
      assert.match(modal.textContent,/本机启动器/);
      await click('#modal .close');
      delete fixture.control;
      await click('[data-task-detail="live-task"]');
      assert.ok(q('#modal [data-task-stop="live-task"]'));
      assert.equal(modal.querySelectorAll('[data-task-finish]').length,2);
      await click('#modal .close');
      fixture.historical=true;
      for(const status of ['running','approval']){
        fixture.status=status;await click('[data-task-detail="live-task"]');
        assert.equal(modal.querySelector('[data-task-stop],[data-task-finish],#task-approval-form,[data-task-reject]'),null);
        assert.match(modal.textContent,/历史/);
        await click('#modal .close');
      }
      delete fixture.historical;fixture.status='running';await go('overview');
    });
    await t.test('unknown token totals and undefined success rates remain visibly unknown',async()=>{
      const summary=metrics(service.tasks),model={provider:'DEEPSEEK',requests:1,tasks:1,success:0,completed:0,rate:0,unit:null,cost:1.25,unpriced_requests:0};
      service.override(req=>req.path==='/api/costs'?json({summary,groups:[{customer:'Fixture customer',feature:'Fixture feature',tasks:1,unknown_cost:0,...summary}],models:[{...model,model:'unknown-usage',input_tokens:null,output_tokens:null},{...model,model:'actual-zero',input_tokens:0,output_tokens:0}]}):undefined);
      await go('cost');
      assert.equal(q('.stats .stat:nth-child(2) .value').textContent,'—');
      const groups=q('#cost-groups tr').querySelectorAll('td');
      assert.equal(groups[4].textContent,'—');assert.equal(groups[5].textContent,'—');
      const rows=[...document.querySelectorAll('#cost-models tr')];
      assert.equal(rows[0].querySelectorAll('td')[2].textContent,'— / —');
      assert.equal(rows[1].querySelectorAll('td')[2].textContent,'0 / 0');
      for(const row of rows){assert.equal(row.querySelectorAll('td')[4].textContent,'—');assert.equal(row.querySelectorAll('td')[5].textContent,'—')}
      service.override(null);await go('overview');
    });
    await t.test('an older page response cannot overwrite a later route',async()=>{
      const held=deferred();let captured=false;
      service.override(req=>{if(req.path==='/api/overview'){captured=true;return held.promise}});
      await click('[data-console-refresh]');assert.ok(captured);
      await go('cost');
      held.resolve(json({metrics:metrics(service.tasks),counts:{total:1,running:1},riskCount:0,latestTasks:[{...service.tasks[0],name:'DELAYED PRIVATE TASK',budget:10}],latestAlerts:[],usage:demoQuery([],new URLSearchParams()).summary,canManage:true}));
      await flush();service.override(null);
      assert.ok(q('#cost-groups'));
      assert.doesNotMatch(q('#app').textContent,/DELAYED PRIVATE TASK/);
      assert.equal(q('#nav a[aria-current="page"]').getAttribute('href'),'#cost');
    });
    await t.test('late API failures are scoped to the page that started them',async()=>{
      await go('overview');const held=deferred();
      service.override(req=>req.path==='/api/overview'?held.promise:undefined);
      await click('[data-console-refresh]');await go('policies');
      held.reject(new TypeError('old request failed'));await flush();service.override(null);
      assert.ok(q('[data-policy="support"]'));
      assert.doesNotMatch(q('#console-message').textContent,/无法连接|old request/);
    });
    await t.test('a policy version conflict retains edits and requires a fresh server version',async()=>{
      const form=q('[data-policy="support"]');field('budget','3.5',form);
      service.override(req=>req.path==='/api/policies/support'&&req.method==='PUT'?json({error:'策略已更新，请刷新后重试'},409):undefined);
      await submit('[data-policy="support"]');
      assert.equal(q('[data-policy="support"] [name="budget"]').value,'3.5');
      assert.match(q('#app').textContent,/策略已更新|刷新后重试/);
      const request=service.requests.findLast(r=>r.path==='/api/policies/support');
      assert.equal(request.body.revision,0);assert.equal(request.body.budget,3.5);
      assert.ok(!q('[data-policy="support"] [type="submit"]').disabled,'failed save must allow recovery');
      service.override(null);await click('[data-console-refresh]');
      assert.equal(Number(q('[data-policy="support"] [name="budget"]').value),presets.support.budget);
    });
    await t.test('a static/non-JSON host reports unavailable API without silently switching to demo',async()=>{
      await go('overview');
      service.override(req=>req.path==='/api/overview'?new Response('<!doctype html><h1>static preview</h1>',{headers:{'content-type':'text/html'}}):undefined);
      await click('[data-console-refresh]');
      assert.match(q('#console-message').textContent,/服务|API|本机|部署/);
      expectNoDemo();
      assert.equal(document.querySelector('[data-demo]'),null,'main console must not implicitly enter simulation');
      service.override(null);await click('[data-console-refresh]');
      assert.match(q('#app').textContent,/API fixture task/);
    });
    await t.test('logout invalidates an in-flight response and clears module credentials',async()=>{
      const held=deferred();
      service.override(req=>req.path==='/api/overview'?held.promise:undefined);
      await click('[data-console-refresh]');await click('[data-console-logout]');
      held.resolve(json({metrics:metrics(service.tasks),counts:{total:1,running:1},riskCount:0,latestTasks:[{...service.tasks[0],name:'PRIVATE AFTER LOGOUT',budget:10}],latestAlerts:[],usage:demoQuery([],new URLSearchParams()).summary,canManage:true}));
      await flush();service.override(null);
      assert.ok(q('#console-login'));assert.doesNotMatch(q('#app').textContent,/PRIVATE AFTER LOGOUT|API fixture task/);
      assert.ok(!modal.open);
      const count=service.requests.length;
      for(const route of ['coding','usage','integrations','runs','alerts','cost','policies','overview']){
        await go(route);assert.ok(q('#console-login'));assert.doesNotMatch(q('#app').textContent,/Fixture customer|API fixture task/);
      }
      assert.equal(service.requests.length,count,'a disconnected module retained a credential');
    });
    await t.test('a subsequent read-only login removes every mutation control',async()=>{
      await login('qa-read');
      const before=service.requests.length;
      for(const route of ['runs','alerts']){
        await go(route);
        assert.equal(document.querySelector('[data-task-stop]:not([disabled]),[data-task-review]:not([disabled])'),null);
      }
      await go('runs');await click('[data-task-detail="live-task"]');
      assert.equal(modal.querySelector('[data-task-stop],[data-task-finish],#task-approval-form,[data-task-reject]'),null);
      await click('#modal .close');
      await go('policies');
      for(const form of document.querySelectorAll('[data-policy]')){
        for(const el of form.querySelectorAll('input,select,button[type="submit"]'))assert.ok(el.disabled,'read-only field remains editable: '+el.outerHTML);
      }
      await go('coding');assert.equal(document.querySelector('#coding-create-form,[data-coding-action],[data-coding-approve],[data-coding-import]'),null);
      await go('integrations');await click('[data-integration-edit="DEEPSEEK"]');
      assert.ok(q('#integration-form [type="submit"]').disabled);
      await click('#modal .close');
      await go('usage');
      const recent=service.requests.slice(before);
      assert.ok(recent.every(r=>r.key==='qa-read'&&r.method==='GET'),'read-only navigation reused admin state or attempted a write');
      assert.ok(![...storage.values()].some(v=>/qa-admin|qa-read|invalid-key/.test(v)));
    });
    await t.test('disconnecting a shared subpage clears the console-wide session',async()=>{
      await go('coding');await click('[data-coding-disconnect]');
      assert.ok(q('#console-login'));
      const count=service.requests.length;
      await go('usage');assert.ok(q('#console-login'));
      await go('integrations');assert.ok(q('#console-login'));
      assert.equal(service.requests.length,count);
    });
  }finally{
    service.override(null);
    globalThis.fetch=nativeFetch;
    globalThis.setInterval=nativeInterval;
    globalThis.clearInterval=nativeClearInterval;
  }
});
