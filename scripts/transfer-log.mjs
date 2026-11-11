#!/usr/bin/env node
import {createReadStream} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {join} from 'node:path';

const args=process.argv.slice(2),options={directory:process.env.DIAGNOSTICS_DIR||'/var/lib/perebros-diagnostics',timezone:'Europe/Moscow'};
for(let i=0;i<args.length;i++){
  const key=args[i].replace(/^--/,'');
  if(['json','context','help'].includes(key))options[key]=true;
  else if(['from','to','device','transfer','directory','timezone'].includes(key)&&args[i+1]&&!args[i+1].startsWith('--'))options[key]=args[++i];
  else throw new Error('Unknown or incomplete option: '+args[i]);
}
if(options.help){console.log(`Read private isend transfer diagnostics (SSH only).
Usage: node scripts/transfer-log.mjs --from 2026-10-12T18:00:00+03:00 --to 2026-10-12T18:15:00+03:00
Options: --device 11aa --transfer HEX_PREFIX --context --json --timezone Europe/Moscow
         --directory /var/lib/perebros-diagnostics
Time filters use server receipt time. Include Z or a UTC offset explicitly.
--context includes all retained events for transfers seen in that interval.
No "complete" event means the outcome is unknown, not necessarily a failure.
Client clocks may be wrong; events may be delayed/offline, retried or lost at page close.`);process.exit(0);}
const parse=(v,fallback)=>{if(!v)return fallback;if(!/(Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))throw new Error('Use ISO time with timezone: '+v);return Date.parse(v);};
const from=parse(options.from,Date.now()-3600000),to=parse(options.to,Date.now());if(from>to)throw new Error('--from must precede --to');
for(const key of ['device','transfer'])if(options[key]&&!/^[a-f0-9]{4,48}$/.test(options[key]))throw new Error('Use a hexadecimal prefix of at least four characters: --'+key);
const fmt=new Intl.DateTimeFormat('ru-RU',{timeZone:options.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const files=(await readdir(options.directory)).filter(s=>/^transfers-\d{4}-\d{2}-\d{2}-\d{6}\.jsonl$/.test(s)).sort();
let damaged=0;
async function* rows(){
  for(const name of files){
    const lines=createInterface({input:createReadStream(join(options.directory,name)),crlfDelay:Infinity});
    for await(const line of lines){try{const r=JSON.parse(line);if(r.schema===1&&typeof r.receivedAt==='string')yield r;}catch{damaged++;}}
  }
}
const matches=r=>(!options.device||r.device?.startsWith(options.device)||r.peer?.startsWith(options.device))&&(!options.transfer||r.transfer?.startsWith(options.transfer));
const inTime=r=>Date.parse(r.receivedAt)>=from&&Date.parse(r.receivedAt)<=to;
const transfers=new Set();
if(options.context)for await(const r of rows())if(matches(r)&&inTime(r)&&r.transfer)transfers.add(r.transfer);
const seen=new Set(),groups=new Map();let count=0;
if(!options.json)console.log(`isend · ${fmt.format(from)} — ${fmt.format(to)} (${options.timezone})\nTime = server receipt; client seq orders retried/batched events.\n`);
for await(const r of rows()){
  if(!(matches(r)&&inTime(r)||options.context&&transfers.has(r.transfer)))continue;
  const id=r.device+':'+r.session+':'+r.seq;if(seen.has(id))continue;seen.add(id);count++;
  if(options.json){console.log(JSON.stringify(r));continue;}
  if(r.transfer){const g=groups.get(r.transfer)||{id:r.transfer,roles:new Set(),errors:new Set(),peak:0,total:0};if(r.event==='complete')g.roles.add(r.role);if(r.error)g.errors.add(r.error);g.peak=Math.max(g.peak,r.bytesPerSecond||0);g.total=Math.max(g.total,r.total||0);groups.set(r.transfer,g);}
  const details=[r.state,r.error,r.route,r.path?`${r.path.protocol}:${r.path.local}↔${r.path.remote}`:'',r.connection&&`pc=${r.connection}`,r.ice&&`ice=${r.ice}`,r.offset!==undefined&&`saved=${r.offset}`,r.bytesPerSecond!==undefined&&`${(r.bytesPerSecond/1048576).toFixed(2)} MiB/s`,r.rttMs!==undefined&&`rtt=${r.rttMs}ms`,r.ackMs!==undefined&&`ack=${r.ackMs}ms`,r.socketDrops!==undefined&&`drops=${r.socketDrops}`].filter(Boolean).join(' ');
  console.log(`${fmt.format(new Date(r.receivedAt))} | ${r.device.slice(0,4)}→${r.peer?.slice(0,4)||'—'} ${r.role||'link'} | ${(r.transfer||r.attempt||'—').slice(0,12)} | #${r.seq} ${r.event} ${details}`);
}
if(!options.json){
  console.log(`\nEvents: ${count}. Transfers: ${groups.size}.`);
  for(const g of groups.values())console.log(`${g.id} | ${(g.total/1048576).toFixed(2)} MiB | peak ${ (g.peak/1048576).toFixed(2)} MiB/s | completed: ${[...g.roles].join(', ')||'unknown'} | errors: ${[...g.errors].join(', ')||'none reported'}`);
}
if(damaged)console.error(`Skipped ${damaged} malformed/truncated lines (across read passes).`);
