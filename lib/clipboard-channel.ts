import {diagnosticError,type DiagnosticData} from './diagnostic-log';
import {identityHeaders} from './browser-identity';
import {MAX_TEXT_BYTES,textFile} from './clipboard';
import {ClipboardStore,type TextRecord} from './clipboard-store';
import {randomKey} from './transfer';
import {sdpCandidates} from './sdp-candidates';
import type {Peer} from './signaling';
import type {LocalFile} from './p2p';
export type ClipboardState={phase:'connecting'|'ready'|'sending'|'sent'|'error';route:'direct'|'relay'|null;message?:string;deliveryMs?:number};
type Pending={id:string;text:string;bytes:Uint8Array;hash?:string;at?:number;waitingUntil?:number;started:number;prepared?:boolean};
type Signal={id:string;from:string;to:string;type:'offer'|'answer';sdp:string};
type Link={peer:string;id:string;pc:RTCPeerConnection;channel?:RTCDataChannel;role:'offer'|'answer';remoteSdp:string;created:number;lastRx:number;pingAt:number;publishing?:ReturnType<typeof setTimeout>;queue:Promise<void>;queued:number;pumping:boolean;incoming?:{id:string;size:number;bytes:Uint8Array;offset:number};route:'direct'|'relay'|null;closing:boolean};
const valid=/^[a-f0-9]{48}$/;
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),b=>b.toString(16).padStart(2,'0')).join('');
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

