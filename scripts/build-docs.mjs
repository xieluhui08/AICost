import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../dist/',import.meta.url));
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function inline(s){
 const saved=[];const keep=html=>'\x00'+(saved.push(html)-1)+'\x00';
 s=s.replace(/`([^`]+)`/g,(_,v)=>keep('<code>'+escape(v)+'</code>'));
 s=s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,label,target)=>{
  if(!/^(https?:\/\/|[\w./#-]+$)/.test(target))return label;
  target=target.replace(/\b(CODING|DEPLOY)\.md(?=#|$)/,'$1.html');
  return keep('<a href="'+escape(target)+'">'+escape(label)+'</a>');
 });
 s=s.replace(/https?:\/\/[^\s<>\u0080-\uFFFF]+/g,url=>keep('<a href="'+escape(url)+'">'+escape(url)+'</a>'));
 return escape(s).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\x00(\d+)\x00/g,(_,i)=>saved[Number(i)]);
}
function render(markdown){
 const lines=markdown.split(/\r?\n/),html=[],toc=[];let title='',section=0;
 for(let i=0;i<lines.length;){const line=lines[i];if(!line.trim()){i++;continue}
  if(line.startsWith('```')){const code=[];i++;while(i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i++]);i++;html.push('<pre><code>'+escape(code.join('\n'))+'</code></pre>');continue}
  if(/^( {4}|\t)/.test(line)){const code=[];while(i<lines.length&&/^( {4}|\t)/.test(lines[i]))code.push(lines[i++].replace(/^( {4}|\t)/,''));html.push('<pre><code>'+escape(code.join('\n'))+'</code></pre>');continue}
  const heading=line.match(/^(#{1,4}) (.+)$/);if(heading){const level=heading[1].length,id='section-'+section++;if(level===1)title=heading[2];if(level===2)toc.push({id,label:heading[2]});html.push('<h'+level+' id="'+id+'">'+inline(heading[2])+'</h'+level+'>');i++;continue}
  if(line.startsWith('|')&&/^\|[\s:|-]+\|$/.test(lines[i+1]||'')){const cells=s=>s.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());const header=cells(line),rows=[];i+=2;while(i<lines.length&&lines[i].startsWith('|'))rows.push(cells(lines[i++]));html.push('<div class="table-scroll"><table><thead><tr>'+header.map(c=>'<th>'+inline(c)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>');continue}
  if(/^- /.test(line)){const items=[];while(i<lines.length&&/^- /.test(lines[i]))items.push(lines[i++].slice(2));html.push('<ul>'+items.map(x=>'<li>'+inline(x)+'</li>').join('')+'</ul>');continue}
  const paragraph=[line];i++;while(i<lines.length&&lines[i].trim()&&!/^(#{1,4} |```|- |\|| {4}|\t)/.test(lines[i]))paragraph.push(lines[i++]);html.push('<p>'+inline(paragraph.join('\n'))+'</p>');
 }
 return {title,toc,body:html.join('\n')};
}
for(const name of ['CODING','DEPLOY']){
 const file=root+name+'.md',markdown=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');
 // Also disambiguate encoding for browsers opening the original .md URL.
 fs.writeFileSync(file,'\uFEFF'+markdown,'utf8');
 const {title,toc,body}=render(markdown);
 fs.writeFileSync(root+name+'.html',`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · AgentGuard</title><meta name="description" content="AgentGuard 接入、部署与用量监测文档"><link rel="stylesheet" href="docs.css"></head>
<body><a class="skip" href="#content">跳转到文档</a><header><a class="brand" href="index.html">AgentGuard <span>/ 文档</span></a><nav aria-label="文档导航"><a href="CODING.html" ${name==='CODING'?'aria-current="page"':''}>编码工具接入</a><a href="DEPLOY.html" ${name==='DEPLOY'?'aria-current="page"':''}>私有部署</a><a href="index.html#coding">返回控制台 ↗</a></nav></header><div class="layout"><aside aria-label="本页目录"><span class="eyebrow">本页内容</span><nav>${toc.map(x=>'<a href="#'+x.id+'">'+escape(x.label)+'</a>').join('')}</nav><a class="download" href="${name}.md" download>下载 Markdown ↓</a></aside><main id="content"><article>${body}</article><footer>AgentGuard 文档 · <a href="index.html#coding">返回编码工具</a></footer></main></div></body></html>\n`,'utf8');
}
console.log('Built UTF-8 HTML documentation and encoded Markdown downloads.');
