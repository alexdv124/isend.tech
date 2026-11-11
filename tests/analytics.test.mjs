import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {analyticsDay,dailyVisitor,journalRows,summarizeDaily} from '../analytics.mjs';
import {TransferJournal} from '../telemetry.mjs';
const key=()=>randomBytes(24).toString('hex');
const time='2026-10-12T12:00:00Z';
const row=(event,extra={})=>({schema:1,receivedAt:time,event,device:'abcdef123456',session:'a'.repeat(48),seq:1,clientAt:0,elapsedMs:0,visitor:dailyVisitor('browser-a',time),...extra});
async function directory(t){const dir=await mkdtemp(join(tmpdir(),'isend-stats-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('daily pseudonym rotates at Moscow midnight, differs by browser, contains no credential',()=>{
 assert.equal(analyticsDay('2026-10-12T21:00:00Z'),'2026-10-13');
 assert.equal(dailyVisitor('secret','2026-10-12T00:00:00Z'),dailyVisitor('secret','2026-10-12T20:59:59Z'));
 assert.notEqual(dailyVisitor('secret','2026-10-12T20:59:59Z'),dailyVisitor('secret','2026-10-12T21:00:00Z'));
 assert.notEqual(dailyVisitor('secret',time),dailyVisitor('other',time));assert.match(dailyVisitor('secret',time),/^[a-f0-9]{32}$/);
});
test('server derives visitor independently of endpoint/session and discards client spoofing',async t=>{
 const dir=await directory(t),j=new TransferJournal({directory:dir,now:()=>Date.parse(time)});
 for(const device of [key(),key()])await j.append('server-identity',device,[row('page_view',{visitor:'f'.repeat(32),identity:'secret',url:'private-url'})]);
 const rows=[];for await(const r of journalRows(dir))rows.push(r);
 assert.equal(rows[0].visitor,dailyVisitor('server-identity',time));assert.equal(rows[0].visitor,rows[1].visitor);
 assert.equal(JSON.stringify(rows).includes('secret'),false);assert.equal(JSON.stringify(rows).includes('private-url'),false);
});
test('reloads count as openings, retry and two endpoints do not duplicate visitors or transfers',async()=>{
 const id=key(),sessionB=key(),sessionReload=key(),visitorB=dailyVisitor('browser-b',time);
 const a=extra=>row(extra.event||'requested',{transfer:id,role:'send',payload:'file',total:1024,...extra});
 const b=extra=>a({device:'bbbbbbbbbbbb',session:sessionB,visitor:visitorB,role:'receive',...extra});
 const rows=[row('page_view'),row('page_view'),row('device_found'),row('device_found'),row('page_view',{session:sessionReload}),
 b({event:'page_view'}),b({event:'device_found'}),a({}),b({}),a({event:'resume'}),a({event:'requested'}),a({event:'error'}),a({event:'error'}),b({event:'complete'}),a({event:'complete'}),a({event:'complete'})];
 const [d]=(await summarizeDaily(rows)).days;
 assert.equal(d.page_views,3);assert.equal(d.unique_browsers,2);assert.equal(d.browsers_found_device,2);assert.equal(d.browsers_started_transfer,2);assert.equal(d.browsers_completed_transfer,2);
 assert.equal(d.transfers_started,1);assert.equal(d.transfers_completed,1);assert.equal(d.bytes_completed,1024);assert.equal(d.files_completed,1);assert.equal(d.texts_completed,0);assert.equal(d.transfers_with_errors,1);assert.equal(d.transfer_completion_percent,100);
});
test('solo visitors, text transfers, cancels and missing funnel events remain distinguishable',async()=>{
 const text=key(),file=key(),rows=[row('page_view'),row('requested',{transfer:text,role:'send',payload:'text',total:9}),row('complete',{transfer:text,role:'send',payload:'text',total:9}),row('requested',{transfer:file,role:'send',payload:'file',total:128}),row('cancel',{transfer:file,role:'send'}),row('cancel',{transfer:file,role:'send'})];
 const [d]=(await summarizeDaily(rows)).days;
 assert.equal(d.unique_browsers,1);assert.equal(d.browsers_found_device,0);assert.equal(d.browsers_started_transfer,0);assert.equal(d.browsers_completed_transfer,0);
 assert.equal(d.transfers_started,2);assert.equal(d.texts_completed,1);assert.equal(d.files_completed,0);assert.equal(d.bytes_completed,9);assert.equal(d.transfers_cancelled,1);assert.equal(d.transfer_completion_percent,50);
});
test('cross-midnight completion belongs to its day; retries and later receiver events never double count',async()=>{
 const start='2026-10-12T20:59:59Z',end='2026-10-12T21:01:00Z',transfer=key(),context={receivedAt:start,visitor:dailyVisitor('browser-a',start),transfer,role:'send',payload:'file',total:50};
 const rows=[row('page_view',context),row('device_found',context),row('requested',context),row('complete',{...context,receivedAt:end}),row('page_view',{...context,receivedAt:end,visitor:dailyVisitor('browser-a',end)}),row('requested',{...context,receivedAt:end}),row('complete',{...context,receivedAt:end,role:'receive',session:key()})];
 const report=await summarizeDaily(rows.reverse(),{from:'2026-10-11',to:'2026-10-13'}),[unknown,a,b]=report.days;
 assert.equal(unknown.page_views,null);assert.equal(a.page_views,1);assert.equal(a.transfers_started,1);assert.equal(a.transfers_completed,0);assert.equal(a.started_eventually_completed,1);assert.equal(a.transfer_completion_percent,100);assert.equal(a.browsers_completed_transfer,1);
 assert.equal(b.page_views,0);assert.equal(b.transfers_started,0);assert.equal(b.transfers_completed,1);assert.equal(b.bytes_completed,50);
});
test('legacy events show transfer totals but unknown visit counts',async()=>{
 const r=await summarizeDaily([row('requested',{visitor:undefined,transfer:'c'.repeat(48),role:'send'}),row('complete',{visitor:undefined,transfer:'c'.repeat(48),role:'send'})]);
 assert.equal(r.visit_tracking_observed_since,null);assert.equal(r.days[0].unique_browsers,null);assert.equal(r.days[0].transfers_completed,1);assert.equal(r.days[0].completed_size_unknown,1);
});
test('stream reader handles empty directory and malformed final line; CLI filters dates and validates input',async t=>{
 const dir=await directory(t),quality={};await writeFile(join(dir,'transfers-2026-10-12-000000.jsonl'),JSON.stringify(row('page_view'))+'\n{"incomplete":');await writeFile(join(dir,'unrelated.txt'),'private');
 const report=await summarizeDaily(journalRows(dir,quality));assert.equal(report.days[0].page_views,1);assert.equal(quality.skipped,1);
 assert.deepEqual((await summarizeDaily(journalRows(join(dir,'missing')))).days,[]);
 const args=['scripts/daily-stats.mjs','--directory',dir,'--from','2026-10-12','--to','2026-10-12'];
 const result=JSON.parse(execFileSync(process.execPath,[...args,'--json'],{encoding:'utf8'}));assert.equal(result.days.length,1);assert.equal(result.days[0].unique_browsers,1);assert.equal(result.quality.skipped,1);
 const table=execFileSync(process.execPath,args,{encoding:'utf8'});assert.ok(table.includes('| 2026-10-12 | 1 | 1 | 0 |'));
 assert.throws(()=>execFileSync(process.execPath,['scripts/daily-stats.mjs','--from','2026-02-30'],{stdio:'pipe'}));
});