// Independent persistent channels are prepared as soon as both pages appear.
// File and text channels share ICE/DTLS, with separate application queues.
export class ClipboardChannel{
  private peers=new Map<string,Peer>();private links=new Map<string,Link>();private pending=new Map<string,Pending[]>();
  private states:Record<string,ClipboardState>={};private building=new Set<string>();private retryAt=new Map<string,number>();
  private seen=new Set<string>();private publications=Promise.resolve();private stopped=false;private polling=false;private nextPoll=0;private registered=false;
  private store:ClipboardStore;private timer:ReturnType<typeof setInterval>;private epoch=0;
  private selected='';
  constructor(private room:string,private device:string,private hooks:{diagnostic?:(event:string,data:DiagnosticData)=>void;file:(file:LocalFile)=>void;state:(states:Record<string,ClipboardState>)=>void;beforeSend?:(peer:string)=>Promise<void>;authorize?:(peer:string,size:number)=>Promise<boolean>;incomingFile?:(peer:string,pc:RTCPeerConnection,channel:RTCDataChannel)=>void}){
    this.store=new ClipboardStore(room);void this.restore();this.timer=setInterval(()=>void this.tick(),1000);
    document.addEventListener('visibilitychange',this.wake);window.addEventListener('online',this.wake);window.addEventListener('pageshow',this.wake);
  }
  private log(event:string,c:Link,extra:DiagnosticData={}){
    const p=this.pending.get(c.peer)?.[0],m=c.incoming;
    this.hooks.diagnostic?.(event,{payload:'text',attempt:c.id,peer:c.peer,transfer:m?.id||p?.id,role:m?'receive':p?'send':undefined,total:m?.size??p?.bytes.length,offset:m?.offset,connection:c.pc.connectionState,ice:c.pc.iceConnectionState,channel:c.channel?.readyState,route:c.route,...extra});
  }
  diagnosticContext():DiagnosticData[]{const rows:DiagnosticData[]=[];for(const [peer,queue] of this.pending)for(const p of queue)rows.push({payload:'text',role:'send',peer,transfer:p.id,total:p.bytes.length});for(const c of this.links.values())if(c.incoming)rows.push({payload:'text',role:'receive',peer:c.peer,transfer:c.incoming.id,total:c.incoming.size,offset:c.incoming.offset});return rows;}
  private wake=()=>{this.nextPoll=0;void this.tick();};
  private emit(peer:string,state:Partial<ClipboardState>){
    const previous=this.states[peer],next:ClipboardState={...(previous||{phase:'connecting',route:null}),...state};
    // Reconnecting must not erase a failed-delivery warning. A new explicit
    // send clears it; the draft remains available in the UI for that retry.
    if(previous?.phase==='error'&&state.phase!=='sending'&&state.phase!=='error'){next.phase='error';next.message=previous.message;}
    this.states[peer]=next;if(!this.stopped)this.hooks.state({...this.states});
  }
  private file(r:TextRecord,direction:'sent'|'received'){
    if(!this.stopped)this.hooks.file({id:r.id,name:'Текст',size:r.size,url:'',direction,complete:true,payloadKind:'text',text:r.text});
  }
  private async restore(){try{for(const r of await this.store.list())this.file(r,'received');}catch{/* A failed write is reported before acknowledging any text. */}}
  sync(peers:Peer[]){
    this.registered=true;this.peers=new Map(peers.filter(p=>p.clipboard===1).map(p=>[p.id,p]));
    for(const [id,c] of this.links)if(!this.peers.has(id))this.drop(c);
    void this.tick();
  }
  select(peer:string){this.selected=peer;this.nextPoll=0;void this.tick();}
  fileChannel(peer:string){const c=this.links.get(peer);return this.peers.get(peer)?.warm===1&&c?.channel?.readyState==='open'?{pc:c.pc,channel:c.pc.createDataChannel('file-v3',{ordered:true})}:null;}
  send(text:string,to:string){
    try{
      textFile(text);if(!this.peers.has(to))throw new Error('Обновите Переброс на втором устройстве.');
      const queue=this.pending.get(to)||[];if(queue.length>=8)throw new Error('Дождитесь доставки предыдущих текстов.');
      const p={id:randomKey(),text,bytes:new TextEncoder().encode(text),started:performance.now()};queue.push(p);this.pending.set(to,queue);
      this.hooks.diagnostic?.('requested',{payload:'text',role:'send',peer:to,transfer:p.id,total:p.bytes.length});
      this.emit(to,{phase:'sending',message:undefined});const c=this.links.get(to);if(c?.channel?.readyState==='open')void this.pump(c);else{this.nextPoll=0;void this.tick();}return true;
    }catch(e){this.hooks.diagnostic?.('error',{payload:'text',role:'send',peer:to,error:diagnosticError(e)});this.emit(to,{phase:'error',message:e instanceof Error?e.message:'Не удалось отправить текст.'});return false;}
  }
  busy(){return [...this.pending.values()].some(q=>q.length>0)||[...this.links.values()].some(c=>!!c.incoming);}
  async clear(){if([...this.pending.values()].some(q=>q.length))throw new Error('Дождитесь отправки текста.');await this.store.clear();}
  networkChanged(){this.epoch++;for(const c of [...this.links.values()])this.drop(c);this.retryAt.clear();this.nextPoll=0;void this.tick();}
  stop(){this.stopped=true;this.epoch++;clearInterval(this.timer);document.removeEventListener('visibilitychange',this.wake);window.removeEventListener('online',this.wake);window.removeEventListener('pageshow',this.wake);for(const c of [...this.links.values()])this.drop(c);this.store.stop();}
  private current(c:Link){return !this.stopped&&!c.closing&&this.links.get(c.peer)===c;}
  private drop(c:Link,message?:string){
    if(c.closing)return;this.log('connection',c,{channel:'closed'});c.closing=true;clearTimeout(c.publishing);this.links.delete(c.peer);c.channel?.close();c.pc.close();
    const first=this.pending.get(c.peer)?.[0];if(first)first.at=undefined;
    this.retryAt.set(c.peer,Date.now()+2000);this.emit(c.peer,{phase:'connecting',route:null,message});
  }
  private async request(path:string,body?:unknown){
    const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{...identityHeaders(),Authorization:`Bearer ${this.room}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('Подключаем текстовый канал…');return r.json();
  }
  private publish(c:Link){
    const task=this.publications.catch(()=>{}).then(async()=>{
      if(!this.current(c)||!c.pc.localDescription)return;
      await this.request(`/api/text-signals?device=${this.device}`,{to:c.peer,id:c.id,type:c.role,sdp:c.pc.localDescription.sdp});
    });this.publications=task;return task;
  }
  private async create(peer:string,id:string,role:'offer'|'answer'){
    if(this.building.has(peer)||this.links.size+this.building.size>=8)return null;this.building.add(peer);const epoch=this.epoch;
    try{
      const config=await this.request(`/api/ice?device=${this.device}`);if(this.stopped||epoch!==this.epoch)return null;
      const pc=new RTCPeerConnection({iceServers:config.iceServers,iceTransportPolicy:'all',bundlePolicy:'max-bundle'});
      // Reused by file channels too; retain the larger bundled UDP socket path.
      try{pc.addTransceiver('video',{direction:'sendrecv'});}catch{}
      const c:Link={peer,id,pc,role,created:Date.now(),lastRx:Date.now(),pingAt:0,remoteSdp:'',queue:Promise.resolve(),queued:0,pumping:false,route:null,closing:false};this.links.set(peer,c);this.log('connection',c);
      pc.onicecandidate=()=>{if(!this.current(c))return;clearTimeout(c.publishing);c.publishing=setTimeout(()=>{void this.publish(c).catch(()=>{});},250);};
      pc.ondatachannel=e=>{if(e.channel.label==='file-v3'&&this.hooks.incomingFile)this.hooks.incomingFile(c.peer,pc,e.channel);else if(e.channel.label==='clipboard-v1')this.wire(c,e.channel);else e.channel.close();};
      pc.onconnectionstatechange=()=>{if(!this.current(c))return;this.log('connection',c);if(['failed','closed'].includes(pc.connectionState))this.drop(c);};
      this.emit(peer,{phase:this.pending.get(peer)?.length?'sending':'connecting',route:null,message:undefined});return c;
    }finally{this.building.delete(peer);}
  }
  private async offer(peer:string){
    let c:Link|null=null;
    try{c=await this.create(peer,randomKey(),'offer');if(!c)return;this.wire(c,c.pc.createDataChannel('clipboard-v1',{ordered:true}));await c.pc.setLocalDescription(await c.pc.createOffer());await this.publish(c);}
    catch{if(c&&this.current(c))this.drop(c);else this.retryAt.set(peer,Date.now()+5000);}
  }
  private async handleSignal(s:Signal){
    if(!this.peers.has(s.from)||!valid.test(s.id)||s.to!==this.device)return;
    let c=this.links.get(s.from);
    if(s.type==='offer'){
      if(s.from>this.device)return; // One deterministic initiator, no offer collision.
      if(!c||c.id!==s.id){
        if(this.seen.has(s.id))return;if(c)this.drop(c);this.seen.add(s.id);if(this.seen.size>256)this.seen.delete(this.seen.values().next().value!);
        c=(await this.create(s.from,s.id,'answer'))||undefined;if(!c)return;
        try{await c.pc.setRemoteDescription({type:'offer',sdp:s.sdp});c.remoteSdp=s.sdp;await c.pc.setLocalDescription(await c.pc.createAnswer());await this.publish(c);}catch{this.drop(c);}return;
      }
    }
    if(!c||c.id!==s.id||!this.current(c))return;
    try{
      if(!c.pc.remoteDescription&&s.type==='answer'){await c.pc.setRemoteDescription({type:'answer',sdp:s.sdp});c.remoteSdp=s.sdp;}
      else if(c.remoteSdp!==s.sdp){const key=(v:RTCIceCandidateInit)=>v.sdpMid+'|'+v.candidate,old=new Set(sdpCandidates(c.remoteSdp).map(key));for(const v of sdpCandidates(s.sdp))if(!old.has(key(v)))await c.pc.addIceCandidate(v);c.remoteSdp=s.sdp;}
    }catch{this.drop(c);}
  }
  private async tick(){
    if(this.stopped||!this.registered||document.hidden||!navigator.onLine)return;
    const now=Date.now();
    for(const c of [...this.links.values()]){
      if(c.channel?.readyState==='open'){
        const pending=this.pending.get(c.peer)?.[0];
        if(now-c.lastRx>35000||pending?.at&&now>Math.max(pending.at+8000,pending.waitingUntil||0)){this.drop(c);continue;}
        if(now-c.pingAt>10000){c.pingAt=now;try{c.channel.send('{"kind":"ping"}');}catch{this.drop(c);}}
      }else if(now-c.created>30000)this.drop(c);
    }
    for(const p of this.peers.values())if(this.device<p.id&&(p.id===this.selected||p.preferred===this.device||p.warm!==1)&&now-p.seenAt<30000&&!this.links.has(p.id)&&!this.building.has(p.id)&&now>=(this.retryAt.get(p.id)||0)&&this.links.size+this.building.size<8)void this.offer(p.id);
    if(this.polling||now<this.nextPoll)return;this.polling=true;this.nextPoll=now+([...this.peers.values()].filter(p=>p.id===this.selected||p.preferred===this.device||p.warm!==1).every(p=>this.links.get(p.id)?.channel?.readyState==='open')?4000:1000);
    try{const value=await this.request(`/api/text-signals?device=${this.device}`);if(!this.stopped)for(const s of value.signals||[])await this.handleSignal(s);}catch{/* Presence retry keeps the UI usable during a brief outage. */}finally{this.polling=false;}
  }
  private wire(c:Link,channel:RTCDataChannel){
    c.channel=channel;channel.binaryType='arraybuffer';
    channel.onclose=()=>{if(this.current(c))this.drop(c);};channel.onerror=()=>{if(this.current(c))this.drop(c);};
    channel.onopen=()=>{if(!this.current(c))return;this.log('channel',c);c.lastRx=Date.now();this.emit(c.peer,{phase:this.pending.get(c.peer)?.length?'sending':'ready',message:undefined});void this.route(c);void this.pump(c);};
    channel.onmessage=e=>{
      c.lastRx=Date.now();const n=typeof e.data==='string'?e.data.length:e.data.byteLength;c.queued+=n;
      if(c.queued>MAX_TEXT_BYTES+65536){this.drop(c);return;}
      c.queue=c.queue.then(async()=>{try{if(this.current(c))await this.message(c,e.data);}catch(e){if(this.current(c)){this.log('error',c,{error:diagnosticError(e)});try{channel.send(JSON.stringify({kind:'error',message:e instanceof Error?e.message:'Не удалось сохранить текст.'}));}catch{}this.drop(c);}}finally{c.queued-=n;}});
    };
  }
  private async route(c:Link){try{const stats=await c.pc.getStats();let pair:any;stats.forEach((s:any)=>{if(s.type==='transport'&&s.selectedCandidatePairId)pair=stats.get(s.selectedCandidatePairId);});if(!pair)stats.forEach((s:any)=>{if(s.type==='candidate-pair'&&s.state==='succeeded'&&s.nominated)pair=s;});if(pair&&this.current(c)){c.route=stats.get(pair.localCandidateId)?.candidateType==='relay'||stats.get(pair.remoteCandidateId)?.candidateType==='relay'?'relay':'direct';this.log('route',c,{route:c.route});this.emit(c.peer,{route:c.route});}}catch{}}
  private async message(c:Link,data:unknown){
    if(data instanceof ArrayBuffer){const m=c.incoming;if(!m||data.byteLength>16384||m.offset+data.byteLength>m.size)throw new Error('Неверный блок текста.');m.bytes.set(new Uint8Array(data),m.offset);m.offset+=data.byteLength;return;}
    if(typeof data!=='string'||data.length>1500)throw new Error('Неверное сообщение.');const v=JSON.parse(data),channel=c.channel!;
    if(v.kind==='ping'){channel.send('{"kind":"pong"}');return;}if(v.kind==='pong')return;
    if(v.kind==='start'){if(c.incoming||!valid.test(v.id)||!Number.isSafeInteger(v.size)||v.size<1||v.size>MAX_TEXT_BYTES)throw new Error('Неверный размер текста.');
      this.log('requested',c,{transfer:v.id,total:v.size,role:'receive'});
      if(this.peers.get(c.peer)?.warm===1&&this.hooks.authorize){channel.send(JSON.stringify({kind:'waiting',id:v.id}));if(!await this.hooks.authorize(c.peer,v.size))throw new Error('Получатель отклонил передачу.');}
      if(!this.current(c))return;c.incoming={id:v.id,size:v.size,bytes:new Uint8Array(v.size),offset:0};return;}
    if(v.kind==='waiting'){const p=this.pending.get(c.peer)?.[0];if(p&&p.id===v.id)p.waitingUntil=Date.now()+120000;return;}
    if(v.kind==='end'){
      const m=c.incoming;if(!m||v.id!==m.id||m.offset!==m.size||v.hash!==await digest(m.bytes))throw new Error('Текст получен не полностью.');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(m.bytes),record=await this.store.save(m.id,text,m.size);c.incoming=undefined;
      if(!this.current(c))return;this.log('complete',c,{transfer:m.id,total:m.size,offset:m.size,role:'receive',complete:true});this.file(record,'received');channel.send(JSON.stringify({kind:'ack',id:m.id}));return;
    }
    if(v.kind==='ack'){
      const q=this.pending.get(c.peer),p=q?.[0];if(!p||v.id!==p.id)return;
      this.log('complete',c,{transfer:p.id,total:p.bytes.length,offset:p.bytes.length,role:'send',complete:true,deliveryMs:Math.round(performance.now()-p.started)});
      q!.shift();this.file({id:p.id,text:p.text,size:p.bytes.length,room:this.room,key:'',updatedAt:Date.now()},'sent');this.emit(c.peer,{phase:q!.length?'sending':'sent',deliveryMs:Math.round(performance.now()-p.started),message:undefined});void this.pump(c);return;
    }
    if(v.kind==='error'){for(const p of this.pending.get(c.peer)||[])this.log('error',c,{transfer:p.id,role:'send',error:diagnosticError(v.message),permanent:true});this.pending.delete(c.peer);this.emit(c.peer,{phase:'error',message:typeof v.message==='string'?v.message.slice(0,200):'Не удалось сохранить текст.'});return;}
    throw new Error('Обновите страницы на обоих устройствах.');
  }
  private async pump(c:Link){
    const p=this.pending.get(c.peer)?.[0],ch=c.channel;if(!p||p.at||c.pumping||!this.current(c)||ch?.readyState!=='open')return;c.pumping=true;
    try{
      if(!p.prepared){try{await this.hooks.beforeSend?.(c.peer);p.prepared=true;}catch(e){for(const p of this.pending.get(c.peer)||[])this.log('error',c,{transfer:p.id,role:'send',error:diagnosticError(e),permanent:true});this.pending.delete(c.peer);this.emit(c.peer,{phase:'error',message:e instanceof Error?e.message:'Не удалось отправить текст.'});return;}}if(!this.current(c))return;
      p.hash ||= await digest(p.bytes);if(!this.current(c))return;
      ch.send(JSON.stringify({kind:'start',id:p.id,size:p.bytes.length}));
      for(let at=0;at<p.bytes.length;at+=16384){while(ch.bufferedAmount>65536){await pause(4);if(!this.current(c))return;}if(!this.current(c))return;ch.send(p.bytes.slice(at,at+16384));}
      ch.send(JSON.stringify({kind:'end',id:p.id,hash:p.hash}));p.at=Date.now();
    }catch{if(this.current(c))this.drop(c);}finally{c.pumping=false;}
  }
}
