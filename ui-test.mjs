import {parseHTML} from 'linkedom';
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
import * as engine from './dist/engine.mjs';
const {document}=parseHTML(fs.readFileSync('dist/demo.html','utf8'));
// LinkeDOM lacks the browser's writable select.value implementation.
Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||''},set(value){this.querySelectorAll('option').forEach(o=>{if(o.value===value)o.setAttribute('selected','');else o.removeAttribute('selected')})}});
let intervals=new Map(),nid=0,downloads=[],storage=new Map(),checks=0;
const location={hash:'#overview'},listeners={};
const window={};
class FormData {constructor(form){this.form=form}get(n){const e=this.form.querySelector('[name="'+n+'"]');if(e.tagName==='SELECT')return e.querySelector('option[selected]')?.getAttribute('value')||e.querySelector('option').getAttribute('value');return e.value}}
const dialog=document.querySelector('#modal');dialog.showModal=()=>dialog.open=true;dialog.close=()=>dialog.open=false;
window.addEventListener=(name,cb)=>listeners[name]=cb;
const localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
document.createElement=(orig=>function(name){const el=orig.call(this,name);if(name==='a')el.click=()=>downloads.push(el.download);return el})(document.createElement);
const ctx=vm.createContext({document,window,location,localStorage,FormData,engine,structuredClone,console,crypto:globalThis.crypto,Blob,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>{}},setTimeout:()=>0,clearTimeout:()=>{},setInterval:f=>{const id=++nid;intervals.set(id,f);return id},clearInterval:id=>intervals.delete(id)});
let src=fs.readFileSync('dist/demo-app.mjs','utf8').replace("import {integrationsPage,bindIntegrations} from './integration-ui.mjs';","const integrationsPage=()=>'<h1>接入中心</h1>',bindIntegrations=()=>{};").replace("import {codingPage,bindCoding} from './coding-ui.mjs';","const codingPage=()=>'',bindCoding=()=>{};").replace("import {usagePage,bindUsage} from './usage-ui.mjs';","const usagePage=()=>'',bindUsage=()=>{};").replace("import {openDialog,closeDialog} from './ui-core.mjs';\n",'').replace(/^import.*\n/,'const {presets,task,evaluate,metrics}=engine;\n');
src=fs.readFileSync('dist/ui-core.mjs','utf8').replaceAll('export ','')+'\n'+src;
vm.runInContext(src,ctx);
const q=s=>{const e=document.querySelector(s);assert.ok(e,s);return e};
const click=s=>{q(s).onclick();checks++};
const submit=s=>{q(s).onsubmit({preventDefault(){},target:q(s)});checks++};
const select=(name,v)=>{const e=q('[name="'+name+'"]');e.querySelectorAll('option').forEach(o=>o.removeAttribute('selected'));e.querySelector('[value="'+v+'"]').setAttribute('selected','')};
const go=id=>{location.hash='#'+id;listeners.hashchange();checks++;assert.match(document.querySelector('#app').textContent,new RegExp(({overview:'异常检测记录',runs:'任务追踪',alerts:'风险与审批',cost:'成本与业务结果',policies:'预设费用策略',integrations:'接入中心',deploy:'部署在'})[id]))};
const tick=(n=1)=>{for(let i=0;i<n;i++)for(const f of [...intervals.values()])f()};
const state=()=>JSON.parse(storage.get('ag-v1'));
function start(s,p){click('header [data-demo]');assert.equal(dialog.open,true);select('scenario',s);select('policy',p);submit('#demo-form');assert.equal(dialog.open,false)}
for(const id of ['overview','runs','alerts','cost','policies','integrations','deploy'])go(id);
go('overview');click('[data-export]');assert.deepEqual(downloads,['agentguard-runs.json']);
click('header [data-demo]');assert.equal(dialog.open,true);click('#modal .close');assert.equal(dialog.open,false);
start('loop','support');tick(4);assert.equal(state().tasks[0].status,'stopped');assert.equal(state().tasks[0].alerts[0].type,'loop');
start('retry','support');tick(4);assert.equal(state().tasks[0].alerts[0].type,'retry');
start('swarm','research');tick(7);assert.equal(state().tasks[0].status,'approval');go('alerts');click('[data-review]');submit('#approval');tick(4);assert.equal(state().tasks[0].status,'success');
start('budget','research');tick(3);assert.equal(state().tasks[0].status,'approval');go('alerts');click('[data-review]');click('#reject');assert.equal(state().tasks[0].status,'stopped');
start('retry','content');tick(2);assert.equal(state().tasks[0].model,'备用模型');assert.equal(state().tasks[0].status,'running');tick();assert.equal(state().tasks[0].status,'stopped');
start('normal','support');tick(5);assert.equal(state().tasks[0].status,'success');
start('normal','support');tick();click('[data-detail]');click('#stop');const n=state().tasks[0].events.length;tick(3);assert.equal(state().tasks[0].events.length,n);
start('normal','support');tick();click('[data-detail]');click('#finish');assert.equal(state().tasks[0].status,'success');
go('runs');q('#search').value='missing-task-name';q('#search').oninput();assert.match(q('#rows').textContent,/没有匹配/);q('#search').value='星河';q('#search').oninput();assert.ok(q('#rows').querySelectorAll('tr').length);
go('policies');for(const id of ['support','research','content']){q('[data-policy="'+id+'"] [name="budget"]').value='12';submit('[data-policy="'+id+'"]');assert.equal(state().policies[id].budget,12)}go('overview');go('policies');assert.equal(q('[data-policy="support"] [name="budget"]').value,'12');
// Integration editing and network states are covered in integration-ui-test.mjs.

