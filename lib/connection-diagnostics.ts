export type SendStage='prepare'|'channel'|'ack'|'dispatch';
export type SendTiming=Record<SendStage,number>&{total:number};
export type SenderDiagnostics={timing:SendTiming;ackMs:number|null;bufferedBytes:number;windowBytes:number;socketDrops:number|null;socketDropsSinceStart?:boolean;pacingMs?:number};

// Exclusive wall-clock stages, not CPU time. Prefetch can run concurrently,
// but only time actually blocking the send pump belongs to "prepare".
export class SendClock{
  private times:Record<SendStage,number>={prepare:0,channel:0,ack:0,dispatch:0};
  private stage:SendStage='prepare';
  private at:number;
  private stopped=false;
  constructor(private start:number){this.at=start;}
  set(stage:SendStage,now:number){if(this.stopped)return;this.times[this.stage]+=Math.max(0,now-this.at);this.at=now;this.stage=stage;}
  stop(now:number){this.set(this.stage,now);this.stopped=true;}
  sample(now:number):SendTiming{
    const times={...this.times};if(!this.stopped)times[this.stage]+=Math.max(0,now-this.at);
    return {...times,total:Math.max(0,(this.stopped?this.at:now)-this.start)};
  }
}

const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
export function parseSenderDiagnostics(value:any):SenderDiagnostics|null{
  const t=value?.timing;
  if(!t||!(['prepare','channel','ack','dispatch','total'] as const).every(k=>finite(t[k])))return null;
  if(Math.abs(t.prepare+t.channel+t.ack+t.dispatch-t.total)>1)return null;
  if(!finite(value.bufferedBytes)||!finite(value.windowBytes))return null;
  return {timing:{prepare:t.prepare,channel:t.channel,ack:t.ack,dispatch:t.dispatch,total:t.total},ackMs:finite(value.ackMs)?value.ackMs:null,bufferedBytes:value.bufferedBytes,windowBytes:value.windowBytes,socketDrops:finite(value.socketDrops)?value.socketDrops:null,...(value.socketDropsSinceStart===true?{socketDropsSinceStart:true}:{}),...(finite(value.pacingMs)?{pacingMs:value.pacingMs}:{})};
}

export type AddressKind='private'|'public'|'loopback'|'shared'|'hidden';
export type CandidateKind='host'|'srflx'|'prflx'|'relay'|'unknown';
export type PathInfo={local:CandidateKind;remote:CandidateKind;localAddress:AddressKind;remoteAddress:AddressKind;protocol:'udp'|'tcp'|'unknown'};
export type NetworkSample={path:PathInfo;rttMs:number|null;bytesPerSecond:number|null;socketDrops:number|null};
type Stats={get:(id:string)=>any;forEach:(callback:(report:any)=>void)=>void};

export function addressKind(value:unknown):AddressKind{
  if(typeof value!=='string'||!value)return 'hidden';
  const address=value.toLowerCase().replace(/^\[|\]$/g,'').replace(/^::ffff:(?=\d+\.)/,'');
  if(address.endsWith('.local'))return 'hidden';
  if(/^\d+\.\d+\.\d+\.\d+$/.test(address)){
    const [a,b,...rest]=address.split('.').map(Number);if([a,b,...rest].some(n=>n>255))return 'hidden';
    if(a===127)return 'loopback';
    if(a===10||a===192&&b===168||a===172&&b>=16&&b<=31||a===169&&b===254)return 'private';
    if(a===100&&b>=64&&b<=127)return 'shared';
    return a===0?'hidden':'public';
  }
  if(address==='::1'||address==='0:0:0:0:0:0:0:1')return 'loopback';
  if(address.includes(':')&&/^[a-f0-9:]+$/.test(address)){
    if(address==='::')return 'hidden';const first=parseInt(address.split(':')[0],16);
    return (first&0xfe00)===0xfc00||(first&0xffc0)===0xfe80?'private':'public';
  }
  return 'hidden';
}
const candidate=(value:unknown):CandidateKind=>['host','srflx','prflx','relay'].includes(value as string)?value as CandidateKind:'unknown';

export class NetworkDiagnostics{
  private previous:{id:string;bytes:number;at:number}|null=null;
  private dropSamples=new Map<string,{at:number;count:number}>();
  private transferDrops=0;
  sample(stats:Stats,role:'send'|'receive'):NetworkSample|null{
    let pair:any;
    stats.forEach(report=>{if(report.type==='transport'&&report.selectedCandidatePairId)pair=stats.get(report.selectedCandidatePairId);});
    if(!pair)stats.forEach(report=>{if(report.type==='candidate-pair'&&report.nominated&&report.state==='succeeded')pair=report;});
    if(!pair)return null;
    const local=stats.get(pair.localCandidateId),remote=stats.get(pair.remoteCandidateId);
    const bytes=role==='send'?pair.bytesSent:pair.bytesReceived,at=pair.timestamp;
    let bytesPerSecond:number|null=null;
    if(finite(bytes)&&finite(at)){
      const old=this.previous;
      if(old&&old.id===pair.id&&at>old.at&&bytes>=old.bytes)bytesPerSecond=(bytes-old.bytes)*1000/(at-old.at);
      this.previous={id:pair.id,bytes,at};
    }else this.previous=null;
    // A preconnected PC may have already transferred other files. Its lifetime
    // counter must not be attributed to this file. Ignore stale getStats replies.
    let socketDrops:number|null=null;
    if(finite(pair.packetsDiscardedOnSend)&&finite(at)){
      const old=this.dropSamples.get(pair.id),count=pair.packetsDiscardedOnSend;
      if(!old||at>old.at){
        if(old)this.transferDrops+=Math.max(0,count-old.count);
        this.dropSamples.set(pair.id,{at,count});
      }
      socketDrops=this.transferDrops;
    }
    return {path:{local:candidate(local?.candidateType),remote:candidate(remote?.candidateType),localAddress:addressKind(local?.address),remoteAddress:addressKind(remote?.address),protocol:local?.protocol==='udp'||local?.protocol==='tcp'?local.protocol:'unknown'},rttMs:finite(pair.currentRoundTripTime)?pair.currentRoundTripTime*1000:null,bytesPerSecond,socketDrops};
  }
}
