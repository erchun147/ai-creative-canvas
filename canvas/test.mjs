import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-canvas-test-'));
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const profile=path.join(dir,'profile.json');
fs.writeFileSync(profile,JSON.stringify({schema:1,name:'youkou-media-creator',user_id:1,token_id:1,base_url:'https://api.example.test/v1'}),{mode:0o600});
fs.writeFileSync(path.join(dir,'credentials.json'),'{}',{mode:0o600});
let child, token;
const origin='http://127.0.0.1:'+port;
async function start(){
 child=spawn(process.execPath,[path.join(root,'serve.mjs')],{env:{...process.env,PORT:String(port),CANVAS_DATA_DIR:dir,CANVAS_PROFILE:profile},stdio:'pipe'});
 for(let i=0;i<100;i++){try{if((await fetch(origin+'/healthz')).ok){token=JSON.parse(fs.readFileSync(path.join(dir,'control.json'))).token;return;}}catch{}await new Promise(r=>setTimeout(r,25));}
 throw Error('本地服务启动超时');
}
async function request(route,body,headers={}){
 const r=await fetch(origin+'/local/v1'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
 return {status:r.status,value:await r.json()};
}
const command=(id,type,more={})=>({protocol:1,id,project_id:'project_one',type,...more});
await start();
test.after(async()=>{try{await fetch(origin+'/local/v1/server',{method:'DELETE',headers:{Authorization:'Bearer '+token}});}catch{}if(child?.exitCode===null)await new Promise(r=>child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});
const image={id:'image_one',type:'image',position:{x:440,y:40},data:{title:'SVG',orig:'https://example.test/a.svg',t480:'https://example.test/a.svg'}};
test('本机接口创建项目并持久保存',async()=>{const a=await request('/commands',command('new_one','project.create',{name:'演示项目'}));assert.equal(a.status,200);assert.equal((await request('/projects/project_one')).value.name,'演示项目');assert.equal(fs.existsSync(path.join(dir,'state.json')),true);});
test('同命令幂等，内容变化不能复用ID',async()=>{assert.equal((await request('/commands',command('new_one','project.create',{name:'演示项目'}))).value.duplicate,true);assert.equal((await request('/commands',command('new_one','project.create',{name:'其它名称'}))).status,400);});
test('提示词连接图片，参考图片连接视频',async()=>{assert.equal((await request('/commands',command('image_task','generation.record',{task_id:'101',prompt:'画一张图',outputs:[image]}))).status,200);const c=command('video_task','generation.record',{task_id:'102',prompt:'让它动起来',references:[image],outputs:[{id:'video_one',type:'video',position:{x:880,y:40},data:{title:'视频',src:'https://example.test/video.mp4'}}]});assert.equal((await request('/commands',c)).status,200);const p=(await request('/projects/project_one')).value;assert.deepEqual(p.edges.map(e=>[e.source,e.target]),[['task_101_p','image_one'],['image_one','video_one']]);assert.equal(p.nodes.length,4);});
test('一键按连线和网格布局，只改变位置',async()=>{const before=(await request('/projects/project_one')).value;await request('/commands',command('arrange_links','graph.arrange',{layout:'storyboard'}));let p=(await request('/projects/project_one')).value;assert.equal(p.nodes.find(n=>n.id==='video_one').position.x,840);assert.deepEqual(p.edges,before.edges);assert.deepEqual(p.nodes.map(n=>n.data),before.nodes.map(n=>n.data));await request('/commands',command('arrange_grid','graph.arrange',{layout:'grid',columns:2}));p=(await request('/projects/project_one')).value;assert.deepEqual(p.nodes[2].position,{x:40,y:280});});
test('过期revision拒绝，不能覆盖新修改',async()=>{const old=(await request('/projects/project_one')).value;assert.equal((await request('/commands',command('stale_edit','graph.replace',{expected_revision:old.revision-1,nodes:[],edges:[]}))).status,400);assert.equal((await request('/projects/project_one')).value.nodes.length,4);});
test('无令牌、异站Origin、伪造Host与目录穿越拒绝',async()=>{assert.equal((await request('/projects',null,{Authorization:''})).status,401);assert.equal((await fetch(origin+'/local/v1/session',{headers:{Origin:'https://evil.example'}})).status,403);assert.equal(await new Promise((resolve,reject)=>http.get(origin+'/local/v1/session',{headers:{Host:'evil.example:'+port}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject)),403);assert.notEqual((await fetch(origin+'/%2e%2e%2fpackage.json')).status,200);});
test('JavaScript地址、保留属性名、无效端点不进入项目',async()=>{assert.equal((await request('/commands',command('bad_url','generation.record',{task_id:'103',outputs:[{...image,data:{orig:'javascript:alert(1)'}}]}))).status,400);assert.equal((await request('/commands',{...command('bad_id','project.create'),project_id:'__proto__'})).status,400);assert.equal((await request('/commands',command('bad_edge','graph.replace',{nodes:[image],edges:[{id:'bad',source:'missing',target:'image_one'}]}))).status,400);});
test('SVG与GIF本机资产保留原格式，SVG沙箱禁脚本',async()=>{for(const [id,type,bytes]of[['svg_asset','image/svg+xml','<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>alert(1)</script><rect width="40" height="40" fill="red"/></svg>'],['gif_asset','image/gif',Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')]]){const r=await fetch(origin+'/local/v1/assets/'+id+'/orig',{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':type},body:bytes});assert.equal(r.status,200);const get=await fetch(origin+'/local/v1/assets/'+id+'/orig');assert.equal(get.headers.get('content-type'),type);assert.equal(Buffer.from(await get.arrayBuffer()).equals(Buffer.from(bytes)),true);if(type==='image/svg+xml')assert.ok(get.headers.get('content-security-policy').includes('sandbox'));}});
test('并发修订竞争只接受一个写入',async()=>{const p=(await request('/projects/project_one')).value;const all=await Promise.all(['a','b'].map(i=>request('/commands',command('concurrent_'+i,'graph.arrange',{layout:'grid',expected_revision:p.revision}))));assert.deepEqual(all.map(v=>v.status).sort(),[200,400]);});
test('正常重启后项目和素材仍存在，旧控制令牌失效',async()=>{const old=token;const exited=new Promise(r=>child.once('exit',r));await fetch(origin+'/local/v1/server',{method:'DELETE',headers:{Authorization:'Bearer '+token}});await exited;const legacy=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));legacy.receipts.new_one.input=JSON.stringify(command('new_one','project.create',{name:'演示项目'}));fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify(legacy));await start();assert.equal((await request('/commands',command('new_one','project.create',{name:'演示项目'}))).value.duplicate,true);assert.notEqual(token,old);assert.equal((await request('/projects/project_one')).value.nodes.length,4);assert.equal((await fetch(origin+'/local/v1/assets/svg_asset/orig')).status,200);assert.equal((await request('/projects',null,{Authorization:'Bearer '+old})).status,401);});
