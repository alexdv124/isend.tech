import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {join} from 'node:path';

const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'});
export function analyticsDay(time){return dayFormat.format(new Date(time));}
// Existing high-entropy browser identity, server-derived and separated by day.
// This is a pseudonym, never the bearer credential or the pairing identity hash.
export function dailyVisitor(identity,time){return createHash('sha256').update('isend-daily-visitor-v1\0'+analyticsDay(time)+'\0'+identity).digest('hex').slice(0,32);}
export async function* journalRows(directory,quality={}){
  let files;try{files=await readdir(directory);}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const name of files.filter(s=>/^transfers-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(s)).sort()){
    const input=createReadStream(join(directory,name)),lines=createInterface({input,crlfDelay:Infinity});
    try{for await(const line of lines){try{const r=JSON.parse(line);if(r.schema===1)yield r;else quality.skipped=(quality.skipped||0)+1;}catch{quality.skipped=(quality.skipped||0)+1;}}}
    catch(e){if(e.code==='ENOENT')quality.rotated=(quality.rotated||0)+1;else throw e;}
    finally{lines.close();input.destroy();}
  }
}
const validId=v=>typeof v==='string'&&/^[a-f0-9]{48}$/.test(v);
const visitorId=v=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
const stamp=v=>typeof v==='string'?Date.parse(v):NaN;
const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER;
const ratio=(n,d)=>d?Math.round(10000*n/d)/100:null;

