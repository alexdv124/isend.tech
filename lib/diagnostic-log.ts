import {identityHeaders} from './browser-identity';
import {randomKey} from './transfer';
export type DiagnosticData=Record<string,unknown>;

// Classify locally: messages can include filenames or arbitrary remote text.
export function diagnosticError(value:unknown):string{
  const s=value instanceof Error?value.name+' '+value.message:String(value??'');
  if(/порядок блоков|порядка блоков|BlockSequence/i.test(s))return 'sequence';
  if(/подтверждение записи/i.test(s))return 'ack';
  if(/контрольн|checksum|hash mismatch/i.test(s))return 'checksum';
  if(/не полностью/i.test(s))return 'incomplete';
  if(/quota|место|квот|лимит.*хранил/i.test(s))return 'quota';
  if(/запис|сохран|storage|IndexedDB|OPFS/i.test(s))return 'storage';
  if(/NotAllowed|SecurityError|разрешени/i.test(s))return 'permission';
  if(/отклонил/i.test(s))return 'declined';
  if(/занят/i.test(s))return 'busy';
  if(/формат|Неверн.*блок|Неверн.*сообщ|Обновите/i.test(s))return 'format';
  if(/докачк/i.test(s))return 'resume';
  if(/слишком много данных/i.test(s))return 'queue';
  if(/Timeout|таймаут/i.test(s))return 'timeout';
  if(/сервер|параметр.*связ|подготовка связи|запрос|ответ/i.test(s))return 'signaling';
  if(/Канал|канал/i.test(s))return 'channel';
  if(/связ|Связ|соедин|Соедин|Сеть|Network|Failed to fetch/i.test(s))return 'network';
  return 'unknown';
}
function environment():DiagnosticData{
  const ua=navigator.userAgent;
  const browser=/Edg\//.test(ua)?'Edge':/OPR\//.test(ua)?'Opera':/Firefox\//.test(ua)?'Firefox':/Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':'Other';
  const major=ua.match(browser==='Safari'?/Version\/(\d+)/:browser==='Edge'?/Edg\/(\d+)/:browser==='Opera'?/OPR\/(\d+)/:browser==='Firefox'?/Firefox\/(\d+)/:/Chrome\/(\d+)/);
  return {browser,browserMajor:major?Number(major[1]):undefined,os:/Android/.test(ua)?'Android':/iPhone|iPad/.test(ua)?'iOS':/Windows/.test(ua)?'Windows':/Mac/.test(ua)?'macOS':/Linux/.test(ua)?'Linux':'Other'};
}
export class DiagnosticLog{
  private session=randomKey();private seq=0;private started=performance.now();private queue:DiagnosticData[]=[];
  private registeredOnce=false;private foundDevice=false;
  private busy=false;private failures=0;private retryAt=0;private dropped=0;private stopped=false;
  private timer:ReturnType<typeof setInterval>;private env=environment();
  constructor(private room:string,private device:string,private context:()=>DiagnosticData[]){
    this.timer=setInterval(()=>void this.flush(),5000);
    document.addEventListener('visibilitychange',this.visibility);window.addEventListener('pagehide',this.exit);
    this.event('page_view');
  }
  registered(){if(this.registeredOnce||this.stopped)return;this.registeredOnce=true;void this.flush();}
  devicesFound(count:number){if(this.foundDevice||this.stopped||count<1)return;this.foundDevice=true;this.event('device_found',{peerCount:count});}
  event(event:string,data:DiagnosticData={}){
    if(this.stopped)return;
    if(this.queue.length>=128){this.queue.shift();this.dropped++;}
    const network=(navigator as Navigator&{connection?:{type?:string;effectiveType?:string}}).connection;
    this.queue.push({...this.env,...data,event,session:this.session,seq:++this.seq,clientAt:Date.now(),elapsedMs:performance.now()-this.started,revision:28,visibility:document.hidden?'hidden':'visible',online:navigator.onLine,networkType:network?.type,effectiveType:network?.effectiveType,droppedEvents:this.dropped});
  }
  private visibility=()=>{for(const c of this.context())this.event('visibility',c);if(document.hidden)void this.flush(true);};
  private exit=()=>{for(const c of this.context())this.event('page_exit',c);void this.flush(true);};
  async flush(urgent=false){
    if(this.busy||!this.queue.length||!urgent&&Date.now()<this.retryAt)return;
    this.busy=true;const batch=this.queue.splice(0,12);
    try{
      const response=await fetch('/api/diagnostics?device='+this.device,{method:'POST',headers:{...identityHeaders(),Authorization:`Bearer ${this.room}`,'Content-Type':'application/json'},body:JSON.stringify({events:batch}),keepalive:true,signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw new Error('diagnostics_unavailable');
      this.failures=0;this.retryAt=0;
    }catch{
      const merged=[...batch,...this.queue];this.dropped+=Math.max(0,merged.length-128);this.queue=merged.slice(-128);
      this.retryAt=Date.now()+Math.min(60000,5000*2**Math.min(4,this.failures++));
    }finally{this.busy=false;}
  }
  stop(){this.exit();this.stopped=true;clearInterval(this.timer);document.removeEventListener('visibilitychange',this.visibility);window.removeEventListener('pagehide',this.exit);}
}
