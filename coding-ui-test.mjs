import {parseHTML} from 'linkedom';
import assert from 'node:assert/strict';
const {document}=parseHTML('<html><body><span class="environment"></span><section id="coding-root"></section><dialog id="modal"></dialog></body></html>');
globalThis.document=document;globalThis.location={origin:'http://localhost:8080'};
Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||''},set(v){this.querySelectorAll('option').forEach(o=>o.value===v?o.setAttribute('selected',''):o.removeAttribute('selected'))}});
globalThis.FormData=class{constructor(f){this.f=f}get(k){return this.f.querySelector('[name="'+k+'"]').value}};
const modal=document.querySelector('#modal');modal.showModal=()=>modal.open=true;modal.close=()=>{modal.open=false;modal.dispatchEvent(new Event('close'))};
// Use LinkeDOM's own Event for DOM dispatch.
modal.close=()=>{modal.open=false};
let connections=[],calls=[],mode='ok',copied='',pending;
Object.defineProperty(globalThis,'navigator',{value:{clipboard:{writeText:async v=>copied=v}},configurable:true});
const response=(data,status=200)=>({ok:status<400,headers:{get:()=> 'application/json'},json:async()=>data});
globalThis.fetch=async(url,opts)=>{calls.push({url,opts});if(mode==='hold')return new Promise(r=>pending=()=>r(response({connections,canManage:true})));if(mode==='denied')return response({error:'需要 ADMIN_KEY'},403);if(mode==='static')return{headers:{get:()=> 'text/html'}};
 if(url==='/api/coding/connections'&&opts.method==='GET')return response({connections,canManage:true});
 if(url==='/api/coding/connections'&&opts.method==='POST'){const b=JSON.parse(opts.body),c={...b,id:'conn-test',received:0,enabled:true,tasks:[],controller_live:false,last_received:null};connections.push(c);return response({...c,token:'ONE_TIME_TOKEN'},201)}
 if(url.startsWith('/api/coding/events'))return response({total:0,rows:[]});
 if(url.endsWith('/import'))return response({accepted:2,duplicates:1,ignored:0,rejected:0});
 if(url.endsWith('/stop')||url.endsWith('/revoke')){connections[0].enabled=false;return response({})}
 if(url.includes('/approve')){connections[0].tasks[0].status='running';return response({})}
 throw Error('Unexpected '+url)
};
const {bindCoding}=await import('./dist/coding-ui.mjs');
const flush=()=>new Promise(r=>setImmediate(r)),q=s=>{const el=document.querySelector(s);assert.ok(el,s);return el};let checks=0;
async function click(s){q(s).onclick();checks++;await flush()}
async function submit(s){const f=q(s);f.onsubmit({preventDefault(){},target:f});checks++;await flush()}
bindCoding();assert.equal(calls.length,0);assert.match(q('#coding-root').textContent,/不能保证费用不超额/);
q('[name="key"]').value='admin';await submit('#coding-login');assert.match(q('#coding-content').textContent,/尚未创建/);
q('[name="name"]').value='Claude project';q('[name="project"]').value='AICost';q('[name="fx"]').value='7';q('[name="model"]').value='model';await submit('#coding-create-form');assert.match(q('#coding-message').textContent,/四项单价/);assert.equal(connections.length,0);
q('[name="model"]').value='';await submit('#coding-create-form');assert.equal(connections.length,1);assert.equal(modal.open,true);assert.equal(q('#coding-secret').value,'ONE_TIME_TOKEN');await click('[data-secret-copy]');assert.equal(copied,'ONE_TIME_TOKEN');await click('#modal .close');assert.equal(modal.innerHTML,'');
await click('[data-coding-setup]');assert.equal(document.querySelector('#coding-secret'),null);assert.match(modal.textContent,/只监测连接不会停止/);await click('#modal .close');
const file=q('#coding-file');file.files=[{size:50,text:async()=>JSON.stringify({resourceLogs:[]})}];await click('[data-coding-import]');await flush();assert.match(q('#coding-message').textContent,/导入 2 条/);
await click('[data-coding-action]');assert.equal(modal.open,true);await click('#modal .close');assert.equal(connections[0].enabled,true);await click('[data-coding-action]');await click('[data-confirm-action]');assert.equal(connections[0].enabled,false);
connections[0]={...connections[0],enabled:true,mode:'managed',controller:{state:'stopped'},tasks:[{id:'task1',cost:1,status:'approval',budget:1,alerts:[{title:'预算',detail:'测试证据',action:'approve',at:'now'}],children:0,unknown_cost:0,missing_arguments:0}]};await click('[data-coding-refresh]');assert.match(q('#coding-content').textContent,/启动器确认已停止/);q('[name="extra"]').value='2';await submit('[data-coding-approve]');assert.equal(connections[0].tasks[0].status,'running');
await click('[data-coding-disconnect]');assert.ok(q('#coding-login'));assert.equal(document.querySelector('#coding-create-form'),null);
mode='static';q('[name="key"]').value='read';await submit('#coding-login');assert.match(q('#coding-message').textContent,/仅提供前端预览/);await click('[data-coding-disconnect]');
mode='denied';q('[name="key"]').value='wrong';await submit('#coding-login');assert.match(q('#coding-message').textContent,/ADMIN_KEY/);await click('[data-coding-disconnect]');
mode='hold';q('[name="key"]').value='read';q('#coding-login').onsubmit({preventDefault(){},target:q('#coding-login')});await flush();await click('[data-coding-disconnect]');pending();await flush();assert.ok(q('#coding-login'));assert.equal(document.querySelector('#coding-create-form'),null);
console.log('PASS: coding UI '+checks+' actions; creation, one-time credentials, setup, import, stop/revoke confirmation, approval, errors, disconnect and stale responses.');