export async function summarizeDaily(rows,{from,to,audienceRegistry=null,audience='all',includeSegments=false}={}){
  if(!['all','internal','unmarked','mixed'].includes(audience))throw new Error('Unknown audience');
  const sessions=new Map(),transfers=new Map(),deviceVisitors=new Map();let first=null,last=null,firstPageView=null;
  const internalDevices=new Set((audienceRegistry?.devices||[]).map(r=>r.value)),internalVisitors=new Set((audienceRegistry?.visitors||[]).map(r=>r.value)),identityDays=new Map();
  const knownVisitor=r=>{
    if(!visitorId(r.visitor))return false;
    const day=analyticsDay(r.receivedAt);let ids=identityDays.get(day);
    if(!ids){ids=new Set((audienceRegistry?.identities||[]).map(v=>dailyVisitor(v.value,r.receivedAt)));identityDays.set(day,ids);}
    return internalVisitors.has(r.visitor)||ids.has(r.visitor);
  };
  for await(const r of rows){
    const at=stamp(r.receivedAt);if(!Number.isFinite(at))continue;
    first=first===null?at:Math.min(first,at);last=last===null?at:Math.max(last,at);
    if(typeof r.device==='string'){
      const ids=deviceVisitors.get(r.device)||new Set();if(visitorId(r.visitor))ids.add(r.visitor);deviceVisitors.set(r.device,ids);
      if(r.audience==='internal'||internalDevices.has(r.device)||knownVisitor(r)){
        internalDevices.add(r.device);if(visitorId(r.visitor))internalVisitors.add(r.visitor);
      }
    }
    const realTransfer=validId(r.transfer)&&['send','receive'].includes(r.role);
    if(validId(r.session)&&typeof r.device==='string'){
      const key=r.device+':'+r.session;
      if(r.event==='page_view'||r.event==='device_found'||realTransfer&&['requested','complete'].includes(r.event)){
        const s=sessions.get(key)||{at:null,visitor:null,mask:0,device:r.device};
        if(r.event==='page_view'&&visitorId(r.visitor)){
          if(s.at===null||at<s.at){s.at=at;s.visitor=r.visitor;}
          firstPageView=firstPageView===null?at:Math.min(firstPageView,at);
        }
        if(r.event==='device_found')s.mask|=2;
        if(realTransfer&&r.event==='requested')s.mask|=4;
        if(realTransfer&&r.event==='complete')s.mask|=8;
        sessions.set(key,s);
      }
    }
    if(!realTransfer)continue;
    const tr=transfers.get(r.transfer)||{start:null,complete:null,size:null,payload:null,errors:new Set(),cancels:new Set(),devices:new Set()};
    if(typeof r.device==='string')tr.devices.add(r.device);
    if(typeof r.peer==='string'&&/^[a-f0-9]{12}$/.test(r.peer))tr.devices.add(r.peer);
    if(r.event==='requested')tr.start=tr.start===null?at:Math.min(tr.start,at);
    if(r.event==='complete')tr.complete=tr.complete===null?at:Math.min(tr.complete,at);
    if(numeric(r.total))tr.size=Math.max(tr.size||0,r.total);
    if(['file','text'].includes(r.payload))tr.payload=r.payload;
    if(r.event==='error')tr.errors.add(analyticsDay(at));
    if(r.event==='cancel')tr.cancels.add(analyticsDay(at));
    transfers.set(r.transfer,tr);
  }
  // Expand only the SAME browser's daily identities/endpoints, never its peers.
  // This makes historical reclassification independent of journal row order.
  let expanded=true;while(expanded){expanded=false;for(const [device,visitors]of deviceVisitors){
    if(internalDevices.has(device)||[...visitors].some(v=>internalVisitors.has(v))){
      if(!internalDevices.has(device)){internalDevices.add(device);expanded=true;}
      for(const v of visitors)if(!internalVisitors.has(v)){internalVisitors.add(v);expanded=true;}
    }
  }}
  const build=audience=>{
  const days=new Map();
  const get=day=>{
    if(!days.has(day))days.set(day,{day,page_views:0,visitors:new Map(),transfers_started:0,transfers_completed:0,started_eventually_completed:0,files_completed:0,texts_completed:0,bytes_completed:0,completed_size_unknown:0,transfers_with_errors:0,transfers_cancelled:0});
    return days.get(day);
  };
  if(from&&to)for(let at=Date.parse(from+'T12:00:00+03:00'),end=Date.parse(to+'T12:00:00+03:00');at<=end;at+=86400000)get(analyticsDay(at));
  for(const s of sessions.values())if(s.at!==null){
    const group=internalDevices.has(s.device)||internalVisitors.has(s.visitor)?'internal':'unmarked';
    if(audience!=='all'&&audience!==group)continue;
    const d=get(analyticsDay(s.at));d.page_views++;d.visitors.set(s.visitor,(d.visitors.get(s.visitor)||0)|s.mask);
  }
  for(const tr of transfers.values()){
    const internal=[...tr.devices].filter(d=>internalDevices.has(d)).length;
    const group=internal===0?'unmarked':internal===tr.devices.size?'internal':'mixed';
    if(audience!=='all'&&audience!==group)continue;
    if(tr.start!==null){const d=get(analyticsDay(tr.start));d.transfers_started++;if(tr.complete!==null)d.started_eventually_completed++;}
    if(tr.complete!==null){const d=get(analyticsDay(tr.complete));d.transfers_completed++;if(tr.payload==='file')d.files_completed++;if(tr.payload==='text')d.texts_completed++;if(tr.size===null)d.completed_size_unknown++;else d.bytes_completed+=tr.size;}
    for(const day of tr.errors)get(day).transfers_with_errors++;
    for(const day of tr.cancels)get(day).transfers_cancelled++;
  }
  const result=[];
  for(const d of [...days.values()].sort((a,b)=>a.day.localeCompare(b.day))){
    if(from&&d.day<from||to&&d.day>to)continue;
    const tracked=firstPageView!==null&&d.day>=analyticsDay(firstPageView);
    const visitors=[...d.visitors.values()],found=visitors.filter(m=>(m&2)===2).length,started=visitors.filter(m=>(m&6)===6).length,completed=visitors.filter(m=>(m&14)===14).length;
    const {visitors:unused,...row}=d;
    result.push({...row,page_views:tracked?d.page_views:null,unique_browsers:tracked?visitors.length:null,browsers_found_device:tracked?found:null,browsers_started_transfer:tracked?started:null,browsers_completed_transfer:tracked?completed:null,visitor_conversion_percent:tracked?ratio(completed,visitors.length):null,transfer_completion_percent:ratio(d.started_eventually_completed,d.transfers_started)});
  }
  return {timezone:'Europe/Moscow',audience,first_received_at:first===null?null:new Date(first).toISOString(),last_received_at:last===null?null:new Date(last).toISOString(),visit_tracking_observed_since:firstPageView===null?null:new Date(firstPageView).toISOString(),days:result};
  };
  const report=build(audience);
  if(includeSegments)report.segments=Object.fromEntries(['internal','unmarked','mixed'].map(group=>[group,build(group).days]));
  return report;
}
