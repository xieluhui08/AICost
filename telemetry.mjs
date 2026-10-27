import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const canonical=x=>x&&typeof x==='object'?(Array.isArray(x)?x.map(canonical):Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]))):x;
const text=x=>typeof x==='string'?x:String(x??'');
const numeric=x=>typeof x==='number'?(Number.isFinite(x)?x:null):typeof x==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(x.trim())&&Number.isFinite(Number(x))?Number(x):null;
const count=x=>{const n=numeric(x);return n!==null&&Number.isSafeInteger(n)&&n>=0?n:null};
const flag=x=>x===true||x==='true';
const failed=x=>x===false||x==='false';
function any(v,depth=0){
 if(depth>12)throw Error('OTLP attributes nesting too deep');
 if(!v||typeof v!=='object')return v;
 for(const k of ['stringValue','boolValue','intValue','doubleValue','bytesValue'])if(Object.hasOwn(v,k))return v[k];
 if(v.arrayValue)return (v.arrayValue.values||[]).map(x=>any(x,depth+1));
 if(v.kvlistValue)return attributes(v.kvlistValue.values,depth+1);
 return null;
}
function attributes(xs=[],depth=0){if(!Array.isArray(xs))throw Error('OTLP attributes must be an array');return Object.fromEntries(xs.filter(x=>typeof x?.key==='string').map(x=>[x.key,any(x.value,depth)]))}
// OTLP protobuf wire reader: only LogsServiceRequest; unknown fields are skipped.
function fields(buf){let i=0;const out=[];function variable(){let n=0n,s=0n;for(let k=0;k<10;k++){if(i>=buf.length)throw Error('Truncated protobuf');const b=buf[i++];n|=BigInt(b&127)<<s;if(!(b&128))return n;s+=7n}throw Error('Invalid protobuf varint')}
 while(i<buf.length){const tag=Number(variable()),id=tag>>>3,wire=tag&7;if(!id)throw Error('Invalid protobuf field');let v;if(wire===0)v=variable().toString();else if(wire===1){if(i+8>buf.length)throw Error('Truncated protobuf');v=buf.subarray(i,i+8);i+=8}else if(wire===2){const n=Number(variable());if(!Number.isSafeInteger(n)||n<0||i+n>buf.length)throw Error('Truncated protobuf');v=buf.subarray(i,i+n);i+=n}else if(wire===5){if(i+4>buf.length)throw Error('Truncated protobuf');v=buf.subarray(i,i+4);i+=4}else throw Error('Unsupported protobuf wire type');out.push([id,v,wire]);}return out}
