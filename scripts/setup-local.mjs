import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const projectRoot=fileURLToPath(new URL('../',import.meta.url));
export function requireNode(version=process.versions.node){const [major,minor]=version.split('.').map(Number);if(!Number.isInteger(major)||!Number.isInteger(minor)||major<20||(major===20&&minor<19))throw Error('需要 Node.js 20.19 或更新版本');}
export function setupLocal(root=projectRoot){
 requireNode();root=path.resolve(root);const target=path.join(root,'.env');
 if(fs.existsSync(target)){if(!fs.lstatSync(target).isFile())throw Error('.env 必须是普通文件，不能是目录或符号链接');return {created:false,path:target};}
 // A regenerated encryption key could lock existing configuration permanently.
 if(fs.existsSync(path.join(root,'data','agentguard.sqlite')))throw Error('已有账本但缺少 .env，请恢复原配置与 CONFIG_ENCRYPTION_KEY，不要重新生成密钥');
 const template=fs.readFileSync(path.join(root,'.env.example'),'utf8'),keys=['ADMIN_KEY','INGEST_KEY','READ_KEY','CONFIG_ENCRYPTION_KEY'],seen=new Set();let contents=template;
 for(const key of keys){let value;do{value=crypto.randomBytes(32).toString('hex')}while(seen.has(value));seen.add(value);const pattern=new RegExp('^'+key+'=.*$','m');if(!pattern.test(contents))throw Error('.env.example 缺少 '+key);contents=contents.replace(pattern,key+'='+value);}
 contents+='\n# Local-first defaults. Set HOST explicitly only when exposing the service intentionally.\nHOST=127.0.0.1\nNODE_ENV=development\n';
 fs.writeFileSync(target,contents,{encoding:'utf8',flag:'wx',mode:0o600});
 return {created:true,path:target};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{const result=setupLocal();console.log(result.created?'已创建私有 .env（权限 600），访问密钥已生成。':'已有 .env，保留原配置和密钥。');console.log('用本机编辑器打开 .env，将 ADMIN_KEY 的值复制到网页登录框。');console.log('下一步：npm run doctor，然后 npm run start:local。');}catch{console.error('本机初始化失败。请检查 Node.js 版本、目录权限和 .env；已有账本时应恢复原配置，不能重新生成加密密钥。');process.exitCode=1;}
}
