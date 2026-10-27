import crypto from 'node:crypto';
import {task,evaluate,presets} from './dist/engine.mjs';
import {usageRow} from './ledger.mjs';
import {flatten,normalize,readTelemetry,encodePartialSuccess} from './telemetry.mjs';

const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const validString=(s,max=100)=>typeof s==='string'&&s.length>0&&s.length<=max;
const publicConnection=c=>{const {tokenHash,...rest}=c;return rest};
const active=c=>['starting','running'].includes(c.controller?.state)&&Date.now()-Date.parse(c.controller.at)<10000;
export class CodingService{
 constructor({ledger,getState,setState,alert}){Object.assign(this,{ledger,getState,setState,alert})}
 commit(state,rows=[],events=[]){this.ledger.save(state,rows,events);this.setState(state)}
 list(){const state=this.getState();return {connections:Object.values(state.coding||{}).map(c=>({...publicConnection(c),controller_live:active(c),tasks:Object.values(state.tasks).filter(t=>t.connection_id===c.id).map(t=>({id:t.id,session:t.session_id,cost:t.cost,status:t.status,budget:t.budgetOverride??c.budget,alerts:t.alerts.slice(-30),events:t.events.length,children:t.childIds.length,unknown_cost:t.unknown_cost||0,missing_arguments:t.missing_arguments||0}))}))}}
 create(b){
  if(!['claude-code','codex'].includes(b.source)||!['monitor','managed'].includes(b.mode)||!validString(b.name)||!Object.hasOwn(presets,b.policy||'research'))throw Error('source / mode / name / policy 无效');
  const budget=Number(b.budget);if(!Number.isFinite(budget)||budget<=0||budget>1000000)throw Error('预算需大于 0 且不超过 100 万元');
  if(b.action&&!['stop','approve'].includes(b.action))throw Error('编码工具仅支持停止或转人工；不自动替换模型');
  const fx=b.usdToCny==null||b.usdToCny===''?null:Number(b.usdToCny);if(fx!==null&&(!Number.isFinite(fx)||fx<=0||fx>100))throw Error('汇率无效');
  const prices={};if(b.prices!=null&&(typeof b.prices!=='object'||Array.isArray(b.prices)))throw Error('价格表无效');
  for(const [model,r] of Object.entries(b.prices||{})){if(!validString(model,200)||['__proto__','constructor','prototype'].includes(model)||!r||typeof r!=='object')throw Error('模型价格无效');const rate={};for(const k of ['input','output','cached','creation']){if(typeof r[k]!=='number'||!Number.isFinite(r[k])||r[k]<0||r[k]>1000000)throw Error('填写完整的非负模型价格');rate[k]=r[k]}prices[model]=rate;}
  if(b.mode==='managed'&&b.source==='codex'&&!Object.keys(prices).length)throw Error('Codex 托管模式需配置模型价格；未知模型会转人工');
  if(b.mode==='managed'&&b.source==='claude-code'&&!fx&&!Object.keys(prices).length)throw Error('Claude 托管模式需配置汇率或模型价格');
  const id='conn-'+crypto.randomUUID(),token=crypto.randomBytes(32).toString('base64url');
  const preset=structuredClone(this.getState().policies?.[b.policy||'research']||presets[b.policy||'research']);const c={id,policy_snapshot:preset,policy_revision:this.getState().policyRevisions?.[b.policy||'research']||0,name:b.name,source:b.source,mode:b.mode,policy:b.policy||'research',action:b.action||'stop',budget,usdToCny:fx,prices,customer:String(b.customer||'未分类').slice(0,100),feature:String(b.feature||'编码').slice(0,100),project:String(b.project||'未分类').slice(0,200),tokenHash:hash(token),created_at:new Date().toISOString(),received:0,ignored:0,duplicates:0,last_received:null,enabled:true,controller:null};
  const state=structuredClone(this.getState());state.coding??={};state.coding[id]=c;if(c.mode==='managed')this.ensureTask(state,c,'managed');this.commit(state);return {...publicConnection(c),token};
 }
 ensureTask(state,c,session,historical=false){const id='code-'+hash(c.id+'|'+(c.mode==='managed'?'managed':session)+'|'+(historical?'history':'live')).slice(0,32);if(!state.tasks[id])state.tasks[id]=task(id,c.policy,{name:c.name,created_at:new Date().toISOString(),policy_snapshot:structuredClone(c.policy_snapshot||state.policies?.[c.policy]||presets[c.policy]),policy_revision:c.policy_revision||0,customer:c.customer,feature:c.feature,project:c.project,connection_id:c.id,session_id:session,control:c.mode,budgetOverride:c.budget,historical});return state.tasks[id]}
 authenticated(req,c){const v=String(req.headers.authorization||'').replace(/^Bearer /,'');const digest=hash(v);return c&&crypto.timingSafeEqual(Buffer.from(digest),Buffer.from(c.tokenHash))}
 decision(c){const t=Object.values(this.getState().tasks).find(t=>t.connection_id===c.id&&!t.historical);if(c.mode!=='managed')return {decision:'observe',mode:'monitor',source:c.source};return {decision:!c.enabled?'stop':!t||t.status==='running'?'allow':t.status==='approval'?'approval':'stop',cost:t?.cost||0,budget:t?.budgetOverride??c.budget,task_id:t?.id,mode:c.mode,source:c.source,controller_live:active(c),unknown_cost:t?.unknown_cost||0,last_received:c.last_valid_received||null}}
 ingest(c,payload,historical=false){
  if(historical&&c.mode==='managed')throw Error('历史导入仅允许使用只监测连接');
  const logs=flatten(payload),state=structuredClone(this.getState()),conn=state.coding[c.id],rows=[],events=[],notifications=[],batch=new Set();let ignored=0,duplicates=0,rejected=0;
  // Validate/normalize before any database mutation. Unknown event types never become billable calls.
  const normalized=logs.map(log=>{try{return normalize(log,c.source,c)}catch{return false}}).sort((a,b)=>(a?.at||'').localeCompare(b?.at||''));
  for(const e of normalized){if(e===false){rejected++;continue}if(!e){ignored++;continue}if(batch.has(e.id)||this.ledger.hasCodingEvent(c.id,e.id)){duplicates++;continue}batch.add(e.id);
   if(conn.hooks&&e.event_name==='claude_code.subagent_completed')e.childId=undefined;
   const t=this.ensureTask(state,conn,e.parent_id||e.session_id,historical);e.task_id=t.id;e.connection_id=c.id;e.project=c.project;
   const p={...t.policy_snapshot||c.policy_snapshot||presets[c.policy],budget:t.budgetOverride??c.budget,action:c.action};
   const ev={...e,tool:e.signature?e.tool:'',input:e.signature?{hash:e.signature}:{},lane:['usage','error','transport'].includes(e.kind)?'api':e.kind,childId:e.childId};
   let a=null;
   if(historical){if(!Number.isFinite(t.cost+e.cost))throw Error('累计费用超出范围');t.events.push(ev);t.cost+=e.cost;}
   else{
    const status=t.status,model=t.model;
    a=evaluate(t,ev,p);
    if(e.basis==='unpriced'&&e.kind==='usage'&&c.mode==='managed'&&t.status==='running'){a={id:'unpriced-'+e.id,type:'pricing',title:'缺少计价信息，需人工确认',detail:'本次调用无法可靠计价，已要求本机启动器停止；费用不是零。',action:'approve',at:e.at};t.alerts.push(a);t.status='approval';}
    if(c.mode==='monitor'){t.status=status;t.model=model;if(a){a.requested_action=a.action;a.action='notify';const previous=t.alerts.slice(0,-1).findLast(x=>x.type===a.type);if(previous&&Date.parse(e.at)-Date.parse(previous.at)<60000){t.alerts.pop();a=null}}}
   }
   if(e.basis==='unpriced'&&['usage','error'].includes(e.kind))t.unknown_cost=(t.unknown_cost||0)+1;
   if(e.loop_coverage==='missing_arguments')t.missing_arguments=(t.missing_arguments||0)+1;
   if(a)notifications.push([t,a]);
   if(['usage','error'].includes(e.kind))rows.push(usageRow(t,e));
   events.push(e);
  }
  if(events.length)conn.last_valid_received=new Date().toISOString();conn.received+=events.length;conn.ignored+=ignored;conn.duplicates+=duplicates;conn.last_received=new Date().toISOString();conn.last_rejected=rejected;
  this.commit(state,rows,events);for(const [t,a]of notifications)void this.alert(t,a);
  return {accepted:events.length,ignored,duplicates,rejected};
 }
 async handle(req,res,u,{admin,read,send,body}){
  const ingest=u.pathname.match(/^\/api\/telemetry\/(conn-[a-zA-Z0-9-]+)\/(v1\/logs|decision|heartbeat)$/);
  if(ingest){let c=this.getState().coding?.[ingest[1]];if(!c||!this.authenticated(req,c)){send(res,401,{error:'连接凭证无效'});return true}
   const op=ingest[2];
   if(op==='decision'&&req.method==='GET'){send(res,200,this.decision(c));return true}
   if(req.method!=='POST'){send(res,405,{error:'POST required'});return true}
   if(op==='heartbeat'){
    if(c.mode!=='managed'){send(res,409,{error:'只监测连接不接受控制器'});return true}
    const b=await body(req);c=this.getState().coding[c.id];if(!validString(b.runner,100)||!['starting','running','stopped','completed','failed'].includes(b.state))throw Error('控制器状态无效');
    const controller=c.controller, live=controller&&['starting','running'].includes(controller.state);
    // A runner must claim with starting. Terminal retries are idempotent and may
    // never settle a task reopened by an administrator or owned by a new runner.
    if(b.state==='starting'){
     if(live){if(controller.runner!==b.runner){send(res,409,{error:'此连接已有活动启动器'});return true}send(res,200,this.decision(c));return true}
     if(controller?.runner===b.runner){send(res,409,{error:'已结束的启动器不能重新占用连接，请创建新的运行实例'});return true}
    }else{
     if(!controller||controller.runner!==b.runner){send(res,409,{error:'启动器未持有此连接，请先申请 starting'});return true}
     if(!live){if(controller.state===b.state){send(res,200,this.decision(c));return true}send(res,409,{error:'启动器已结束，拒绝过期状态更新'});return true}
    }
    if(['starting','running'].includes(b.state)&&(!c.enabled||this.decision(c).decision!=='allow')){send(res,409,{error:'连接已停止或等待审批'});return true}
    const state=structuredClone(this.getState());if(b.hooks===true)state.coding[c.id].hooks=true;state.coding[c.id].controller={runner:b.runner,state:b.state,at:new Date().toISOString(),reason:String(b.reason||'').slice(0,160)};
    const t=Object.values(state.tasks).find(t=>t.connection_id===c.id&&!t.historical);if(t&&t.status==='running'&&['stopped','completed','failed'].includes(b.state))t.status=b.state==='completed'?'success':b.state==='failed'?'failed':'stopped';
    this.commit(state);send(res,200,this.decision(state.coding[c.id]));return true;
   }
   if(!c.enabled){send(res,403,{error:'连接已撤销'});return true}
   const {payload,binary}=await readTelemetry(req);c=this.getState().coding[c.id];if(!c.enabled){send(res,403,{error:'连接已撤销'});return true}const r=this.ingest(c,payload,u.searchParams.get('historical')==='1');
   if(binary){res.writeHead(200,{'content-type':'application/x-protobuf'});res.end(encodePartialSuccess(r.rejected))}
   else send(res,200,{...r,...(r.rejected?{partialSuccess:{rejectedLogRecords:String(r.rejected),errorMessage:'部分遥测缺少有效时间、会话或用量字段'}}:{})});return true;
  }
  if(!u.pathname.startsWith('/api/coding'))return false;
  if(req.method==='GET'){if(!read){send(res,401,{error:'需要 READ_KEY 或 ADMIN_KEY'});return true}if(u.pathname==='/api/coding/connections')send(res,200,{...this.list(),canManage:admin});else if(u.pathname==='/api/coding/events')send(res,200,this.ledger.codingEvents(u.searchParams));else send(res,404,{error:'not found'});return true}
  if(!admin){send(res,403,{error:'需要 ADMIN_KEY 管理连接'});return true}
  if(u.pathname==='/api/coding/connections'&&req.method==='POST'){send(res,201,this.create(await body(req)));return true}
  const imported=u.pathname.match(/^\/api\/coding\/connections\/(conn-[a-zA-Z0-9-]+)\/import$/);
  if(imported&&req.method==='POST'){const c=this.getState().coding?.[imported[1]];if(!c){send(res,404,{error:'连接不存在'});return true}const {payload}=await readTelemetry(req);send(res,200,this.ingest(c,payload,true));return true}
  const action=u.pathname.match(/^\/api\/coding\/connections\/(conn-[a-zA-Z0-9-]+)\/(revoke|stop)$/);
  if(action&&req.method==='POST'){const state=structuredClone(this.getState()),c=state.coding?.[action[1]];if(!c){send(res,404,{error:'连接不存在'});return true}if(action[2]==='stop'&&c.mode!=='managed'){send(res,409,{error:'只监测连接不能停止客户端，请在本机操作'});return true}if(action[2]==='revoke')c.enabled=false;for(const t of Object.values(state.tasks))if(t.connection_id===c.id&&c.mode==='managed'&&!t.historical&&['running','approval'].includes(t.status)){const budget=t.budgetOverride??c.budget;state.audit??=[];state.audit.push({id:crypto.randomUUID(),at:new Date().toISOString(),actor:'admin',action:action[2],task_id:t.id,connection_id:c.id,before:{status:t.status,budget},after:{status:'stopped',budget}});t.status='stopped'}this.commit(state);send(res,200,{...publicConnection(c),...this.decision(c)});return true}
  send(res,404,{error:'not found'});return true;
 }
}