const parts=(b,n)=>fields(b).filter(([id,,w])=>id===n&&w===2).map(([,v])=>v);
const string=b=>b?.toString('utf8')||'';
function pbAny(b,depth=0){if(depth>12)throw Error('OTLP nesting too deep');const f=fields(b)[0];if(!f)return {};const [id,v]=f;if(id===1)return{stringValue:string(v)};if(id===2)return{boolValue:v!=='0'};if(id===3)return{intValue:v};if(id===4)return{doubleValue:v.readDoubleLE()};if(id===5)return{arrayValue:{values:parts(v,1).map(x=>pbAny(x,depth+1))}};if(id===6)return{kvlistValue:{values:parts(v,1).map(x=>pbKV(x,depth+1))}};return{bytesValue:Buffer.isBuffer(v)?v.toString('base64'):v}}
function pbKV(b,depth=0){return {key:string(parts(b,1)[0]),value:pbAny(parts(b,2)[0]||Buffer.alloc(0),depth)}}
function pbLog(b){const o={attributes:parts(b,6).map(x=>pbKV(x))};for(const [id,v,w]of fields(b)){if(id===1&&w===1)o.timeUnixNano=v.readBigUInt64LE().toString();if(id===11&&w===1)o.observedTimeUnixNano=v.readBigUInt64LE().toString();if(id===5&&w===2)o.body=pbAny(v);if(id===9&&w===2)o.traceId=v.toString('hex');if(id===10&&w===2)o.spanId=v.toString('hex');if(id===12&&w===2)o.eventName=string(v)}return o}
function pbRequest(b){return {resourceLogs:parts(b,1).map(r=>({resource:{attributes:parts(parts(r,1)[0]||Buffer.alloc(0),1).map(x=>pbKV(x))},scopeLogs:parts(r,2).map(s=>({scope:{name:string(parts(parts(s,1)[0]||Buffer.alloc(0),1)[0])},logRecords:parts(s,2).map(pbLog)}))}))}}
export async function readTelemetry(req){
 const chunks=[];let length=0;for await(const c of req){length+=c.length;if(length>1048576)throw Error('OTLP batch exceeds 1 MB');chunks.push(c)}let data=Buffer.concat(chunks);
 const encoding=req.headers['content-encoding'];if(encoding==='gzip')data=gunzipSync(data,{maxOutputLength:1048576});else if(encoding&&encoding!=='identity')throw Error('Unsupported content encoding');
 const type=(req.headers['content-type']||'').split(';')[0];
 if(type==='application/x-protobuf')return {payload:pbRequest(data),binary:true};
 if(type==='application/json')return {payload:JSON.parse(data.toString('utf8')),binary:false};
 throw Error('Use OTLP HTTP application/json or application/x-protobuf');
}
export function flatten(payload){
 if(!Array.isArray(payload?.resourceLogs))throw Error('Expected OTLP resourceLogs');const logs=[];
 for(const r of payload.resourceLogs){const resource=attributes(r.resource?.attributes);for(const scope of r.scopeLogs||[])for(const log of scope.logRecords||[]){if(logs.length>=1000)throw Error('OTLP batch exceeds 1000 records');logs.push({a:{...resource,...attributes(log.attributes)},log,scope:scope.scope?.name||''})}}return logs;
}
export function normalize({a,log,scope},source,config){
 let name=text(a['event.name']||log.eventName||any(log.body)||scope);const prefix=source==='claude-code'?'claude_code.':'codex.';
 if(!name.startsWith(prefix)){if(source==='claude-code'&&!name.includes('.'))name=prefix+name;else return null}
 const kind=name.slice(prefix.length);let type;
 if(source==='claude-code')type=kind==='api_request'?'usage':kind==='api_error'?'error':kind==='tool_result'?'tool':kind==='agentguard_tool_start'?'tool_start':['subagent_completed','agentguard_child_start'].includes(kind)?'child':null;
 else type=['sse_event','websocket_event'].includes(kind)&&a['event.kind']==='response.completed'?'usage':kind==='api_request'?(a['error.message']||Number(a['http.response.status_code'])>=400||failed(a.success)?'error':'transport'):kind==='tool_result'?'tool':kind==='conversation_starts'?'session':null;
 if(!type)return null;
 const nano=log.timeUnixNano||log.observedTimeUnixNano;let at=text(a['event.timestamp']);if(!at&&nano&&/^\d+$/.test(text(nano)))at=new Date(Number(BigInt(nano)/1000000n)).toISOString();
 if(!at||!Number.isFinite(Date.parse(at)))throw Error('Event timestamp missing or invalid');at=new Date(at).toISOString();
 const session=text(a['session.id']||a['conversation.id']||a.session_id);if(!session)throw Error('Session ID missing');
 const model=text(a.model||a['model.name']||'unknown').slice(0,200);
 const agent=text(a['agent.id']||a.agent_id||a.agent_name||session).slice(0,200);
 const parent=text(a['parent.conversation.id']||a.parent_thread_id||a['parent.session.id']||'');
 let input=null,output=null,cached=null,creation=null,reasoning=null;
 if(type==='usage'){
  input=count(a.input_tokens??a.input_token_count);output=count(a.output_tokens??a.output_token_count);cached=count(a.cache_read_tokens??a.cached_token_count);creation=count(a.cache_creation_tokens??a.cache_write_token_count);reasoning=count(a.reasoning_token_count);
  if(source==='claude-code'){// Anthropic's input excludes cache reads AND writes.
   if(input!==null&&cached!==null&&creation!==null)input=count(input+cached+creation);else input=null;
  }
  if(input!==null&&((cached||0)+(creation||0)>input))throw Error('Cached tokens exceed input tokens');
 }
 const request=text(a.request_id||a.response_id||a['response.id']);const call=text(a.tool_use_id||a.call_id);const sequence=a['event.sequence'];
 // Ignore export time and resource ordering: retrying the same record never charges twice.
 const identity=type==='usage'&&request?['usage',session,request]:['tool','tool_start'].includes(type)&&call?[type,session,call]:type==='child'&&a['subagent.id']?['child',session,a['subagent.id']]:[session,name,at,sequence??null,canonical(a)];
 const id=digest(JSON.stringify(identity));
 let signature=/^[a-f0-9]{64}$/.test(a['agentguard.input_hash']||'')?a['agentguard.input_hash']:null;const raw=a.tool_input??a.arguments;
 if(['tool','tool_start'].includes(type)&&raw!=null&&raw!==''&&!text(raw).includes('<REDACTED>')&&!/truncated|\.\.\.|…/i.test(text(raw))&&text(raw).length<4000&&!flag(a.tool_input_truncated)){let parsed=raw;try{if(typeof raw==='string')parsed=JSON.parse(raw);signature=digest(JSON.stringify(canonical(parsed)))}catch{}}
 const tool=['tool','tool_start'].includes(type)?text(a.tool_name).slice(0,160):'';
 let cost=0,basis='not_billable',pricing=null;
 if(type==='usage'){
  const micros=numeric(a.cost_usd_micros),usd=a.cost_usd_micros!=null?(micros===null?null:micros/1e6):numeric(a.cost_usd);
  const rates=config.prices&&Object.hasOwn(config.prices,model)?config.prices[model]:null;basis='unpriced';
  if(source==='claude-code'&&usd!==null&&Number.isFinite(usd)&&usd>=0&&config.usdToCny){cost=usd*config.usdToCny;basis='telemetry_estimate';pricing={reported_usd:usd,usd_to_cny:config.usdToCny};}
  else if(rates&&input!==null&&output!==null){const knownCached=cached??0,knownCreation=creation??0;const uncertain=cached===null||creation===null;const ordinaryRate=uncertain?Math.max(rates.input,rates.cached,rates.creation):rates.input;cost=((input-knownCached-knownCreation)*ordinaryRate+knownCached*rates.cached+knownCreation*rates.creation+output*rates.output)/1e6;basis='rate_estimate';pricing={...rates,unit:'CNY_per_million',assumption:uncertain?'未报告的缓存拆分按最高输入单价估算':null};}
  if(!Number.isFinite(cost)||cost<0)throw Error('Invalid cost');
 }else if(type==='error')basis='unpriced';
 let spawnedId;
 if(source==='codex'&&type==='tool'&&['spawn_agent','functions.spawn_agent'].includes(tool)&&!failed(a.success)){try{const result=JSON.parse(a.output);if(typeof result.agent_id==='string'&&result.agent_id)spawnedId=result.agent_id.slice(0,200)}catch{}}
 const childId=spawnedId|| (parent?session:type==='child'?text(a['subagent.id']||a.agent_id||'completed-'+id):undefined);
 return {id,at,source,provider:source==='claude-code'?'ANTHROPIC':'OPENAI',model,session_id:session,parent_id:parent,agent,kind:type,event_name:name,request_id:request||null,input_tokens:input,output_tokens:output,cached_tokens:cached,cache_creation_tokens:creation,reasoning_tokens:reasoning,cost,basis,pricing,duration_ms:count(a.duration_ms),error:type==='error'||failed(a.success),tool,signature,childId,loop_coverage:['tool','tool_start'].includes(type)?(signature?'arguments_hash':'missing_arguments'):null,child_coverage:spawnedId?'spawn_result':kind==='agentguard_child_start'?'start_hook':type==='child'?'completed_only':parent?'parent_link':null};
}

export function encodePartialSuccess(rejected){if(!rejected)return Buffer.alloc(0);const variable=n=>{const a=[];do{let b=n&127;n=Math.floor(n/128);if(n)b|=128;a.push(b)}while(n);return Buffer.from(a)};const message=Buffer.from('Some records have invalid timestamps, sessions or token counts');const inner=Buffer.concat([Buffer.from([8]),variable(rejected),Buffer.from([18]),variable(message.length),message]);return Buffer.concat([Buffer.from([10]),variable(inner.length),inner])}
