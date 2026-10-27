import fs from 'node:fs';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {projectRoot,requireNode} from './setup-local.mjs';

export function localEnvironment(root=projectRoot,inherited=process.env){
 requireNode();const filename=path.join(root,'.env');
 if(!fs.existsSync(filename)||!fs.lstatSync(filename).isFile())throw Error('请先运行 npm run setup:local；.env 必须是普通文件');
 const file=parseEnv(fs.readFileSync(filename,'utf8')),env={...file,...inherited};
 env.HOST=inherited.HOST??file.HOST??'127.0.0.1';env.PORT=inherited.PORT??file.PORT??'8080';
 if(!/^\d+$/.test(env.PORT)||Number(env.PORT)<1||Number(env.PORT)>65535)throw Error('PORT 必须为 1–65535');
 if(!['127.0.0.1','localhost','::1','0.0.0.0','::'].includes(env.HOST))throw Error('HOST 使用明确的本机或监听地址');
 for(const key of ['ADMIN_KEY','INGEST_KEY','READ_KEY'])if(!env[key]||env[key].length<32)throw Error(key+' 需要至少 32 个字符，请先完成本机初始化');
 if(new Set(['ADMIN_KEY','INGEST_KEY','READ_KEY'].map(k=>env[k])).size!==3)throw Error('三个访问密钥必须不同');
 return env;
}
export function startLocal({root=projectRoot,inherited=process.env,stdio='inherit'}={}){
 const env=localEnvironment(root,inherited);
 // Anchor the working directory so SQLite always opens this project's data/.
 return spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,env,stdio});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{const env=localEnvironment();const host=['::1','::'].includes(env.HOST)?'['+env.HOST+']':env.HOST;console.log('打开 http://'+host+':'+env.PORT+'；Ctrl+C 停止本机服务。');const child=startLocal();
  const forward=signal=>{if(!child.killed)child.kill(signal)},interrupt=()=>forward('SIGINT'),terminate=()=>forward('SIGTERM');process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  child.once('error',()=>{console.error('无法启动 Node 服务，请检查运行环境。');process.exitCode=1});child.once('exit',(code,signal)=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);process.exitCode=code??(signal?1:0)});
 }catch(error){console.error('本机启动失败：'+error.message);process.exitCode=1;}
}
