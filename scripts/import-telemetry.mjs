#!/usr/bin/env node
import fs from 'node:fs';
const [connection,file]=process.argv.slice(2);
try{
 if(!/^conn-[a-zA-Z0-9-]+$/.test(connection||'')||!file||!process.env.AG_CONNECTION_TOKEN)throw Error('用法：设置 AG_URL、AG_CONNECTION_TOKEN 后，node scripts/import-telemetry.mjs conn-ID 历史OTLP.json');
 const stat=fs.statSync(file);if(!stat.isFile()||stat.size>1048576)throw Error('每批文件需不超过 1 MB');
 const base=new URL(process.env.AG_URL||'http://127.0.0.1:8080');if(base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('AG_URL 必须为不含账号或路径的服务端 origin');if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))throw Error('远程服务必须使用 HTTPS');
 const data=fs.readFileSync(file,'utf8');JSON.parse(data);
 const r=await fetch(base.origin+'/api/telemetry/'+connection+'/v1/logs?historical=1',{redirect:'error',method:'POST',headers:{authorization:'Bearer '+process.env.AG_CONNECTION_TOKEN,'content-type':'application/json'},body:data,signal:AbortSignal.timeout(15000)});const result=await r.json();if(!r.ok)throw Error(result.error||'导入失败');console.log(JSON.stringify(result,null,2));if(result.rejected)process.exitCode=2;
}catch(e){console.error(e.message);process.exitCode=1}
