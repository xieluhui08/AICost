export const presets={support:{name:'客服智能体',budget:2,loop:3,retries:3,children:4,action:'stop'},research:{name:'研究智能体',budget:10,loop:4,retries:3,children:6,action:'approve'},content:{name:'内容智能体',budget:5,loop:3,retries:2,children:3,action:'degrade'}};
export function task(id,policy='research',meta={}){return {id,policy,customer:'星河科技',feature:'竞品研究',cost:0,reserved:0,status:'running',events:[],alerts:[],childIds:[],model:'主模型',...meta};}
const canonical=x=>typeof x==='object'&&x!==null?(Array.isArray(x)?x.map(canonical):Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]))):x;
export function evaluate(t,e,p){
 if(typeof e.id!=='string'||!e.id)throw Error('event id 必填');
 if(t.events.some(x=>x.id===e.id))return null;
 if(!Number.isFinite(e.cost??0)||(e.cost??0)<0)throw Error('cost 必须为非负有限数字');
 if(!Number.isFinite(t.cost+(e.cost??0)))throw Error('累计费用超出有效范围');
 const event={...e,at:e.at||new Date().toISOString(),cost:e.cost||0};t.events.push(event);t.cost+=event.cost;
 const newChild=!!e.childId&&!t.childIds.includes(e.childId);
 if(newChild)t.childIds.push(e.childId);
 // Late settlements still count, but may never reopen a terminal or paused task.
 if(t.status!=='running')return null;
 let reason=null;
 if(t.cost+(t.reserved||0)>=p.budget)reason={type:'budget',title:'任务预算触顶',detail:`累计 ¥${t.cost.toFixed(2)} / 预算 ¥${p.budget.toFixed(2)}`};
 const recent=t.events.filter(x=>(x.agent||'root')===(e.agent||'root')&&(!e.lane||x.lane===e.lane)).slice(-12),sig=x=>JSON.stringify([x.agent||'root',x.tool||'',canonical(x.input||{})]);
 if(!reason&&e.tool&&recent.filter(x=>sig(x)===sig(e)).length>=p.loop)reason={type:'loop',title:'重复调用循环',detail:`该智能体最近 12 次调用内，以相同参数调用 ${e.tool} 达 ${p.loop} 次`};
 let streak=0;for(const x of [...t.events].reverse().filter(x=>(x.agent||'root')===(e.agent||'root')&&(!e.lane||x.lane===e.lane))){if(x.error)streak++;else break;}
 if(!reason&&streak>=p.retries)reason={type:'retry',title:'异常连续重试',detail:`智能体 ${e.agent||'root'} 连续 ${streak} 次失败`};
 if(!reason&&newChild&&t.childIds.length>p.children)reason={type:'swarm',title:'子智能体膨胀',detail:`任务累计创建 ${t.childIds.length} 个子智能体，超过 ${p.children} 个上限`};
 if(reason){const action=p.action==='degrade'&&(t.model==='备用模型'||t.cost>=p.budget)?'stop':p.action;const a={...reason,action,at:event.at,id:'a-'+event.id};t.alerts.push(a);t.status=action==='approve'?'approval':action==='stop'?'stopped':'running';if(action==='degrade')t.model='备用模型';return a;}
 return null;
}
export function gate(t,p,reserve=0){return t.status==='running'&&t.cost<p.budget&&Number.isFinite(reserve)&&reserve>=0&&t.cost+(t.reserved||0)+reserve<=p.budget+Number.EPSILON*Math.max(1,p.budget)*4;}
export function metrics(tasks){const cost=tasks.reduce((s,t)=>s+t.cost,0),done=tasks.filter(t=>['success','failed','stopped'].includes(t.status)),success=done.filter(t=>t.status==='success').length;return {cost,success,completed:done.length,rate:done.length?success/done.length:0,unit:success?cost/success:null};}
