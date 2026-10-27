// Static cascade regression, deliberately NOT a substitute for browser screenshots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseHTML} from 'linkedom';
import CSSOM from '@acemir/cssom';
const {document}=parseHTML('<html><body></body></html>');
const rules=['style.css','console.css','usage.css'].flatMap(f=>Array.from(CSSOM.parse(fs.readFileSync('dist/'+f,'utf8')).cssRules)).filter(r=>r.selectorText);
const score=s=>{s=s.replace(/:not\(([^)]+)\)/g,'$1');return (s.match(/#[\w-]+/g)||[]).length*100+(s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)||[]).length*10+(s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+/g,' ').match(/\b[a-z][\w-]*\b/gi)||[]).length};
function style(el,state){const values={},priority={};for(const rule of rules)for(const raw of rule.selectorText.split(',')){if(/::|:active/.test(raw))continue;if(raw.includes(':hover')&&state!=='hover'||raw.includes(':focus-visible')&&state!=='focus')continue;const selector=raw.replace(/:hover|:focus-visible|:focus/g,'');if(!el.matches(selector))continue;const rank=score(raw);for(let i=0;i<rule.style.length;i++){let prop=rule.style[i],value=rule.style[prop];if(prop==='background')prop='background-color';if(rank>=(priority[prop]??-1)){values[prop]=value;priority[prop]=rank}}}return values}
function rgb(value){if(value==='white')return[255,255,255];if(value==='black')return[0,0,0];assert.match(value,/^#[\da-f]{3,6}$/i,'explicit solid color required: '+value);let hex=value.slice(1);if(hex.length===3)hex=[...hex].map(x=>x+x).join('');return [0,2,4].map(i=>parseInt(hex.slice(i,i+2),16))}
const lum=color=>rgb(color).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>{const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
const fixtures=[...['actions','integration','policy','banner','usage-presets','usage-login','integration-form-actions'].flatMap(parent=>[false,true].map(primary=>`<div class="${parent}"><button class="button ${primary?'primary':''}">操作</button></div>`)),'<div class="usage-tabs"><button aria-pressed="false">未选中</button></div>','<div class="usage-tabs"><button aria-pressed="true">已选中</button></div>','<header><button class="demo-tag">异常演练</button></header>','<dialog><button class="close">×</button></dialog>'];
let checks=0;
for(const html of fixtures){document.body.innerHTML=html;const el=document.querySelector('button');for(const state of ['normal','hover','focus']){const computed=style(el,state);const background=['transparent','none'].includes(computed['background-color'])?'#f8f9fb':computed['background-color']||'#ffffff';const ratio=contrast(computed.color,background);assert.ok(ratio>=4.5,`${html} / ${state}: contrast ${ratio.toFixed(2)} (${computed.color} on ${background})`);checks++;if(state==='focus')assert.ok(computed.outline,'keyboard focus ring required')}}
// Reproduce the originally reported white text / light background regression.
assert.ok(contrast('#fff','#fafbfc')<1.1);
console.log(`PASS: ${checks} static button text contrast/focus checks; normal/hover/focus across shared action containers. Browser layout and media queries require separate visual QA.`);
