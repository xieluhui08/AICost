import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {projectRoot} from './setup-local.mjs';
import {localEnvironment} from './start-local.mjs';

export async function diagnose({root=projectRoot,inherited=process.env,checkServer=false,checkClients=true}={}){
 const result={node:process.versions.node,configuration:'missing',environmentPermissions:null,keys:{},providers:{},clients:{},server:{checked:false},errors:[]};let env;
 try{env=localEnvironment(root,inherited);result.configuration='ready';const stat=fs.statSync(path.join(root,'.env'));result.environmentPermissions=(stat.mode&0o777).toString(8);if(process.platform!=='win32'&&(stat.mode&0o077))result.errors.push('.env 可被其他本机用户读取，请执行 chmod 600 .env');}catch(error){result.errors.push(error.message)}
 for(const key of ['ADMIN_KEY','INGEST_KEY','READ_KEY','CONFIG_ENCRYPTION_KEY'])result.keys[key]=key==='CONFIG_ENCRYPTION_KEY'?/^[a-f\d]{64}$/i.test(env?.[key]||''):!!env?.[key];
 if(env&&!result.keys.CONFIG_ENCRYPTION_KEY){result.configuration='invalid';result.errors.push('CONFIG_ENCRYPTION_KEY 缺失或不是 64 位十六进制；网页配置无法加密保存。已有账本时请恢复原密钥。');}
 for(const id of ['DEEPSEEK','QWEN','KIMI','DOUBAO','MINIMAX']){result.providers[id]=['BASE_URL','API_KEY','MODEL','INPUT_CNY_PER_M','OUTPUT_CNY_PER_M'].every(k=>env?.[id+'_'+k]!==undefined&&env?.[id+'_'+k]!=='')?'environment-configured':'not-in-environment (may be saved in database)';}
 if(checkClients)for(const cli of ['claude','codex']){const found=spawnSync(cli,['--version'],{encoding:'utf8',timeout:3000,windowsHide:true});result.clients[cli]={available:!found.error&&found.status===0,version:!found.error&&found.status===0?(found.stdout?.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0]||'unknown'):null};}
 if(checkServer&&env){const host=env.HOST==='0.0.0.0'?'127.0.0.1':env.HOST==='::'?'[::1]':env.HOST==='::1'?'[::1]':env.HOST;const base='http://'+host+':'+env.PORT;result.server={checked:true,reachable:false,authenticated:false};try{
   const response=await fetch(base+'/api/session',{headers:{authorization:'Bearer '+env.ADMIN_KEY},redirect:'error',signal:AbortSignal.timeout(3000)});
   result.server.reachable=true;const type=response.headers.get('content-type')||'';if(!response.ok||!type.includes('application/json'))throw Error('unexpected response');const body=await response.json();result.server.authenticated=body.canManage===true;if(!result.server.authenticated)throw Error('permission mismatch');
   const integrations=await fetch(base+'/api/integrations',{headers:{authorization:'Bearer '+env.ADMIN_KEY},redirect:'error',signal:AbortSignal.timeout(3000)});if(integrations.ok){const data=await integrations.json();result.server.integrations=(data.integrations||[]).map(c=>({id:c.id,enabled:!!c.enabled,origin:c.origin,verified:c.verification?.ok===true}));}
  }catch{result.errors.push('本机服务未启动、认证失败或接口版本不匹配；请先运行 start:local。');}}
 return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const unknown=process.argv.slice(2).filter(x=>!['--check-server','--no-clients'].includes(x));
 if(unknown.length){console.error('用法：node scripts/doctor.mjs [--check-server] [--no-clients]');process.exitCode=1;}else{const result=await diagnose({checkServer:process.argv.includes('--check-server'),checkClients:!process.argv.includes('--no-clients')});console.log(JSON.stringify(result,null,2));if(result.errors.length)process.exitCode=1;}
}
