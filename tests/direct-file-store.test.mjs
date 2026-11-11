import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
const {outputFiles}=await build({entryPoints:['lib/direct-file-store.ts'],bundle:true,write:false,format:'iife',globalName:'DirectFiles',platform:'browser'});
const context=vm.createContext({crypto:webcrypto,ArrayBuffer,Uint8Array,Date,console});vm.runInContext(outputFiles[0].text,context);
const {DirectFileStore,shouldSaveDirect}=context.DirectFiles;
const B=262144,room='a'.repeat(48),id='b'.repeat(48);
const hash=b=>createHash('sha256').update(new Uint8Array(b)).digest('hex');
function fixture(size=6*B){
 const committed=new Uint8Array([7,8,9]);let disk=committed,staged=new Uint8Array(0),writes=0,closed=0,aborted=0,failWrite=false,failClose=false,hold=null;
 const resize=n=>{const b=new Uint8Array(n);b.set(staged.subarray(0,n));staged=b;};
 const stream={async write({position,data}){writes++;if(hold)await hold;if(failWrite)throw new Error('write failed');resize(Math.max(staged.length,position+data.byteLength));staged.set(new Uint8Array(data),position);},async truncate(n){resize(n);},async close(){if(failClose)throw new Error('commit failed');closed++;disk=staged.slice();},async abort(){aborted++;staged=new Uint8Array(0);}};
 const store=new DirectFileStore(room),meta={id,name:'example.bin',size,blockSize:B};
 return {store,meta,stream,async attach(){return store.attach(meta,{name:'chosen.bin',createWritable:async()=>stream});},async write(n,checkpoint=true){const b=new Uint8Array(Math.min(B,size-n*B)).fill(n+1).buffer;return store.write(id,n*B,b,hash(b),checkpoint);},get disk(){return disk;},get staged(){return staged;},get writes(){return writes;},get aborted(){return aborted;},get closed(){return closed;},failWrite(){failWrite=true;},failClose(){failClose=true;},hold(p){hold=p;}};
}
test('large files and insufficient quota select user file; small defaults stay unchanged',()=>{
 assert.equal(shouldSaveDirect(11*1024**3,false,10*1024**3),true);
 assert.equal(shouldSaveDirect(1,false,0),true);assert.equal(shouldSaveDirect(100,false,100),false);
 assert.equal(shouldSaveDirect(100,true),true);assert.equal(shouldSaveDirect(512*1024**2,false),true);
});
test('network reconnect retains checked checkpoint; final file commits only after close',async()=>{
 const f=fixture();await f.attach();for(let n=0;n<4;n++)await f.write(n,n===3);
 await f.write(4,false);await f.store.release(id);
 assert.equal(f.staged.length,4*B);assert.equal((await f.store.open(f.meta)).offset,4*B);
 assert.deepEqual([...f.disk],[7,8,9]);assert.equal(f.closed,0);
 await f.write(4);await f.write(5);const done=await f.store.complete(id);
 assert.equal(done.complete,true);assert.equal(done.destination,'file');assert.equal(done.savedName,'chosen.bin');assert.equal(f.closed,1);
 assert.equal(f.disk.length,6*B);for(let n=0;n<6;n++)assert(f.disk.subarray(n*B,(n+1)*B).every(x=>x===n+1));
});
test('release waits for an in-flight write and then rolls back its uncheckpointed tail',async()=>{
 const f=fixture();await f.attach();await f.write(0);let resolve;f.hold(new Promise(r=>resolve=r));
 const writing=f.write(1,false),release=f.store.release(id);resolve();await writing;await release;
 assert.equal((await f.store.open(f.meta)).offset,B);assert.equal(f.staged.length,B);
});
test('checksum, sequence and incomplete transfer cannot commit or acknowledge bad data',async()=>{
 const f=fixture();await f.attach();const b=new Uint8Array(B).buffer;
 await assert.rejects(f.store.write(id,0,b,'0'.repeat(64),true),/контрольная/);assert.equal(f.writes,0);
 await assert.rejects(f.store.write(id,B,b,hash(b),true),/последовательность/);
 await assert.rejects(f.store.complete(id),/не полностью/);assert.equal(f.closed,0);
});
test('failed disk write or final commit never reports completion or overwrites existing target',async()=>{
 for(const phase of ['write','close']){
  const f=fixture(B);await f.attach();if(phase==='write')f.failWrite();
  if(phase==='write')await assert.rejects(f.write(0),/write failed/);
  else{await f.write(0);f.failClose();await assert.rejects(f.store.complete(id),/commit failed/);}
  assert.deepEqual([...f.disk],[7,8,9]);assert.equal(f.closed,0);assert.equal(f.aborted,1);
  await assert.rejects(f.store.open(f.meta),/заново/);
 }
});
test('cancel and clear abort unfinished streams but never delete a completed user file',async()=>{
 const f=fixture(B);await f.attach();await f.write(0);await f.store.discard(id);assert.equal(f.aborted,1);assert.deepEqual([...f.disk],[7,8,9]);
 const g=fixture(B);await g.attach();await g.write(0);await g.store.complete(id);await g.store.clear();assert.equal(g.aborted,0);assert.equal(g.disk.length,B);
});
test('new page has no live resume offsets; large metadata never uses 32-bit sizes',async()=>{
 const f=fixture(12*1024**3+17);const r=await f.attach();assert.equal(r.size,12884901905);
 const fresh=new DirectFileStore(room);assert.equal(fresh.has(id),false);await assert.rejects(fresh.open(f.meta),/заново/);
 await f.store.discard(id);
});
test('12 GiB transfer crosses 4/8/10 GiB boundaries and reconnects without truncating offsets',async()=>{
 const store=new DirectFileStore(room),size=12*1024**3+17,meta={id,name:'large.bin',size,blockSize:B};
 let diskSize=0,position=0,committed=false,operations=0;
 const stream={async write(v){assert.equal(v.position,position);position+=v.data.byteLength;diskSize=Math.max(diskSize,position);operations++;},async truncate(n){diskSize=position=n;},async close(){committed=true;},async abort(){throw new Error('unexpected abort');}};
 await store.attach(meta,{name:'large.bin',createWritable:async()=>stream});
 const data=new Uint8Array(B).fill(93).buffer,digest=hash(data);
 for(let at=0;at<12*1024**3;at+=B){
  const r=await store.write(id,at,data,digest,true);assert.equal(r.offset,at+B);
  if([4,8,10].some(g=>at+B===g*1024**3)){await store.release(id);assert.equal((await store.open(meta)).offset,at+B);}
 }
 const tail=new Uint8Array(17).buffer;await store.write(id,12*1024**3,tail,hash(tail),true);
 assert.equal(committed,false);assert.equal((await store.complete(id)).offset,size);
 assert.equal(diskSize,size);assert.equal(committed,true);assert.equal(operations,49153);
});
