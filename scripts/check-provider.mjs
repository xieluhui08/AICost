import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseEnv} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Real suppliers require explicit CLI opt-in. Tests exercise only loopback mocks.
export async function checkProvider({base='http://127.0.0.1:8080',admin,ingest,provider,budget=.1,confirm=false,request=fetch}){
  if(!confirm)throw Error('此操作会调用真实模型并可能产生费用；请显式添加 --confirm-paid-request。');
  const origin=new URL(base);
  if(!['http:','https:'].includes(origin.protocol)||!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('仅允许本机 AgentGuard origin，例如 http://127.0.0.1:8080');
  if(!['DEEPSEEK','QWEN','KIMI','DOUBAO','MINIMAX'].includes(provider))throw Error('请选择 DEEPSEEK、QWEN、KIMI、DOUBAO 或 MINIMAX');
  if(!admin||!ingest)throw Error('请先运行 setup:local 并配置访问密钥');
  if(!Number.isFinite(budget)||budget<=0||budget>1)throw Error('联调预算需大于 0 且不超过 1 元');
  const api=async(route,{method='GET',body,key=admin,headers={}}={})=>{
    const res=await request(origin.origin+route,{method,redirect:'error',headers:{authorization:'Bearer '+key,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(70000)});
    if(!(res.headers.get('content-type')||'').includes('application/json'))throw Error('本机地址未提供 AgentGuard API');
    const data=await res.json();return{ok:res.ok,status:res.status,data};
  };
  const listed=await api('/api/integrations');if(!listed.ok)throw Error('无法读取本机配置，请检查服务及 ADMIN_KEY');
  const cfg=listed.data.integrations.find(c=>c.id===provider);
  if(!cfg?.enabled||!cfg.hasSecret?.API_KEY)throw Error('请先在接入中心启用供应商并保存 API Key');
  const input=Number(cfg.values.INPUT_CNY_PER_M),output=Number(cfg.values.OUTPUT_CNY_PER_M),cached=cfg.values.CACHE_INPUT_CNY_PER_M===''||cfg.values.CACHE_INPUT_CNY_PER_M==null?input:Number(cfg.values.CACHE_INPUT_CNY_PER_M);
  if(!cfg.values.MODEL||[cfg.values.INPUT_CNY_PER_M,cfg.values.OUTPUT_CNY_PER_M].some(v=>v==null||String(v).trim()==='')||![input,output,cached].every(v=>Number.isFinite(v)&&v>=0))throw Error('主模型及输入、输出单价必须完整且有效');
  const messages=[{role:'user',content:'Reply with OK only.'}],max_tokens=16;
  const reserve=(Buffer.byteLength(JSON.stringify(messages))*Math.max(input,cached)+max_tokens*output)/1e6;
  if(reserve>budget)throw Error('按已配置单价估算的调用预留超过联调预算；已取消，不发送模型请求');
  const id='local-probe-'+crypto.randomUUID();
  const created=await api('/api/tasks',{method:'POST',key:ingest,body:{id,policy:'research',budget,customer:'本机联调',feature:'供应商连通性'}});
  if(!created.ok)throw Error('创建联调任务失败，请确认后端已更新');
  let result;
  try{
    result=await api('/v1/chat/completions',{method:'POST',key:ingest,headers:{'x-task-id':id,'x-provider':provider.toLowerCase()},body:{messages,max_tokens}});
    if(!result.ok)throw Error('供应商调用失败（HTTP '+result.status+'）；任务 '+id+' 已保留用于核对，请查看任务追踪和用量历史。');
    const decision=await api('/api/tasks/'+id+'/decision',{key:ingest});
    if(!decision.ok)throw Error('调用后无法读取决策，请人工核对本次用量');
    if(decision.data.decision==='allow'){
      const finished=await api('/api/tasks/'+id+'/finish',{method:'POST',key:ingest,body:{status:'success'}});
      if(!finished.ok)throw Error('调用成功但任务未能结束，请在任务追踪核对');
    }
    return {task_id:id,provider,model:result.data.model||cfg.values.MODEL,budget,cost:decision.data.cost,decision:decision.data.decision,usage:result.data.usage??null,warning:result.data.agentguard_warning||null};
  }catch(error){
    // Stop future work, but retain any in-flight reservation and billing evidence.
    try{await api('/api/tasks/'+id+'/stop',{method:'POST',body:{}})}catch{}
    throw error;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),value=flag=>{const at=args.indexOf(flag);return at<0?undefined:args[at+1]};
  try{
    const env={...(fs.existsSync(path.join(root,'.env'))?parseEnv(fs.readFileSync(path.join(root,'.env'),'utf8')):{}),...process.env};
    const result=await checkProvider({base:env.AG_URL||'http://127.0.0.1:'+(env.PORT||8080),admin:env.ADMIN_KEY,ingest:env.INGEST_KEY,provider:(value('--provider')||'').toUpperCase(),budget:Number(value('--budget')||'.1'),confirm:args.includes('--confirm-paid-request')});
    console.log(JSON.stringify(result,null,2));console.log('请在任务追踪与用量历史核对该任务；记录成本为估算，不是供应商最终账单。');
  }catch(error){console.error(error.name==='TimeoutError'?'联调超时，请在本机账本和供应商侧核对是否已计费。':error.message);process.exitCode=1}
}
