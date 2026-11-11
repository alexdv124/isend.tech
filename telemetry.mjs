import {mkdir,readdir,stat,appendFile,unlink,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {dailyVisitor} from './analytics.mjs';

const KEY=/^[a-f0-9]{48}$/;
const EVENTS=new Set(['page_view','device_found','requested','state','connection','channel','route','sample','resume','complete','cancel','error','network_change','visibility','page_exit','signaling']);
const ENUMS={stage:['setup','authorize','storage_open','storage_write','storage_complete','receive_control','receive_block','send_pump','ready'],role:['send','receive'],payload:['file','text'],state:['ready','connecting','sending','receiving','sent','received','reconnecting','retry','error'],route:['idle','finding','direct','relay'],connection:['new','connecting','connected','disconnected','failed','closed'],ice:['new','checking','connected','completed','disconnected','failed','closed'],gathering:['new','gathering','complete'],channel:['connecting','open','closing','closed'],visibility:['visible','hidden'],browser:['Chrome','Edge','Firefox','Safari','Opera','Other'],os:['Android','Windows','macOS','iOS','Linux','Other'],networkType:['wifi','cellular','ethernet','unknown'],effectiveType:['slow-2g','2g','3g','4g'],error:['sequence','ack','checksum','incomplete','quota','storage','permission','declined','busy','format','timeout','network','signaling','channel','resume','queue','unknown']};
const NUMBERS=['peerCount','revision','peerRevision','total','offset','sendOffset','queuedBytes','bufferedBytes','windowBytes','checkpointBlocks','retries','sequenceRecoveries','bytesPerSecond','averageBytesPerSecond','remainingSeconds','elapsedSeconds','rttMs','readMsPerMiB','fileReadMsPerMiB','hashMsPerMiB','writeMsPerMiB','ackMs','socketDrops','prepareMs','channelMs','ackWaitMs','dispatchMs','timingMs','pacingMs','wireBytesPerSecond','browserMajor','deliveryMs','droppedEvents','expectedAck','receivedAck'];
const BOOLS=['paused','complete','cancelled','permanent','online','relayAvailable','shared','hashValid','socketDropsSinceStart','serverOnline'];
const CANDIDATES=['host','srflx','prflx','relay','unknown'],ADDRESSES=['private','public','loopback','shared','hidden'];
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const number=(v,signed=false)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER&&(signed||v>=0);
export class TelemetryError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}

// Never serialize the original request, Error, SDP, file name, URL or user agent.
// Unknown fields are discarded at the server boundary, including nested fields.
export function sanitizeEvent(v){
  if(!object(v)||!EVENTS.has(v.event)||!KEY.test(v.session||'')||!Number.isSafeInteger(v.seq)||v.seq<1||!number(v.clientAt)||!number(v.elapsedMs))throw new TelemetryError(400,'invalid_diagnostic');
  const out={event:v.event,session:v.session,seq:v.seq,clientAt:v.clientAt,elapsedMs:v.elapsedMs};
  for(const k of ['transfer','attempt'])if(KEY.test(v[k]||''))out[k]=v[k];
  if(KEY.test(v.peer||''))out.peer=v.peer.slice(0,12);
  for(const [k,values]of Object.entries(ENUMS))if(values.includes(v[k]))out[k]=v[k];
  for(const k of NUMBERS)if(number(v[k]))out[k]=Math.round(v[k]*1000)/1000;
  for(const k of BOOLS)if(typeof v[k]==='boolean')out[k]=v[k];
  for(const k of ['expectedOffset','receivedOffset','expectedLength','receivedLength'])if(number(v[k],true))out[k]=v[k];
  if(object(v.path)){
    const path={};for(const k of ['local','remote'])if(CANDIDATES.includes(v.path[k]))path[k]=v.path[k];
    for(const k of ['localAddress','remoteAddress'])if(ADDRESSES.includes(v.path[k]))path[k]=v.path[k];
    if(['udp','tcp','unknown'].includes(v.path.protocol))path.protocol=v.path.protocol;
    out.path=path;
  }
  return out;
}

