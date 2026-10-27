import './build-docs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=['README.md','LOCAL-SETUP.md','TESTING.md','RELEASE-QA.md','package.json','package-lock.json','Dockerfile','compose.yaml','.dockerignore','.gitignore','.nvmrc','.env.example',...fs.readdirSync(root).filter(f=>f.endsWith('.mjs')),...fs.readdirSync(path.join(root,'dist')).filter(f=>/\.(html|css|mjs|md)$/.test(f)).map(f=>'dist/'+f),...fs.readdirSync(path.join(root,'scripts')).filter(f=>/\.(mjs|sh)$/.test(f)).map(f=>'scripts/'+f),...fs.readdirSync(path.join(root,'.github/workflows')).filter(f=>f.endsWith('.yml')).map(f=>'.github/workflows/'+f)];
for(const f of files)if(!fs.lstatSync(path.join(root,f)).isFile())throw Error('Only regular source files are allowed: '+f);
execFileSync('tar',['-czf',path.join(root,'dist/agentguard-source.tar.gz'),...files.sort()],{cwd:root});console.log('Packaged '+files.length+' source files. No credentials, runtime data or repository metadata.');
