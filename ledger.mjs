import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {presets} from './dist/engine.mjs';

const columns=['task_id','event_id','at','day','customer','feature','agent','provider','model','requested_model','source','input_tokens','output_tokens','cached_tokens','cost','currency','basis','duration_ms','status','pricing','cache_creation_tokens','reasoning_tokens','session_id','project','connection_id'];
const tok=n=>Number.isSafeInteger(n)&&n>=0?n:null;
export function usageTokens(usage){
 const input=tok(usage?.prompt_tokens),output=tok(usage?.completion_tokens);
 const cached=tok(usage?.prompt_cache_hit_tokens??usage?.prompt_tokens_details?.cached_tokens);
 return {input_tokens:input,output_tokens:output,cached_tokens:input!==null&&cached!==null&&cached<=input?cached:null};
}
export function usageRow(t,e){
 const at=e.at&&Number.isFinite(Date.parse(e.at))?new Date(e.at).toISOString():null;
 return {task_id:t.id,event_id:e.id,at,day:at?new Date(Date.parse(at)+8*3600000).toISOString().slice(0,10):null,customer:t.customer,feature:t.feature,agent:e.agent||'root',provider:e.provider||'unknown',model:e.model||(e.tool?.startsWith('llm:')?e.tool.slice(4):'unknown'),requested_model:e.requested_model||null,source:e.source||'event',input_tokens:tok(e.input_tokens),output_tokens:tok(e.output_tokens),cached_tokens:tok(e.cached_tokens),cost:e.cost||0,currency:'CNY',basis:e.basis||'reported',duration_ms:tok(e.duration_ms),status:e.error?'failed':'success',pricing:e.pricing?JSON.stringify(e.pricing):null,cache_creation_tokens:tok(e.cache_creation_tokens),reasoning_tokens:tok(e.reasoning_tokens),session_id:e.session_id||null,project:e.project||t.project||null,connection_id:e.connection_id||t.connection_id||null};
}
export class Ledger{
 constructor(dir){
  fs.mkdirSync(dir,{recursive:true});this.db=new Database(path.join(dir,'agentguard.sqlite'));
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS app_state(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS usage_events(
    task_id TEXT NOT NULL,event_id TEXT NOT NULL,at TEXT,day TEXT,customer TEXT,feature TEXT,agent TEXT,
    provider TEXT NOT NULL,model TEXT NOT NULL,requested_model TEXT,source TEXT,
    input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,cost REAL NOT NULL,currency TEXT NOT NULL,
    basis TEXT,duration_ms INTEGER,status TEXT,pricing TEXT,PRIMARY KEY(task_id,event_id));
   CREATE INDEX IF NOT EXISTS usage_day ON usage_events(day);
   CREATE INDEX IF NOT EXISTS usage_model ON usage_events(provider,model,day);
   CREATE INDEX IF NOT EXISTS usage_customer ON usage_events(customer,feature,day);
   CREATE TABLE IF NOT EXISTS coding_events(connection_id TEXT NOT NULL, event_id TEXT NOT NULL, at TEXT NOT NULL, source TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(connection_id,event_id));
   CREATE INDEX IF NOT EXISTS coding_events_time ON coding_events(at);
   PRAGMA user_version=2;`);
  const existing=new Set(this.db.prepare('PRAGMA table_info(usage_events)').all().map(x=>x.name));
  for(const [column,type] of Object.entries({cache_creation_tokens:'INTEGER',reasoning_tokens:'INTEGER',session_id:'TEXT',project:'TEXT',connection_id:'TEXT'}))if(!existing.has(column))this.db.exec(`ALTER TABLE usage_events ADD COLUMN ${column} ${type}`);
  this.insert=this.db.prepare(`INSERT INTO usage_events(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT(task_id,event_id) DO NOTHING`);
  const saved=this.db.prepare('SELECT payload FROM app_state WHERE id=1').get();
  if(saved)this.state=JSON.parse(saved.payload);
  else{
   const legacy=path.join(dir,'state.json');this.state=fs.existsSync(legacy)?JSON.parse(fs.readFileSync(legacy,'utf8')):{tasks:{},policies:structuredClone(presets)};
   const imported=[];
   for(const t of Object.values(this.state.tasks)){
    const seen=new Set();let cost=0;
    for(const e of t.events||[]){if(seen.has(e.id))continue;seen.add(e.id);cost+=e.cost||0;imported.push(usageRow(t,{...e,source:'legacy',basis:'legacy'}))}
    if(t.cost-cost>1e-9)imported.push(usageRow(t,{id:'legacy-balance',cost:t.cost-cost,source:'legacy',basis:'legacy'}));
   }
   this.save(this.state,imported);
  }
 }
 save(state,rows=[],events=[]){
  const committed=structuredClone(state),payload=JSON.stringify(committed);
  try{this.db.exec('BEGIN IMMEDIATE');
this.db.prepare('INSERT INTO app_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(payload);for(const row of rows)this.insert.run(...columns.map(k=>row[k]??null));for(const e of events)this.db.prepare('INSERT INTO coding_events(connection_id,event_id,at,source,session_id,kind,payload) VALUES(?,?,?,?,?,?,?)').run(e.connection_id,e.id,e.at,e.source,e.session_id,e.kind,JSON.stringify(e));this.db.exec('COMMIT');this.state=committed}catch(e){try{this.db.exec('ROLLBACK')}catch{}e.persistenceFailure=true;throw e}
 }
 query(params){
  const snapshot=Number(params.get('snapshot')??this.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM usage_events').get().n);
  if(!Number.isSafeInteger(snapshot)||snapshot<0)throw Error('账本快照参数无效');
  const conditions=['rowid<=?'],values=[snapshot];const get=k=>params.get(k)||'';
  for(const key of ['from','to']){const v=get(key);if(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw Error('日期格式必须为有效 YYYY-MM-DD');conditions.push(`day ${key==='from'?'>=':'<='} ?`);values.push(v)}}
  if(get('from')&&get('to')&&get('from')>get('to'))throw Error('开始日期不能晚于结束日期');
  for(const key of ['provider','model','customer','feature','source','project','connection_id'])if(get(key)){conditions.push(`${key}=?`);values.push(get(key))}
  const where=conditions.join(' AND '),offset=Number(get('offset')||0),limit=Number(get('limit')||50);
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('分页参数无效');
  const aggregate=`COUNT(*) requests,COUNT(DISTINCT task_id) tasks,COUNT(DISTINCT day) active_days,COALESCE(SUM(cost),0) cost,SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens,SUM(cached_tokens) cached_tokens,SUM(cache_creation_tokens) cache_creation_tokens,SUM(reasoning_tokens) reasoning_tokens,COALESCE(SUM(basis='unpriced'),0) unpriced_requests,SUM(CASE WHEN cached_tokens IS NOT NULL THEN input_tokens ELSE 0 END) cache_known_input,COALESCE(SUM(status='success'),0) successes,COALESCE(SUM(input_tokens IS NULL OR output_tokens IS NULL),0) unknown_usage,COALESCE(SUM(basis IN ('reserved_estimate','telemetry_estimate','rate_estimate')),0) estimated_requests`;
  const all=sql=>this.db.prepare(sql).all(...values);
  const summary=this.db.prepare(`SELECT ${aggregate} FROM usage_events WHERE ${where}`).get(...values);
  return {snapshot,timezone:'Asia/Shanghai',currency:'CNY',summary,models:all(`SELECT provider,model,${aggregate} FROM usage_events WHERE ${where} GROUP BY provider,model ORDER BY cost DESC`),daily:all(`SELECT day,${aggregate} FROM usage_events WHERE ${where} AND day IS NOT NULL GROUP BY day ORDER BY day`),rows:this.db.prepare(`SELECT * FROM usage_events WHERE ${where} ORDER BY at DESC,task_id,event_id LIMIT ? OFFSET ?`).all(...values,limit,offset),offset,limit,
   undated:this.db.prepare('SELECT COUNT(*) count,COALESCE(SUM(cost),0) cost FROM usage_events WHERE day IS NULL').get(),
   options:{models:this.db.prepare('SELECT DISTINCT provider,model FROM usage_events ORDER BY provider,model').all(),customers:this.db.prepare('SELECT DISTINCT customer FROM usage_events ORDER BY customer').all().map(x=>x.customer),projects:this.db.prepare('SELECT DISTINCT project FROM usage_events WHERE project IS NOT NULL').all().map(x=>x.project),sources:this.db.prepare('SELECT DISTINCT source FROM usage_events').all().map(x=>x.source),features:this.db.prepare('SELECT DISTINCT feature FROM usage_events ORDER BY feature').all().map(x=>x.feature)}};
 }
 costModels(state){
  const rows=this.db.prepare(`SELECT provider,model,COUNT(*) requests,SUM(basis='unpriced') unpriced_requests,SUM(cost) cost,SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens,JSON_GROUP_ARRAY(DISTINCT task_id) task_ids FROM usage_events GROUP BY provider,model ORDER BY cost DESC`).all();
  return rows.map(({task_ids,...row})=>{const tasks=JSON.parse(task_ids).map(id=>state.tasks[id]).filter(Boolean),completed=tasks.filter(t=>['success','stopped','failed'].includes(t.status)).length,success=tasks.filter(t=>t.status==='success').length;return{...row,tasks:tasks.length,success,completed,rate:completed?success/completed:0,unit:success?row.cost/success:null}});
 }
 hasCodingEvent(connection,id){return !!this.db.prepare('SELECT 1 FROM coding_events WHERE connection_id=? AND event_id=?').get(connection,id)}
 codingEvents(p){const conditions=[],args=[];for(const k of ['connection_id','source','session_id','kind'])if(p.get(k)){conditions.push(k+'=?');args.push(p.get(k))}const offset=Number(p.get('offset')||0),limit=Number(p.get('limit')||50);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('分页参数无效');const where=conditions.length?'WHERE '+conditions.join(' AND '):'';return {total:this.db.prepare('SELECT COUNT(*) n FROM coding_events '+where).get(...args).n,offset,limit,rows:this.db.prepare('SELECT payload FROM coding_events '+where+' ORDER BY at DESC,event_id LIMIT ? OFFSET ?').all(...args,limit,offset).map(x=>JSON.parse(x.payload))}}
 close(){this.db.close()}
}
