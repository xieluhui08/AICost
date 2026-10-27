// Production UI modules exercised via DOM; no claim of browser/layout coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {demoQuery} from './dist/usage-core.mjs';

test('managed revoke, canceled file read, create rerender lock, pending auth, snapshot CSV and Docker export',async()=>{
 const {document}=parseHTML('<html><body><span class="environment"></span><section id="coding-root"></section><dialog id="modal"></dialog></body></html>');globalThis.document=document;globalThis.location={origin:'http://localhost:8080'};
 Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??''},set(v){for(const o of this.querySelectorAll('option'))o.value===v?o.setAttribute('selected',''):o.removeAttribute('selected')}});
 Object.defineProperty(Object.getPrototypeOf(document.createElement('input')),'checked',{configurable:true,get(){return this.hasAttribute('checked')},set(v){v?this.setAttribute('checked',''):this.removeAttribute('checked')}});
 globalThis.FormData=class{constructor(f){this.f=f}get(name){return this.f.querySelector('[name="'+name+'"]').value}};
 const modal=document.querySelector('#modal');modal.showModal=()=>modal.open=true;modal.close=()=>modal.open=false;
 const q=s=>{const el=document.querySelector(s);assert.ok(el,s);return el},flush=()=>new Promise(r=>setImmediate(r));
 const click=async s=>{q(s).onclick({preventDefault(){}});await flush()},submit=async s=>{const f=q(s);f.onsubmit({preventDefault(){},target:f});await flush()};
 const response=body=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>body});
 const connections=['managed','monitor'].map(mode=>({id:'conn-'+mode,name:mode,source:'claude-code',mode,enabled:true,received:0,project:'QA',tasks:[]}));
 let requests=[],releaseCreate,releaseFile;
 globalThis.fetch=async(url,opts)=>{requests.push({url,opts});if(url==='/api/coding/connections'&&opts.method==='GET')return response({connections,canManage:opts.headers.authorization==='Bearer admin'});if(url.startsWith('/api/coding/events'))return response({rows:[],total:0});if(url==='/api/coding/connections'&&opts.method==='POST')return new Promise(r=>releaseCreate=()=>{const c={...connections[0],id:'conn-new'};connections.push(c);r(response({...c,token:'TEST_TOKEN'}))});if(url.endsWith('/revoke')){connections.find(c=>url.includes(c.id)).enabled=false;return response({})}throw Error('Unexpected request '+url)};
 const {bindCoding}=await import('./dist/coding-ui.mjs');bindCoding();q('[name="key"]').value='admin';await submit('#coding-login');await flush();
 assert.ok(q('[data-coding-action="stop"][data-id="conn-managed"]'));await click('[data-coding-action="revoke"][data-id="conn-managed"]');await click('[data-confirm-action]');assert.equal(connections[0].enabled,false);
 await click('[data-coding-select="conn-monitor"]');q('#coding-file').files=[{size:100,text:()=>new Promise(r=>releaseFile=r)}];const importPromise=q('[data-coding-import]').onclick();await flush();await click('[data-coding-disconnect]');releaseFile('{"resourceLogs":[]}');await importPromise;assert.equal(requests.filter(r=>r.url.endsWith('/import')).length,0,'disconnect while reading must cancel import before any POST');
 q('[name="key"]').value='admin';await submit('#coding-login');q('[name="name"]').value='new';const form=q('#coding-create-form');const creating=form.onsubmit({preventDefault(){},target:form});await flush();await click('[data-coding-select="conn-monitor"]');assert.equal(q('#coding-create-form [type="submit"]').disabled,true,'rerender must retain pending create lock');await submit('#coding-create-form');assert.equal(requests.filter(r=>r.url==='/api/coding/connections'&&r.opts.method==='POST').length,1);const replacement=document.createElement('section');replacement.id='coding-root';q('#coding-root').replaceWith(replacement);bindCoding();await flush();assert.equal(q('#coding-create-form [type="submit"]').disabled,true);releaseCreate();await creating;await flush();assert.equal(q('#coding-create-form [type="submit"]').disabled,false);await click('[data-new-setup]');assert.ok(q('#coding-secret'));await click('#modal .close');
 await click('[data-coding-disconnect]');q('[name="key"]').value='read';await submit('#coding-login');assert.equal(document.querySelector('[data-coding-action]'),null,'read-only must expose neither revoke nor stop');

 // The ledger snapshot is propagated on every export page. New rows cannot shift
 // later offsets; the separate backend regression verifies SQLite semantics.
 document.querySelector('#coding-root').remove();const root=document.createElement('section');root.id='usage-root';document.body.append(root);
 const at=new Date().toISOString(),day=new Date(Date.now()+28800000).toISOString().slice(0,10);
 const rows=Array.from({length:501},(_,i)=>({rowid:i+1,task_id:'task',event_id:'event-'+i,at,day,provider:'P',model:'M',customer:'C',feature:'F',source:'test',status:'success',input_tokens:1,output_tokens:1,cost:.01,basis:'reported'}));
 let initialRelease,holdInitial=true,exportCalls=0,exported,filename;
 const blobs=new Map(),originalCreate=URL.createObjectURL;URL.createObjectURL=blob=>{const u=originalCreate(blob);blobs.set(u,blob);return u};
 document.createElement=(orig=>function(name){const el=orig.call(this,name);if(name==='a')el.click=()=>{exported=blobs.get(el.href);filename=el.download};return el})(document.createElement);
 globalThis.fetch=async(url)=>{const p=new URLSearchParams(url.split('?')[1]);const snapshot=p.has('snapshot')?Number(p.get('snapshot')):501;const body={...demoQuery(rows.filter(r=>r.rowid<=snapshot),p),snapshot};if(p.get('limit')==='500'){assert.equal(p.get('snapshot'),'501');exportCalls++;if(exportCalls===1)rows.unshift({...rows[0],rowid:502,event_id:'new-during-export'})}if(holdInitial)return new Promise(r=>initialRelease=()=>r(response(body)));return response(body)};
 const {bindUsage}=await import('./dist/usage-ui.mjs');bindUsage();await flush();await click('[data-mode="server"]');q('[name="key"]').value='read';await submit('#usage-login');assert.match(q('#usage-connection-status').textContent,/正在验证/);assert.doesNotMatch(q('#usage-auth').textContent,/已连接/);holdInitial=false;initialRelease();await flush();assert.match(q('#usage-connection-status').textContent,/已连接/);await click('[data-csv]');await flush();assert.equal(exportCalls,2);const text=await exported.text();assert.equal(text.trim().split('\n').length,502);assert.doesNotMatch(text,/new-during-export/);for(let i=0;i<501;i++)assert.equal(text.split('"event-'+i+'"').length-1,1);

 root.remove();const integrationRoot=document.createElement('section');integrationRoot.id='integrations-root';document.body.append(integrationRoot);
 const {bindIntegrations}=await import('./dist/integration-ui.mjs');bindIntegrations();await click('[data-integration-edit="DEEPSEEK"]');q('[name="API_KEY"]').value='token-with-$-literal';await click('[data-docker-env-export]');assert.equal(filename,'agentguard-deepseek.docker.env');assert.match(await exported.text(),/^DEEPSEEK_API_KEY=token-with-\$-literal$/m);await click('[data-env-export]');assert.equal(filename,'agentguard-deepseek.env');assert.match(await exported.text(),/^DEEPSEEK_API_KEY='token-with-\$-literal'$/m);
});
