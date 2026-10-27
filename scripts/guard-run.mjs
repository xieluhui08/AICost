#!/usr/bin/env node
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

function guardOrigin(base){
 const url=new URL(base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('AG_URL 必须为无路径的服务端 origin');
 if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('远程连接必须使用 HTTPS');
 return url.origin;
}
export function clientConfig(source,base,connection,token,env=process.env){
 if(!['claude-code','codex'].includes(source))throw Error('不支持的编码工具');
 const origin=guardOrigin(base),endpoint=origin+'/api/telemetry/'+connection+'/v1/logs';
 const next={...env};for(const k of ['ADMIN_KEY','INGEST_KEY','READ_KEY','CONFIG_ENCRYPTION_KEY','AG_CONNECTION_TOKEN','AG_ADMIN_KEY','AG_GUARD_ORIGIN','AG_GUARD_CONNECTION','AG_GUARD_TOKEN','AG_OTEL_AUTH'])delete next[k];
 // Keep only this run's export; never capture prompt/response bodies.
 Object.assign(next,{OTEL_METRICS_EXPORTER:'none',OTEL_TRACES_EXPORTER:'none',OTEL_LOGS_EXPORTER:'otlp',OTEL_EXPORTER_OTLP_PROTOCOL:'http/protobuf',OTEL_EXPORTER_OTLP_LOGS_PROTOCOL:'http/protobuf',OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:endpoint,OTEL_EXPORTER_OTLP_HEADERS:'Authorization=Bearer '+token,OTEL_EXPORTER_OTLP_LOGS_HEADERS:'Authorization=Bearer '+token,OTEL_LOGS_EXPORT_INTERVAL:'1000',OTEL_BSP_SCHEDULE_DELAY:'1000',OTEL_LOG_USER_PROMPTS:'0',OTEL_LOG_ASSISTANT_RESPONSES:'0',OTEL_LOG_RAW_API_BODIES:'0'});
 delete next.BETA_TRACING_ENDPOINT;delete next.CLAUDE_CODE_ENABLE_TELEMETRY;
 if(source==='claude-code'){next.CLAUDE_CODE_ENABLE_TELEMETRY='1';Object.assign(next,{AG_GUARD_ORIGIN:origin,AG_GUARD_CONNECTION:connection,AG_GUARD_TOKEN:token});const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";const command=quote(process.execPath)+' '+quote(fileURLToPath(new URL('./claude-hook.mjs',import.meta.url)));const hooks=Object.fromEntries(['PreToolUse','SubagentStart'].map(name=>[name,[{hooks:[{type:'command',command,timeout:10}]}]]));return{env:next,args:['--settings',JSON.stringify({hooks})],hooks:true}}
 next.AG_OTEL_AUTH='Bearer '+token;
 return{env:next,args:['-c','otel.log_user_prompt=false','-c','otel.exporter={ otlp-http = { endpoint = '+JSON.stringify(endpoint)+', protocol = "binary", headers = { Authorization = "${AG_OTEL_AUTH}" } } }']};
}
export async function guardRun({base,connection,token,command,args=[],env=process.env,pollMs=500,killMs=2000,maxSilenceMs=120000,maxRuntimeMs=900000,expectedSource=null,hooks=false,stdio='inherit',onMessage=console.error}){
 if(process.platform==='win32')throw Error('本机启动器目前支持 macOS / Linux');
 if(!/^conn-[a-zA-Z0-9-]+$/.test(connection)||!token)throw Error('需要连接 ID 和 AG_CONNECTION_TOKEN');
 const root=guardOrigin(base)+'/api/telemetry/'+connection,runner=crypto.randomUUID();
 const api=async(path,data)=>{const r=await fetch(root+'/'+path,{redirect:'error',method:data?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(3000)});const result=await r.json();if(!r.ok)throw Error(result.error||'服务端连接失败');return result};
 const initial=await api('decision');if(expectedSource&&initial.source!==expectedSource)throw Error('客户端与连接工具不匹配');if(initial.mode!=='managed'||initial.decision!=='allow')throw Error('仅可运行已允许的托管连接；请先处理停止或审批状态');
 await api('heartbeat',{runner,state:'starting',hooks});
 const child=spawn(command,args,{env,stdio,detached:true});
 const started=Date.now();let reason='',exited=false,exitCode=null,lastTelemetry=started,killer;
 const kill=signal=>{if(!child.pid)return;try{process.kill(-child.pid,signal)}catch(e){if(e.code!=='ESRCH')throw e}};
 const stop=r=>{if(reason)return;reason=r;onMessage('AgentGuard：'+r+'，正在停止此启动器的进程组。');kill('SIGTERM');killer=setTimeout(()=>kill('SIGKILL'),killMs)};
 const onSignal=()=>stop('收到终端中断');process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
 const completion=new Promise(resolve=>{child.once('exit',(code)=>{exited=true;exitCode=code;resolve()});child.once('error',()=>{exited=true;exitCode=1;reason='无法启动客户端';resolve()})});
 let lastHeartbeat=0;
 const poll=async()=>{while(!exited&&!reason){try{const d=await api('decision');if(exited)break;if(d.decision!=='allow'){stop(d.decision==='approval'?'预算或异常等待人工确认':'预算、异常或人工停止');break}if(d.last_received)lastTelemetry=Math.max(lastTelemetry,Date.parse(d.last_received));if(Date.now()-lastTelemetry>maxSilenceMs){stop('遥测长时间无有效数据，保护性停止');break}if(Date.now()-started>maxRuntimeMs){stop('超过最长运行时间');break}if(Date.now()-lastHeartbeat>2000){await api('heartbeat',{runner,state:'running'});lastHeartbeat=Date.now()}}catch{stop('无法确认服务端策略，保护性停止');break}await new Promise(r=>setTimeout(r,pollMs))}};
 const polling=poll();await completion;await polling;
 // Kill descendants even if their parent exited on TERM. This group was created by us.
 if(killer){await new Promise(r=>setTimeout(r,killMs));clearTimeout(killer);kill('SIGKILL')}
 else {kill('SIGTERM');await new Promise(r=>setTimeout(r,Math.min(killMs,250)));kill('SIGKILL')}
 process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);
 try{await api('heartbeat',{runner,state:reason?'stopped':exitCode===0?'completed':'failed',reason})}catch{onMessage('AgentGuard：进程已退出，但服务端尚未确认最终状态。')}
 return{code:reason?75:exitCode??1,reason};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const args=process.argv.slice(2),separator=args.indexOf('--'),connection=args[args.indexOf('--connection')+1],command=args[separator+1],clientArgs=args.slice(separator+2);
  if(separator<0||!args.includes('--connection')||!['claude','codex'].includes(command))throw Error('用法：node scripts/guard-run.mjs --connection conn-ID -- claude -p "任务" 或 -- codex exec "任务"');
  if(command==='claude'&&!clientArgs.some(x=>['-p','--print'].includes(x))||command==='codex'&&clientArgs[0]!=='exec')throw Error('请使用非交互模式：claude -p 或 codex exec');
  const base=process.env.AG_URL||'http://127.0.0.1:8080',token=process.env.AG_CONNECTION_TOKEN,source=command==='claude'?'claude-code':'codex';const cfg=clientConfig(source,base,connection,token);
  const result=await guardRun({base,connection,token,command,args:[...cfg.args,...clientArgs],env:cfg.env,hooks:cfg.hooks,expectedSource:source});process.exitCode=result.code;
 }catch(e){console.error('AgentGuard：'+e.message);process.exitCode=1}
}
