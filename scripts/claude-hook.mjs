#!/usr/bin/env node
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const canonical=x=>x&&typeof x==='object'?(Array.isArray(x)?x.map(canonical):Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]))):x;
export function hookEnvelope(input){
 if(!['PreToolUse','SubagentStart'].includes(input.hook_event_name)||!input.session_id)throw Error('Unsupported hook input');
 const child=input.hook_event_name==='SubagentStart';
 if(child&&!input.agent_id||!child&&!input.tool_use_id)throw Error('Missing stable hook identifier');
 const attrs={'event.name':child?'claude_code.agentguard_child_start':'claude_code.agentguard_tool_start','event.timestamp':new Date().toISOString(),'session.id':input.session_id,'agent.id':input.agent_id||input.session_id,tool_use_id:input.tool_use_id||'',tool_name:input.tool_name||'',...(child?{'subagent.id':input.agent_id}:{'agentguard.input_hash':crypto.createHash('sha256').update(JSON.stringify(canonical(input.tool_input||{}))).digest('hex')})};
 return {resourceLogs:[{scopeLogs:[{logRecords:[{attributes:Object.entries(attrs).map(([key,value])=>({key,value:{stringValue:value}}))}]}]}]};
}
export async function runHook(input,env=process.env){
 const base=new URL(env.AG_GUARD_ORIGIN||'http://127.0.0.1:8080');if(base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('Guard URL must be an origin without credentials or path');if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))throw Error('Remote guard must use HTTPS');
 if(!/^conn-[a-zA-Z0-9-]+$/.test(env.AG_GUARD_CONNECTION||'')||!env.AG_GUARD_TOKEN)throw Error('Guard connection not configured');
 const root=base.origin+'/api/telemetry/'+env.AG_GUARD_CONNECTION;
 const request=async(p,payload)=>{const r=await fetch(root+p,{redirect:'error',method:payload?'POST':'GET',headers:{authorization:'Bearer '+env.AG_GUARD_TOKEN,'content-type':'application/json'},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('Guard unavailable');return r.json()};
 const result=await request('/v1/logs',hookEnvelope(input));if(result.rejected)throw Error('Hook telemetry rejected');
 const d=await request('/decision');return d.decision==='allow'||d.decision==='observe'?{}:{continue:false,stopReason:'AgentGuard：运行预算或风险策略要求停止，等待人工处理。'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{let data='';for await(const c of process.stdin){data+=c;if(Buffer.byteLength(data)>1048576)throw Error('Hook input too large')}const input=JSON.parse(data);const result=await runHook(input);console.log(JSON.stringify(result));}catch{console.error('AgentGuard 无法确认运行策略，阻止本次工具调用。');process.exitCode=2}}
