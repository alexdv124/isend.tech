import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,stat,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {TransferJournal,sanitizeEvent} from '../telemetry.mjs';
import {createApp} from '../server.mjs';
const key=()=>randomBytes(24).toString('hex');
const event=(extra={})=>({event:'sample',session:key(),seq:1,clientAt:Date.now(),elapsedMs:5,...extra});
async function directory(t){const dir=await mkdtemp(join(tmpdir(),'isend-log-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function lines(dir){return (await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.jsonl')).sort().map(n=>readFile(join(dir,n),'utf8')))).join('').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));}
test('server allowlist strips sensitive and arbitrary fields at every level',()=>{
 const r=sanitizeEvent(event({name:'passport.pdf',text:'private',sdp:'v=0 secret',identity:key(),room:key(),stack:'private',message:'passport.pdf',error:'private',path:{local:'host',remote:'relay',protocol:'udp',address:'192.168.1.2',credential:'secret',localAddress:'private'},total:100,offset:0,receivedLength:-262144,hashValid:true}));
 assert.deepEqual(r.path,{local:'host',remote:'relay',localAddress:'private',protocol:'udp'});
 const s=JSON.stringify(r);for(const text of ['passport','private"','secret','192.168','credential','identity','room','stack'])if(text!=='private"')assert.equal(s.includes(text),false,text);
 assert.equal(r.total,100);assert.equal(r.offset,0);assert.equal(r.receivedLength,-262144);assert.equal(r.hashValid,true);
 for(const value of [null,[],event({event:'anything'}),event({session:'bad'}),event({seq:-1})])assert.throws(()=>sanitizeEvent(value),e=>e.status===400);
 assert.equal(sanitizeEvent(event({bytesPerSecond:Infinity})).bytesPerSecond,undefined);
});
test('journal persists across restart with server timestamps, private modes and bounded segments',async t=>{
 const dir=await directory(t),now=Date.parse('2026-10-12T12:00:00Z'),device=key();
 let j=new TransferJournal({directory:dir,now:()=>now,segmentBytes:700,maxBytes:2000});
 for(let i=0;i<12;i++)await j.append('identity',device,[event({seq:i+1})]);
 const files=await readdir(dir);assert.ok(files.length>1);assert.ok((await Promise.all(files.map(n=>stat(join(dir,n))))).reduce((n,s)=>n+s.size,0)<=2000);
 assert.equal((await stat(dir)).mode&0o777,0o700);for(const n of files)assert.equal((await stat(join(dir,n))).mode&0o777,0o600);
 j=new TransferJournal({directory:dir,now:()=>now,segmentBytes:700,maxBytes:2000});await j.append('identity',device,[event({event:'complete'})]);
 const last=(await lines(dir)).at(-1);assert.equal(last.receivedAt,'2026-10-12T12:00:00.000Z');assert.equal(last.device,device.slice(0,12));assert.equal(last.event,'complete');
});
test('retention removes old days even when no transfers are arriving',async t=>{
 const dir=await directory(t);let now=Date.parse('2026-10-01T12:00:00Z');const j=new TransferJournal({directory:dir,now:()=>now});
 await j.append('a',key(),[event()]);now+=8*86400000;await j.sweep();assert.deepEqual(await readdir(dir),[]);
});
test('rate and queue limits reject floods; write failures do not wedge the queue',async t=>{
 const dir=await directory(t);let now=1000000;const j=new TransferJournal({directory:dir,now:()=>now,perIdentity:2,globalLimit:3});
 await j.append('a',key(),[event(),event()]);assert.throws(()=>j.append('a',key(),[event()]),e=>e.status===429);
 await j.append('b',key(),[event()]);assert.throws(()=>j.append('c',key(),[event()]),e=>e.status===429);
 now+=60001;await j.append('a',key(),[event()]);
 assert.throws(()=>j.append('a',key(),Array.from({length:17},()=>event())),e=>e.status===400);
 const bad=join(dir,'not-a-directory');await writeFile(bad,'x');const broken=new TransferJournal({directory:bad});await assert.rejects(broken.append('a',key(),[event()]));assert.equal(broken.pendingBytes,0);
 broken.directory=join(dir,'fixed');await broken.append('a',key(),[event()]);assert.equal((await lines(broken.directory)).length,1);
 assert.throws(()=>new TransferJournal().append('a',key(),[event()]),e=>e.status===503);
});
test('HTTP log endpoint requires registered identity, cannot read logs, strips content',async t=>{
 const dir=await directory(t),server=await createApp({env:{DIAGNOSTICS_DIR:dir,PUBLIC_ORIGIN:'https://example.test'}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const base='http://127.0.0.1:'+server.address().port,room=key(),device=key(),identity=key(),headers={Authorization:'Bearer '+room,'X-Isend-Identity':identity,'Content-Type':'application/json'};
 const send=(h=headers)=>fetch(base+'/api/diagnostics?device='+device,{method:'POST',headers:h,body:JSON.stringify({events:[event({text:'private text',name:'secret.pdf'})]})});
 assert.equal((await send()).status,403);
 await fetch(base+'/api/peers',{method:'PUT',headers,body:JSON.stringify({id:device,name:'Компьютер'})});
 assert.equal((await send({...headers,'X-Isend-Identity':key()})).status,403);
 assert.equal((await send({...headers,Origin:'https://bad.test'})).status,403);
 assert.equal((await send()).status,200);
 assert.equal((await fetch(base+'/api/diagnostics?device='+device,{headers})).status,405);
 assert.equal((await fetch(base+'/telemetry.mjs')).status,404);
 const rows=await lines(dir);assert.equal(rows.length,1);assert.equal(JSON.stringify(rows).includes('private text'),false);assert.equal(JSON.stringify(rows).includes('secret.pdf'),false);
});
test('time reader deduplicates retries and can include whole transfer context',async t=>{
 const dir=await directory(t);let now=Date.parse('2026-10-12T10:00:00Z');const j=new TransferJournal({directory:dir,now:()=>now});const transfer=key(),device=key(),e=event({event:'requested',transfer});
 await j.append('a',device,[e]);await j.append('a',device,[e]);now+=60000;await j.append('a',device,[event({event:'complete',role:'send',transfer})]);
 const output=execFileSync(process.execPath,['scripts/transfer-log.mjs','--directory',dir,'--from','2026-10-12T13:00:00+03:00','--to','2026-10-12T13:00:30+03:00','--context','--json'],{encoding:'utf8'}).trim().split('\n').map(v=>JSON.parse(v));
 assert.equal(output.length,2);assert.equal(output[1].event,'complete');
});