export class TransferJournal{
  constructor({directory=null,now=Date.now,maxBytes=256*1024*1024,segmentBytes=8*1024*1024,days=7,perIdentity=180,globalLimit=12000,audience=null}={}){
    Object.assign(this,{directory,now,maxBytes,segmentBytes,days,perIdentity,globalLimit,audience});
    this.tail=Promise.resolve();this.files=null;this.pendingBytes=0;this.limits=new Map();this.global={at:0,count:0};
  }
  limit(identity,count){
    const now=this.now();for(const [k,v]of this.limits)if(now-v.at>=60000)this.limits.delete(k);
    if(now-this.global.at>=60000)this.global={at:now,count:0};
    const v=this.limits.get(identity)||{at:now,count:0};
    if(v.count+count>this.perIdentity||this.global.count+count>this.globalLimit||!this.limits.has(identity)&&this.limits.size>=2048)throw new TelemetryError(429,'diagnostic_rate_limited');
    v.count+=count;this.global.count+=count;this.limits.set(identity,v);
  }
  async load(){
    if(this.files)return;
    await mkdir(this.directory,{recursive:true,mode:0o700});await chmod(this.directory,0o700);
    const files=[];
    for(const name of await readdir(this.directory))if(/^transfers-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(name)){
      const info=await stat(join(this.directory,name));if(info.isFile())files.push({name,size:info.size});
    }
    this.files=files.sort((a,b)=>a.name.localeCompare(b.name));
  }
  async prune(){
    const cutoff=new Date(this.now()).toISOString().slice(0,10);
    const oldest=new Date(Date.parse(cutoff+'T00:00:00Z')-(this.days-1)*86400000).toISOString().slice(0,10);
    let bytes=this.files.reduce((n,f)=>n+f.size,0);
    while(this.files.length&&(this.files[0].name.slice(10,20)<oldest||bytes>this.maxBytes)){
      const f=this.files[0];await unlink(join(this.directory,f.name));this.files.shift();bytes-=f.size;
    }
  }
  async sweep(){if(!this.directory)return;const task=this.tail.catch(()=>{}).then(async()=>{await this.load();await this.prune();});this.tail=task;return task;}
  append(identity,device,events){
    if(!this.directory)throw new TelemetryError(503,'diagnostics_disabled');
    if(!KEY.test(device)||!Array.isArray(events)||!events.length||events.length>16)throw new TelemetryError(400,'invalid_diagnostic_batch');
    const receivedAt=new Date(this.now()).toISOString();
    const visitor=dailyVisitor(identity,receivedAt);
    const audience=this.audience?.isInternal(identity,device)?'internal':'unmarked';
    const rows=events.map(v=>({schema:1,receivedAt,device:device.slice(0,12),...sanitizeEvent(v),visitor,audience}));
    this.limit(identity,rows.length);
    const data=rows.map(v=>JSON.stringify(v)+'\n').join(''),bytes=Buffer.byteLength(data);
    if(bytes>24000)throw new TelemetryError(413,'diagnostic_batch_too_large');
    if(this.pendingBytes+bytes>512*1024)throw new TelemetryError(503,'diagnostic_queue_full');
    this.pendingBytes+=bytes;
    const task=this.tail.catch(()=>{}).then(async()=>{
      await this.load();await this.prune();const day=receivedAt.slice(0,10),prefix='transfers-'+day+'-';let file=this.files.at(-1);
      if(!file||!file.name.startsWith(prefix)||file.size+bytes>this.segmentBytes){
        const n=file?.name.startsWith(prefix)?Number(file.name.slice(21,27))+1:0;
        file={name:prefix+String(n).padStart(6,'0')+'.jsonl',size:0};this.files.push(file);
      }
      try{await appendFile(join(this.directory,file.name),data,{mode:0o600});file.size+=bytes;await this.prune();}
      catch(error){this.files=null;throw error;}
      return rows.length;
    }).finally(()=>{this.pendingBytes-=bytes;});
    this.tail=task;return task;
  }
  async flush(){await this.tail;}
}
