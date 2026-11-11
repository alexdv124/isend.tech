import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {AudienceStore} from '../audience.mjs';
import {createApp} from '../server.mjs';
import {TransferJournal} from '../telemetry.mjs';
import {dailyVisitor,journalRows,summarizeDaily} from '../analytics.mjs';
const random=()=>randomBytes(24).toString('hex'),hash=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'isend-audience-'));t.after(()=>rm(dir,{recursive:true,force:true}));return{dir,path:join(dir,'audience.json')};}
test('owner invite enrolls a stable identity, is bounded, expiring, private, and does not store the token',async t=>{
 const{path}=await fixture(t);let now=Date.now();let store=new AudienceStore({path,now:()=>now});const invite=store.invite({hours:1,uses:2}),a=hash('a'),b=hash('b');
 assert.throws(()=>store.enroll(a,random()),e=>e.status===403);
 assert.deepEqual(store.enroll(a,invite.token),{internal:true});store.enroll(a,invite.token);assert.equal(store.snapshot().invites[0].remaining,1);
 store.enroll(b,invite.token);assert.throws(()=>store.enroll(hash('c'),invite.token),e=>e.status===403);
 store=new AudienceStore({path,now:()=>now});assert.equal(store.isInternal(a),true);assert.equal(store.isInternal(hash('c')),false);
 assert.equal((await readFile(path,'utf8')).includes(invite.token),false);assert.equal((await stat(path)).mode&0o777,0o600);
 const exp=store.invite({hours:1});now+=3600001;assert.throws(()=>store.enroll(hash('d'),exp.token),e=>e.status===403);
 assert.throws(()=>store.add('device','146a'),/full hash/);
});
test('fresh snapshots respect independent CLI updates and concurrent mutation fails safely',async t=>{
 const{path}=await fixture(t);let now=Date.now();const a=new AudienceStore({path,now:()=>now}),b=new AudienceStore({path,now:()=>now});a.snapshot();b.add('identity',hash('owner'),'owner');now+=1001;assert.equal(a.isInternal(hash('owner')),true);
 await writeFile(path+'.lock','test');assert.throws(()=>a.invite(),e=>e.status===503);assert.equal(new AudienceStore({path}).snapshot().identities.length,1);
});
test('invalid enrollment attempts are limited across identities and global sources',()=>{
 let now=1000000;const s=new AudienceStore({now:()=>now});for(let i=0;i<20;i++)s.limit('same-network');assert.throws(()=>s.limit('same-network'),e=>e.status===429);
 for(let i=0;i<100;i++)s.limit('network-'+i);assert.throws(()=>s.limit('new-network'),e=>e.status===429);now+=60001;s.limit('same-network');
});
test('HTTP enrollment requires owner token and identity, rejects cross-site requests, is separate from pairing and does not expose lists',async t=>{
 const{dir,path}=await fixture(t),store=new AudienceStore({path}),invite=store.invite(),secret=random();
 const server=await createApp({env:{DIAGNOSTICS_DIR:dir,PUBLIC_ORIGIN:'https://example.test'}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const url='http://127.0.0.1:'+server.address().port+'/api/internal-device',headers={'X-Isend-Identity':secret,'Content-Type':'application/json'};
 assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://foreign.test'},body:JSON.stringify({token:invite.token})})).status,403);
 assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({token:random()})})).status,403);
 const result=await fetch(url,{method:'POST',headers,body:JSON.stringify({token:invite.token})});assert.equal(result.status,200);assert.deepEqual(await result.json(),{internal:true});
 assert.deepEqual(await(await fetch(url,{headers})).json(),{internal:true});assert.deepEqual(await(await fetch(url,{headers:{'X-Isend-Identity':random()}})).json(),{internal:false});
 const j=new TransferJournal({directory:dir,audience:new AudienceStore({path})});
 const event={event:'page_view',session:random(),seq:1,clientAt:Date.now(),elapsedMs:0,audience:'internal'};
 await j.append(hash('not-owner'),random(),[event]);await j.append(hash(secret),random(),[event]);const rows=[];for await(const r of journalRows(dir))rows.push(r);
 assert.equal(rows[0].audience,'unmarked');assert.equal(rows[1].audience,'internal');assert.equal(JSON.stringify(rows).includes(secret),false);assert.equal(JSON.stringify(rows).includes(invite.token),false);
});
test('retrospective marking separates complete transfers, mixed transfers and daily visitors without rewriting events',async()=>{
 const time='2026-10-12T12:00:00Z',a=hash('owner-a'),b=hash('owner-b'),outside=hash('outside'),a1='a'.repeat(12),a2='b'.repeat(12),b1='c'.repeat(12),other='d'.repeat(12),second='e'.repeat(12);
 const base=(device,identity,event,extra={})=>({schema:1,receivedAt:time,device,visitor:dailyVisitor(identity,time),session:(device.repeat(4)),seq:1,event,...extra});
 const rows=[base(a1,a,'page_view'),base(a2,a,'page_view'),base(b1,b,'page_view'),base(other,outside,'page_view'),base(second,hash('second'),'page_view')];
 for(const [id,from,who,to,whoto]of [['1',a2,a,b1,b],['2',a1,a,other,outside],['3',other,outside,second,hash('second')]]){
  for(const[device,identity,peer,role]of[[from,who,to,'send'],[to,whoto,from,'receive']])for(const event of ['requested','complete'])rows.push(base(device,identity,event,{transfer:id.repeat(48),peer,role,payload:'file',total:100}));
 }
 const saved=JSON.stringify(rows),registry={identities:[{value:b}],devices:[{value:a1}],visitors:[]};
 const reports={};for(const audience of ['all','internal','unmarked','mixed'])reports[audience]=(await summarizeDaily([...rows].reverse(),{audience,audienceRegistry:registry})).days[0];
 assert.equal(reports.all.unique_browsers,4);assert.equal(reports.internal.unique_browsers,2);assert.equal(reports.internal.page_views,3);assert.equal(reports.unmarked.unique_browsers,2);
 for(const group of ['internal','unmarked','mixed'])assert.equal(reports[group].transfers_completed,1);
 assert.equal(reports.all.bytes_completed,300);assert.equal(reports.unmarked.bytes_completed,100);assert.equal(JSON.stringify(rows),saved);
});
test('identity exclusion survives day changes and endpoints; it does not exclude a peer just because they met',async()=>{
 const owner=hash('owner'),outside=hash('outside'),rows=[];
 for(const [time,device]of[['2026-10-12T20:59:00Z','a'.repeat(12)],['2026-10-12T21:01:00Z','b'.repeat(12)]]){
  rows.push({receivedAt:time,device,session:device.repeat(4),visitor:dailyVisitor(owner,time),event:'page_view'});
  rows.push({receivedAt:time,device:'c'.repeat(12),session:device.repeat(4),visitor:dailyVisitor(outside,time),event:'page_view',peer:device});
 }
 const registry={identities:[{value:owner}]};for(const audience of ['internal','unmarked']){const report=await summarizeDaily(rows,{audience,audienceRegistry:registry});assert.equal(report.days.length,2);for(const d of report.days)assert.equal(d.unique_browsers,1);}
});