go('deploy');q('[data-check="0"]').checked=true;q('[data-check="0"]').onchange();go('overview');go('deploy');assert.equal(q('[data-check="0"]').checked,true);
for(const a of document.querySelectorAll('#app a[download]'))assert.ok(fs.existsSync('dist/'+a.getAttribute('href')));
// Invalid values must also be rejected outside native browser constraint validation.
go('policies');q('[data-policy="support"] [name="loop"]').value='13';submit('[data-policy="support"]');assert.equal(state().policies.support.loop,3);
start('loop','research');tick(4);const pausedId=state().tasks[0].id;assert.equal(state().tasks[0].status,'approval');
go('alerts');click('[data-review="'+pausedId+'"]');q('[name="extra"]').value='0';submit('#approval');assert.equal(state().tasks[0].status,'approval');click('#modal .close');
start('normal','support');tick();go('alerts');click('[data-review="'+pausedId+'"]');submit('#approval');
go('overview');click('[data-detail]');click('#stop');tick(3);assert.equal(state().tasks.find(t=>t.id===pausedId).status,'success');
start('normal','support');go('runs');q('#search').value='does-not-exist';q('#status').value='running';q('#search').oninput();tick();assert.equal(q('#search').value,'does-not-exist');assert.equal(q('#status').value,'running');assert.match(q('#rows').textContent,/没有匹配/);
go('policies');q('[data-policy="support"] [name="budget"]').value='77';tick(4);assert.equal(q('[data-policy="support"] [name="budget"]').value,'77');assert.equal(state().policies.support.budget,12);
const set=localStorage.setItem;localStorage.setItem=()=>{throw Error('quota exceeded')};submit('[data-policy="support"]');assert.match(q('#toast').textContent,/存储不可用/);localStorage.setItem=set;
for(const raw of ['{broken','{"tasks":{},"policies":{}}']){const {document:d}=parseHTML(fs.readFileSync('dist/demo.html','utf8'));const c=vm.createContext({...ctx,document:d,location:{hash:'#overview'},window:{addEventListener(){}},localStorage:{getItem:()=>raw,setItem(){}}});vm.runInContext(src,c);assert.equal(d.querySelectorAll('#rows tr').length,6)}
// Every page renders without orphan form labels or placeholder action links.
for(const page of ['overview','runs','alerts','cost','policies','integrations','deploy']){go(page);for(const l of document.querySelectorAll('#app label'))assert.ok(l.querySelector('input')||document.getElementById(l.htmlFor));for(const a of document.querySelectorAll('#app a'))assert.notEqual(a.getAttribute('href'),'#')}
console.log('PASS: '+checks+' DOM actions; explicit demo shell 7 pages and 5 scenarios; queue recovery, invalid input, persistent filters, unsaved drafts, storage failure, corrupt-state recovery, download targets (integration editor tested separately).');
