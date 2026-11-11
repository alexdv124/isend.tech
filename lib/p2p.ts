import type {SaveHandle} from './direct-file-store';
import {PeerSelection} from './peer-selection';
import {DiagnosticLog,diagnosticError,type DiagnosticData} from './diagnostic-log';
import {identityHeaders,identityIsSaved,type PairingState} from './browser-identity';
import {ClipboardChannel,type ClipboardState} from './clipboard-channel';
import {rankPeers,deviceName} from './peers';
import {validPayload,type PayloadKind} from './clipboard';
import {randomKey} from './transfer';
import {DiskStore,type DiskRecord} from './disk-store';
import {BlockSequenceError,blockSequenceIssue,parseSequenceIssue,sequenceRecoveryAllowed,type BlockSequenceIssue} from './block-sequence';
import {TransferMeter,type TransferMeasurement} from './transfer-meter';
import {BufferedFileReader} from './buffered-file-reader';
import {PacketPacer} from './packet-pacer';
import {sendQueue} from './send-queue';
import {sdpCandidates} from './sdp-candidates';
import {signalingError} from './signaling-error';
import {watchNetworkChanges,type NetworkInformation} from './network-change';
import {NetworkDiagnostics,SendClock,parseSenderDiagnostics,type NetworkSample,type SenderDiagnostics} from './connection-diagnostics';
import type {Peer,Signal} from './signaling';
export type LocalFile={id:string;name:string;size:number;url:string;direction:'sent'|'received';offset?:number;complete?:boolean;payloadKind?:PayloadKind;text?:string;destination?:'file';savedName?:string};
export type ReceiveRequest={peer:string;name:string;size:number;kind:'file'|'text'};
export type TransferStatus='ready'|'connecting'|'sending'|'receiving'|'sent'|'received'|'reconnecting'|'retry'|'error';
export type RouteMode='idle'|'finding'|'direct'|'relay';
export type TransferMetrics=TransferMeasurement&{rttMs:number|null;readMsPerMiB:number|null;fileReadMsPerMiB:number|null;hashMsPerMiB:number|null;writeMsPerMiB:number|null;peerRevision:number|null;windowBytes:number;network:NetworkSample|null;sender:SenderDiagnostics|null;cancelled?:boolean;sequenceIssue?:BlockSequenceIssue;sequenceRecoveries?:number};
type Hooks={saveFile?:(request:ReceiveRequest)=>Promise<SaveHandle|null>;selection?:(peer:string)=>void;pairing?:(state:PairingState)=>void;cancelReceive?:(peer:string)=>void;authorize?:(request:ReceiveRequest)=>Promise<boolean>;clipboard?:(states:Record<string,ClipboardState>)=>void;peer?:(id:string,role:'send'|'receive')=>void;peers:(peers:Peer[])=>void;online:(online:boolean,message?:string)=>void;status:(state:TransferStatus,progress:number,message:string)=>void;file:(file:LocalFile)=>void;route:(mode:RouteMode)=>void;relay:(available:boolean)=>void;metrics:(metrics:TransferMetrics|null)=>void};
type Meta={kind:'start';version:3;id:string;name:string;size:number;blockSize:number;revision?:number;payloadKind?:PayloadKind};
type Block={offset:number;length:number;hash:string;buffer:Uint8Array;bytes:number};
type ConnectionDiagnostics={pacer:PacketPacer;pacingMs:number;networkStats:NetworkDiagnostics;networkSample?:NetworkSample;clock?:SendClock;remoteSender?:SenderDiagnostics;ackTimes:Map<number,number>;ackTotalMs:number;ackCount:number};
type Connection=ConnectionDiagnostics&{journalMeta?:{id:string;size:number;payloadKind?:PayloadKind};journalStage?:string;lastJournalSample?:number;lastJournalRoute?:string;shared?:boolean;cleanup?:()=>void;pc:RTCPeerConnection;channel?:RTCDataChannel;id:string;peer:string;role:'send'|'receive';timer?:ReturnType<typeof setTimeout>;meta?:Meta;block?:Block;offset:number;sendOffset:number;acknowledgements:number[];windowBlocks:number;checkpointBlocks:number;pumping:boolean;endSent:boolean;lastProgress:number;complete:boolean;started:boolean;queue:Promise<void>;queuedBytes:number;relayAvailable:boolean;remoteSdp?:string;meter?:TransferMeter;reader?:BufferedFileReader;rttMs:number|null;hashMs:number;hashBytes:number;writeMs:number;writeBytes:number;remoteReadMsPerMiB:number|null;remoteFileReadMsPerMiB:number|null;remoteHashMsPerMiB:number|null;remoteWriteMsPerMiB:number|null;peerRevision:number|null};
type Pending={file:File;id:string;to:string;payloadKind:PayloadKind;sequenceRecoveries:number};
const BLOCK_SIZE=262144, PACKET_SIZE=16384, WINDOW_BLOCKS=16, CHECKPOINT_BLOCKS=4;
// Keep the application queue small even with a larger durable-ACK window.
// This limits bursts into SCTP/UDP; unacknowledged bytes and queued bytes are
// different budgets. bufferedamountlow replenishes the queue without polling.
const keyPattern=/^[a-f0-9]{48}$/;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const hash=async(buffer:BufferSource)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('');

// File names, hashes and bytes travel only inside the encrypted RTCDataChannel.
// ICE may select a direct pair or TURN; neither signaling nor TURN stores files.
export class DirectTransfer{
  private journal:DiagnosticLog;private lastJournalState='';private journalOnline:boolean|null=null;
  private signal:Signal|null=null;
  private active:Connection|null=null;
  private pending:Pending|null=null;
  private manualRetryNeeded=false;
  private sequenceIssue:BlockSequenceIssue|undefined;
  private incomingFileId='';
  private stopped=false;
  private polling=false;private repoll=false;
  private opening=false;
  private connectionEpoch=0;
  private publications=Promise.resolve();
  private interval:ReturnType<typeof setInterval>;
  private meterInterval:ReturnType<typeof setInterval>;
  private retryTimer?:ReturnType<typeof setTimeout>;
  private retries=0;
  private confirmed=0;
  private seenOffers=new Set<string>();
  private ownName:string;
  private selection:PeerSelection;
  private preferred='';private peers:Peer[]=[];private approved=new Set<string>();
  private discoveryToken:string;
  private pairingTime=0;
  private disk:DiskStore;
  private clipboard:ClipboardChannel;
  private stopNetworkWatch:()=>void;
  constructor(private room:string,private device:string,private hooks:Hooks){
    let preferredPair='';try{preferredPair=localStorage.getItem('isend-preferred-pair')||'';}catch{}
    this.selection=new PeerSelection(preferredPair,pair=>{try{if(pair)localStorage.setItem('isend-preferred-pair',pair);else localStorage.removeItem('isend-preferred-pair');}catch{}});
    this.journal=new DiagnosticLog(room,device,()=>[...(this.active||this.pending?[this.journalData()]:[]),...(this.clipboard?.diagnosticContext()||[])]);
    this.ownName=deviceName(navigator.userAgent);
    this.discoveryToken=sessionStorage.getItem('perebros-discovery-token')||randomKey();sessionStorage.setItem('perebros-discovery-token',this.discoveryToken);
    try{this.approved=new Set(JSON.parse(sessionStorage.getItem('isend-approved-'+device)||'[]').filter((id:unknown)=>typeof id==='string'&&keyPattern.test(id)));}catch{}

    this.disk=new DiskStore(room);
    this.clipboard=new ClipboardChannel(room,device,{diagnostic:(event,data)=>this.journal.event(event,data),file:hooks.file,state:states=>hooks.clipboard?.(states),beforeSend:peer=>this.beforeSend(peer),authorize:(peer,size)=>this.authorize({peer,size,name:'Текст',kind:'text'}),incomingFile:(peer,pc,channel)=>this.receiveWarm(peer,pc,channel)});
    this.interval=setInterval(()=>{void this.poll();if(this.active?.pc.connectionState==='connected')void this.route(this.active);},2500);
    this.meterInterval=setInterval(()=>{if(this.active?.meter&&!this.active.complete)this.emitMetrics(this.active);},500);
    document.addEventListener('visibilitychange',this.wake);window.addEventListener('online',this.wake);window.addEventListener('pageshow',this.wake);
    this.stopNetworkWatch=watchNetworkChanges(window,(navigator as Navigator&{connection?:NetworkInformation}).connection,this.networkChanged);
    void this.restore();void this.poll();
  }
  private async restore(){try{for(const record of await this.disk.list()){if(this.stopped)return;await this.localFile(record);}}catch{/* Receiving will report a storage error if this browser cannot write to disk. */}}
  private async localFile(record:DiskRecord){
    const file=record.complete&&record.destination!=='file'?await this.disk.file(record.id):null;
    const text=file&&record.payloadKind==='text'?await file.text():undefined;
    if(!this.stopped)this.hooks.file({id:record.id,name:record.name,size:record.size,url:file?URL.createObjectURL(file):'',direction:'received',offset:record.offset,complete:record.complete,payloadKind:record.payloadKind,text,destination:record.destination,savedName:record.savedName});
  }
  private wake=()=>{if(document.hidden)return;void this.poll();if(this.pending&&!this.active){clearTimeout(this.retryTimer);void this.begin();}};
  private networkChanged=()=>{
    if(this.stopped)return;
    if(this.active||this.pending)this.trace('network_change');
    this.retries=0;this.clipboard.networkChanged();
    const c=this.active;
    // Keep pending.file and its transfer ID. A new PeerConnection gathers
    // addresses from the new network and resumes at the receiver's checkpoint.
    // Closing a receiver's channel also triggers recovery in V13 senders.
    if(c&&!c.complete)this.fail(c,'Сеть изменилась. Выбираем маршрут заново и продолжаем передачу…');
    else if(!c&&this.pending){this.close();clearTimeout(this.retryTimer);void this.begin();}
    void this.poll();
  };
  private journalData(c:Connection|null=this.active):DiagnosticData{
    const p=c?.role==='receive'?null:this.pending,meta=c?.meta||c?.journalMeta;
    return {stage:c?.journalStage,transfer:meta?.id||p?.id,attempt:c?.id,peer:c?.peer||p?.to,role:c?.role||(p?'send':undefined),payload:meta?.payloadKind||p?.payloadKind||'file',total:meta?.size??p?.file.size,offset:c?.offset,sendOffset:c?.sendOffset,queuedBytes:c?.queuedBytes,bufferedBytes:c?.channel?.bufferedAmount,connection:c?.pc.connectionState,ice:c?.pc.iceConnectionState,gathering:c?.pc.iceGatheringState,channel:c?.channel?.readyState,relayAvailable:c?.relayAvailable,shared:c?.shared,retries:this.retries,sequenceRecoveries:p?.sequenceRecoveries,peerRevision:c?.peerRevision};
  }
  private trace(event:string,c:Connection|null=this.active,extra:DiagnosticData={}){this.journal.event(event,{...this.journalData(c),...extra});}
  private report(state:TransferStatus,progress=0,message=''){
    if(this.stopped)return;
    const context=this.journalData(),key=`${context.transfer||''}:${context.attempt||''}:${state}`;
    if((this.active||this.pending)&&key!==this.lastJournalState){this.lastJournalState=key;this.trace('state',this.active,{state,...(['retry','error','reconnecting'].includes(state)?{error:diagnosticError(message)}:{})});}
    this.hooks.status(state,progress,message);
  }
  private publish(){
    const next=this.publications.catch(()=>{}).then(async()=>{
      if(this.stopped)return;
      const response=await fetch('/api/peers',{method:'PUT',headers:{...identityHeaders(),Authorization:`Bearer ${this.room}`,'Content-Type':'application/json'},body:JSON.stringify({id:this.device,name:this.ownName,protocol:3,clipboard:1,warm:1,preferred:this.preferred,signal:this.signal}),signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw await signalingError(response);
      this.journal.registered();
    });this.publications=next;return next;
  }
  private async poll(){
    if(this.stopped||this.polling||document.hidden)return;this.polling=true;
    try{
      await this.publish();
      await this.discovery('presence').catch(()=>{});
      if(this.hooks.pairing)await this.pairingAction('status').catch(()=>{});
      const response=await fetch(`/api/peers?device=${this.device}`,{headers:{...identityHeaders(),Authorization:`Bearer ${this.room}`},cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw await signalingError(response);
      const data=await response.json() as {peers:Peer[]};if(this.stopped)return;
      if(this.journalOnline===false&&(this.active||this.pending))this.trace('signaling',this.active,{serverOnline:true});this.journalOnline=true;
      this.hooks.online(true);const peers=rankPeers(data.peers.filter(p=>p.id!==this.device),this.ownName);for(const old of this.peers)if(old.remembered&&!peers.find(p=>p.id===old.id)?.remembered){this.approved.delete(old.id);if(this.active?.peer===old.id)this.cancel();}
      this.journal.devicesFound(peers.filter(p=>Date.now()-p.seenAt<30000).length);
      this.peers=peers;this.hooks.peers(peers);
      this.select(this.selection.choose(peers,this.preferred,!!this.pending||!!this.active&&!this.active.complete||this.opening||this.clipboard.busy()),'auto');
      this.clipboard.sync(peers);
      for(const peer of peers){
        const signal=peer.signal;if(!signal||signal.to!==this.device)continue;
        const current=this.active;
        if(signal.type==='answer'&&current?.role==='send'&&current.id===signal.id){
          if(!current.pc.remoteDescription){await current.pc.setRemoteDescription({type:'answer',sdp:signal.sdp});current.remoteSdp=signal.sdp;}
          else if(current.remoteSdp!==signal.sdp)await this.addLateCandidates(current,signal.sdp);
        }else if(signal.type==='offer'){
          if(current?.role==='receive'&&current.id===signal.id){if(current.remoteSdp!==signal.sdp)await this.addLateCandidates(current,signal.sdp);}
          else if(!this.seenOffers.has(signal.id)){
            if(this.pending||Date.now()-peer.seenAt>120000||(current&&!current.complete&&current.peer!==peer.id))continue;
            this.seenOffers.add(signal.id);if(this.seenOffers.size>500)this.seenOffers.delete(this.seenOffers.values().next().value!);
            await this.accept(peer.id,signal);
          }
        }
      }
    }catch(error){if(this.journalOnline!==false&&(this.active||this.pending))this.trace('signaling',this.active,{error:diagnosticError(error),serverOnline:false});this.journalOnline=false;if(!this.stopped)this.hooks.online(false,error instanceof Error&&!['TypeError','TimeoutError','AbortError'].includes(error.name)?error.message:'Нет связи с сервером подключения. Повторим автоматически.');}finally{this.polling=false;if(this.repoll){this.repoll=false;void this.poll();}}
  }
  private async addLateCandidates(c:Connection,sdp:string){
    const key=(candidate:RTCIceCandidateInit)=>candidate.sdpMid+'|'+candidate.candidate;
    const old=new Set(sdpCandidates(c.remoteSdp||'').map(key));
    for(const candidate of sdpCandidates(sdp))if(!old.has(key(candidate)))await c.pc.addIceCandidate(candidate);
    c.remoteSdp=sdp;
  }
  private async discovery(action:string,to?:string){
    const r=await fetch(`/api/discovery?device=${this.device}`,{method:'POST',headers:{...identityHeaders(),Authorization:`Bearer ${this.room}`,'X-Perebros-Device':this.discoveryToken,'Content-Type':'application/json'},body:JSON.stringify({action,to}),signal:AbortSignal.timeout(8000)});
    if(!r.ok){const v=await r.json();throw new Error(v.error||'Не удалось подключить устройство.');}return r.json();
  }
  private remember(peer:string){this.approved.add(peer);sessionStorage.setItem('isend-approved-'+this.device,JSON.stringify([...this.approved].slice(-64)));}
  private async beforeSend(peer:string){
    const p=this.peers.find(p=>p.id===peer);if(!p)throw new Error('Устройство больше не доступно.');
    if(p.sameRoom===false&&!p.remembered&&(!this.approved.has(peer)||!p.paired)){await this.discovery('request',peer);this.remember(peer);}
  }
  private async authorize(request:ReceiveRequest){
    const p=this.peers.find(p=>p.id===request.peer);if(!p)return false;
    if(p.sameRoom!==false||p.remembered)return true;
    const allowed=this.approved.has(p.id)||await this.hooks.authorize?.(request);
    if(!allowed){void this.discovery('decline',p.id).catch(()=>{});return false;}
    this.remember(p.id);await this.discovery('accept',p.id).catch(()=>{});return true;
  }
  select(peer:string,source:'manual'|'auto'='manual'){if(source==='manual')this.selection.manual(this.peers.find(p=>p.id===peer));if(this.preferred===peer)return;this.preferred=peer;this.hooks.selection?.(peer);this.clipboard.select(peer);void this.publish().then(()=>this.refreshPeers()).catch(()=>{});}
  sendText(text:string,to:string){this.select(to);return this.clipboard.send(text,to);}
  refreshPeers(){if(this.polling)this.repoll=true;else void this.poll();}
  async pairingAction(action:string,extra:Record<string,string>={}){
    if(action!=='status'&&!identityIsSaved())throw new Error('pair_storage_unavailable');
    if(action!=='status')await this.publish();
    const response=await fetch(`/api/pairing?device=${this.device}`,{method:'POST',headers:{...identityHeaders(),Authorization:`Bearer ${this.room}`,'Content-Type':'application/json'},body:JSON.stringify({action,...extra}),cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok){const data=await response.json();throw new Error(data.code||'pair_network_error');}
    const state=await response.json() as PairingState;if(!this.stopped&&state.now>=this.pairingTime){this.pairingTime=state.now;this.selection.pairing(state);this.hooks.pairing?.(state);}
    if(action!=='status')this.refreshPeers();return state;
  }
  send(file:File,to:string,payloadKind:PayloadKind='file'){
    if(this.active?.complete)this.close();if(this.active||this.pending||this.opening)return false;
    if(!to){this.report('error',0,'Подключите второе устройство.');return false;}
    if(!validPayload(payloadKind,file.size)){this.report('error',0,'Текст слишком большой. Отправьте его файлом.');return false;}
    this.sequenceIssue=undefined;this.pending={file,id:randomKey(),to,payloadKind,sequenceRecoveries:0};this.manualRetryNeeded=false;this.confirmed=0;this.retries=0;this.trace('requested');this.hooks.metrics(null);void this.begin();return true;
  }
  retry(){if(this.pending&&!this.active){this.pending.sequenceRecoveries=0;this.manualRetryNeeded=false;clearTimeout(this.retryTimer);void this.begin();}}
  cancel(){const receiving=this.active?.role==='receive'?this.active.meta?.id:undefined;if(this.active||this.pending)this.trace('cancel');if(this.pending)void this.discovery('cancel',this.pending.to).catch(()=>{});this.control(this.active,{kind:'cancel'});if(this.active)this.emitMetrics(this.active,true,true);clearTimeout(this.retryTimer);this.pending=null;this.close();if(receiving)void this.disk.discardDestination(receiving);this.report('ready');}
  async clearReceived(){if(this.active&&!this.active.complete)throw new Error('Дождитесь завершения передачи.');await this.clipboard.clear();await this.disk.clearDestinations();for(const r of await this.disk.list())await this.disk.remove(r.id);}
  preferDirectSave(value:boolean){this.disk.preferDirect=value;}
  storageInventory(){return this.disk.inventory();}
  storedFile(key:string){return this.disk.storedFile(key);}
  async removeStored(key:string){if(this.active&&!this.active.complete)throw new Error('Дождитесь завершения передачи.');return this.disk.removeStored(key);}
  private current(c:Connection){return !this.stopped&&this.active===c;}
  private control(c:Connection|null,value:unknown){if(c?.channel?.readyState==='open')c.channel.send(JSON.stringify(value));}
  private deadline(c:Connection,ms=45000){
    clearTimeout(c.timer);c.timer=setTimeout(()=>{
      if(this.current(c))this.fail(c,c.relayAvailable?'Связь прервалась. Продолжим автоматически после восстановления.':'Не удалось соединиться напрямую. TURN ещё не подключён; попробуйте одну Wi-Fi-сеть.');
    },ms);
  }
  private makeConnection(pc:RTCPeerConnection,peer:string,id:string,role:'send'|'receive',relayAvailable:boolean,shared=false){
    const c:Connection={pc,id,peer,role,pacer:new PacketPacer(),pacingMs:0,networkStats:new NetworkDiagnostics(),ackTimes:new Map(),ackTotalMs:0,ackCount:0,offset:0,sendOffset:0,acknowledgements:[],windowBlocks:1,checkpointBlocks:1,pumping:false,endSent:false,lastProgress:0,complete:false,started:false,queue:Promise.resolve(),queuedBytes:0,relayAvailable,rttMs:null,hashMs:0,hashBytes:0,writeMs:0,writeBytes:0,remoteReadMsPerMiB:null,remoteFileReadMsPerMiB:null,remoteHashMsPerMiB:null,remoteWriteMsPerMiB:null,peerRevision:null};
    c.journalStage='setup';c.shared=shared;if(role==='send'&&this.pending)c.journalMeta={id:this.pending.id,size:this.pending.file.size,payloadKind:this.pending.payloadKind};this.active=c;this.hooks.peer?.(peer,role);this.hooks.relay(relayAvailable);this.deadline(c,35000);
    this.trace('connection',c);
    const changed=()=>{if(!this.current(c))return;this.trace('connection',c);if(pc.connectionState==='connected')void this.route(c);if(!c.complete&&['failed','closed'].includes(pc.connectionState))this.fail(c,'Связь прервалась. Сохранённые блоки не потеряны. Соединяемся снова…');};
    const ice=()=>{if(this.current(c))this.trace('connection',c);};
    pc.addEventListener('connectionstatechange',changed);pc.addEventListener('iceconnectionstatechange',ice);c.cleanup=()=>{pc.removeEventListener('connectionstatechange',changed);pc.removeEventListener('iceconnectionstatechange',ice);};return c;
  }
  private receiveWarm(peer:string,pc:RTCPeerConnection,channel:RTCDataChannel){
    if(this.stopped){channel.close();return;}
    if((this.active&&!this.active.complete)||this.pending){const refuse=()=>{try{channel.send(JSON.stringify({kind:'error',message:'Получатель занят другой передачей. Повторите после её завершения.'}));}finally{setTimeout(()=>channel.close(),1000);}};channel.onopen=refuse;if(channel.readyState==='open')refuse();return;}
    this.close();this.hooks.metrics(null);this.report('connecting',0,'Получаем сведения о файле…');const c=this.makeConnection(pc,peer,randomKey(),'receive',true,true);this.wire(c,channel);
  }
  private async connection(peer:string,id:string,role:'send'|'receive'):Promise<Connection|null>{
    this.close();const epoch=this.connectionEpoch;this.opening=true;this.hooks.peer?.(peer,role);this.hooks.route('finding');
    try{
      await this.publish();
      const response=await fetch(`/api/ice?device=${this.device}`,{headers:{...identityHeaders(),Authorization:`Bearer ${this.room}`},cache:'no-store',signal:AbortSignal.timeout(12000)});
      if(!response.ok)throw new Error('Сервер не выдал параметры связи.');
      const config=await response.json() as {iceServers:RTCIceServer[];relayAvailable:boolean};
      if(this.stopped||epoch!==this.connectionEpoch)return null;
      // Embedded Chromium can reject setConfiguration even before negotiation.
      // Supply the complete ICE configuration in the constructor instead.
      const pc=new RTCPeerConnection({iceServers:config.iceServers,iceTransportPolicy:'all',bundlePolicy:'max-bundle'});
      const c=this.makeConnection(pc,peer,id,role,config.relayAvailable);
      // Chromium's data-only UDP receive buffer is 64 KiB. Negotiating an
      // empty video transceiver activates its larger media socket buffers on
      // the bundled transport. No capture API, camera, microphone or track is
      // used. This is an optional implementation-specific optimization.
      try{pc.addTransceiver('video',{direction:'sendrecv'});}catch{/* Data-only browsers retain the reliable file channel. */}
      pc.onicecandidate=()=>{
        if(this.current(c)&&this.signal?.id===c.id&&pc.localDescription){this.signal={...this.signal,sdp:pc.localDescription.sdp};void this.publish().catch(()=>{});}
      };
      return c;
    }catch(error){
      if(!this.stopped&&epoch===this.connectionEpoch){
        console.warn('Perebros setup failed',error);
        this.report(role==='send'?'retry':'error',this.confirmed,this.setupError('подготовка связи',error));
        if(role==='send'&&this.pending)this.scheduleOffline();
      }
      return null;
    }finally{if(epoch===this.connectionEpoch)this.opening=false;}
  }
  private setupError(stage:string,error:unknown){
    const detail=error instanceof Error?error.name+': '+error.message.slice(0,240):'Неизвестная ошибка';
    return `Не удалось соединиться: ${stage}. ${detail}`;
  }
  private async route(c:Connection){
    try{
      const sample=c.networkStats.sample(await c.pc.getStats(),c.role);
      if(sample&&this.current(c)){
        c.networkSample=sample;const mode=sample.path.local==='relay'||sample.path.remote==='relay'?'relay':'direct';this.hooks.route(mode);
        const routeKey=JSON.stringify(sample.path);if(c.lastJournalRoute!==routeKey){c.lastJournalRoute=routeKey;this.trace('route',c,{route:mode,path:sample.path,rttMs:sample.rttMs});}
        if(sample.rttMs!==null)c.rttMs=sample.rttMs;
      }
    }catch{/* Keep the last observed route until statistics become available. */}
  }
  private close(){
    this.connectionEpoch++;this.opening=false;const old=this.active;this.active=null;this.signal=null;
    if(old){if(old.role==='receive'){this.hooks.cancelReceive?.(old.peer);if(old.meta&&!old.complete)void this.disk.release(old.meta.id).catch(()=>{});}clearTimeout(old.timer);old.clock?.stop(performance.now());old.reader?.dispose();old.cleanup?.();if(!old.shared){old.pc.onconnectionstatechange=null;old.pc.onicecandidate=null;}if(old.channel){old.channel.onclose=null;old.channel.onerror=null;old.channel.onmessage=null;}old.channel?.close();if(!old.shared)old.pc.close();old.block=undefined;}
  }
  private fail(c:Connection,message:string,permanent=false){
    if(!this.current(c))return;this.trace('error',c,{error:diagnosticError(message),permanent,...this.sequenceIssue});const sending=c.role==='send',unstarted=!sending&&!c.meta;this.emitMetrics(c,true);this.close();
    if(sending&&permanent){this.manualRetryNeeded=true;clearTimeout(this.retryTimer);}
    if(unstarted&&!permanent){this.report('ready');void this.poll();return;}
    this.report(permanent?(sending?'retry':'error'):'reconnecting',sending?this.confirmed:0,message);
    if(sending&&this.pending&&!permanent){
      const delay=Math.min(30000,1000*2**Math.min(5,this.retries++));
      clearTimeout(this.retryTimer);this.retryTimer=setTimeout(()=>{if(navigator.onLine&&!document.hidden)void this.begin();else this.scheduleOffline();},delay);
    }
    void this.poll();
  }
  private scheduleOffline(){if(!this.pending||this.stopped)return;this.retryTimer=setTimeout(()=>{if(navigator.onLine&&!document.hidden)void this.begin();else this.scheduleOffline();},5000);}
  private async gather(c:Connection){
    const until=Date.now()+7000;while(this.current(c)&&c.pc.iceGatheringState!=='complete'&&Date.now()<until)await sleep(60);
    if(!this.current(c))throw new Error('Cancelled');return c.pc.localDescription!.sdp;
  }
  private async begin(){
    const p=this.pending;if(!p||this.active||this.opening||this.stopped||this.manualRetryNeeded)return;clearTimeout(this.retryTimer);
    this.opening=true;const epoch=this.connectionEpoch;this.hooks.peer?.(p.to,'send');
    this.report('connecting',this.confirmed,this.confirmed?'Продолжаем с сохранённого блока…':'Выбираем доступный маршрут…');
    const peerDeadline=Date.now()+30000;
    while(!this.peers.some(peer=>peer.id===p.to)&&Date.now()<peerDeadline&&!this.stopped&&this.pending===p&&epoch===this.connectionEpoch){void this.poll();await sleep(250);}
    if(this.stopped||this.pending!==p||epoch!==this.connectionEpoch)return;
    try{await this.beforeSend(p.to);}catch(error){this.opening=false;this.report('retry',this.confirmed,error instanceof Error?error.message:'Не удалось подключиться.');return;}
    if(this.stopped||this.pending!==p||this.active||epoch!==this.connectionEpoch)return;
    let warm=this.clipboard.fileChannel(p.to);
    if(this.peers.find(peer=>peer.id===p.to)?.warm===1){
      this.select(p.to);const until=Date.now()+25000;
      while(!warm&&Date.now()<until&&!this.stopped&&this.pending===p&&epoch===this.connectionEpoch){await sleep(100);warm=this.clipboard.fileChannel(p.to);}
      if(this.stopped||this.pending!==p||epoch!==this.connectionEpoch){warm?.channel.close();return;}
      if(!warm){this.opening=false;this.report('reconnecting',this.confirmed,'Ждём возвращения второго устройства. Соединимся автоматически…');this.scheduleOffline();return;}
    }
    this.opening=false;
    if(warm){this.close();const c=this.makeConnection(warm.pc,p.to,randomKey(),'send',true,true);this.wire(c,warm.channel);return;}
    const c=await this.connection(p.to,randomKey(),'send');if(!c)return;
    try{
      this.wire(c,c.pc.createDataChannel('file-v3',{ordered:true}));
      await c.pc.setLocalDescription(await c.pc.createOffer());const sdp=await this.gather(c);if(!this.current(c))return;
      this.signal={id:c.id,to:c.peer,type:'offer',sdp};await this.publish();void this.poll();
    }catch(error){console.warn('Perebros offer failed',error);this.fail(c,this.setupError('отправка запроса',error));}
  }
  private async accept(peer:string,signal:Signal){
    let stage='загрузка настроек связи';
    this.hooks.metrics(null);this.report('connecting',0,'Принимаем соединение…');
    const c=await this.connection(peer,signal.id,'receive');if(!c)return;
    try{
      stage='приём параметров отправителя';c.pc.ondatachannel=e=>this.wire(c,e.channel);
      await c.pc.setRemoteDescription({type:'offer',sdp:signal.sdp});c.remoteSdp=signal.sdp;
      stage='создание ответа';await c.pc.setLocalDescription(await c.pc.createAnswer());stage='сбор адресов';const sdp=await this.gather(c);if(!this.current(c))return;
      stage='публикация ответа';this.signal={id:c.id,to:peer,type:'answer',sdp};await this.publish();
    }catch(error){console.warn('Perebros connection failed:',stage,error);this.fail(c,this.setupError(stage,error));}
  }
  private wire(c:Connection,channel:RTCDataChannel){
    c.channel=channel;channel.binaryType='arraybuffer';channel.bufferedAmountLowThreshold=sendQueue().low;
    channel.onclose=()=>{if(this.current(c)&&!c.complete)this.fail(c,'Связь прервалась. Передача продолжится автоматически.');};
    channel.onerror=()=>{if(this.current(c)&&!c.complete)this.fail(c,'Соединение прервалось. Переподключаемся…');};
    channel.onopen=()=>{
      if(!this.current(c))return;this.trace('channel',c);this.deadline(c);void this.route(c);
      if(c.role==='send'&&this.pending){const p=this.pending;this.control(c,{kind:'start',version:3,id:p.id,name:p.file.name,size:p.file.size,blockSize:BLOCK_SIZE,revision:28,payloadKind:p.payloadKind} satisfies Meta);}
    };
    if(channel.readyState==='open')queueMicrotask(()=>channel.onopen?.(new Event('open')));
    channel.onmessage=e=>{
      // Cancellation must not wait behind the user's pending consent dialog.
      if(typeof e.data==='string'&&e.data.length<=3000){try{if(JSON.parse(e.data).kind==='cancel'){void this.message(c,e.data).catch(()=>{});return;}}catch{}}
      const size=typeof e.data==='string'?e.data.length:e.data.byteLength;
      c.queuedBytes+=size;
      // A negotiated window bounds data in flight even when the receiver's disk is slow.
      // Leave one extra block for headers and the message currently being processed.
      if(c.queuedBytes>BLOCK_SIZE*(WINDOW_BLOCKS+1)){this.fail(c,'Получено слишком много данных без подтверждения.',true);return;}
      c.queue=c.queue.then(async()=>{
        try{if(this.current(c)){this.deadline(c);await this.message(c,e.data);}}
        catch(error){
          const message=error instanceof Error?error.message:'Ошибка передачи.';
          if(this.current(c)){
            const issue=error instanceof BlockSequenceError?error.issue:undefined;if(issue)this.sequenceIssue=issue;
            this.control(c,{kind:'error',message,...(issue?{sequenceIssue:issue}:{})});this.fail(c,message,true);
          }
        }finally{c.queuedBytes-=size;}
      });
    };
  }
  private async message(c:Connection,data:unknown){
    c.journalStage=data instanceof ArrayBuffer?'receive_block':'receive_control';
    if(data instanceof ArrayBuffer){
      const b=c.block;if(c.role!=='receive'||!b||data.byteLength>PACKET_SIZE||b.bytes+data.byteLength>b.length)throw new Error('Неверный блок данных.');
      b.buffer.set(new Uint8Array(data),b.bytes);b.bytes+=data.byteLength;return;
    }
    if(typeof data!=='string'||data.length>3000)throw new Error('Неверное сообщение.');const v=JSON.parse(data);
    if(v.kind==='waiting'){this.deadline(c,120000);this.report('connecting',this.confirmed,'Подтвердите приём на втором устройстве.');return;}
    if(v.kind==='error'){
      const issue=c.role==='send'&&this.pending?parseSequenceIssue(v.sequenceIssue,this.pending.file.size):null;
      if(issue&&this.pending){
        this.sequenceIssue=issue;
        if(sequenceRecoveryAllowed(issue,this.pending.sequenceRecoveries)){
          this.pending.sequenceRecoveries++;this.fail(c,'Проверяем сохранённую часть и продолжаем передачу…');return;
        }
        this.fail(c,'Не удалось восстановить порядок блоков. Сохранённая часть осталась у получателя. Нажмите «Повторить»; подробности — в сведениях о передаче.',true);return;
      }
      this.fail(c,typeof v.message==='string'?v.message.slice(0,300):'Получатель не смог сохранить файл.',true);return;
    }
    if(v.kind==='cancel'){const receiving=c.role==='receive'?c.meta?.id:undefined;this.trace('cancel',c);this.emitMetrics(c,true,true);this.pending=null;clearTimeout(this.retryTimer);this.close();if(receiving)void this.disk.discardDestination(receiving);this.report('ready',0,'Передача остановлена.');return;}
    if(v.kind==='start'&&c.role==='receive'){
      if(c.meta||v.version!==3||!keyPattern.test(v.id)||typeof v.name!=='string'||v.name.length>255||!Number.isSafeInteger(v.size)||v.size<0||v.blockSize!==BLOCK_SIZE||!validPayload(v.payloadKind,v.size))throw new Error('Обновите страницу на обоих устройствах: формат передачи отличается.');
      c.journalMeta={id:v.id,size:v.size,payloadKind:v.payloadKind};
      this.trace('requested',c,{transfer:v.id,total:v.size,payload:v.payloadKind||'file',peerRevision:v.revision});
      c.journalStage='authorize';
      if(c.shared){if(!this.approved.has(c.peer)&&this.peers.find(p=>p.id===c.peer)?.sameRoom===false){this.control(c,{kind:'waiting'});this.report('connecting',0,'Подтвердите приём на этом устройстве.');}this.deadline(c,120000);if(!await this.authorize({peer:c.peer,name:v.name,size:v.size,kind:'file'}))throw new Error('Получатель отклонил передачу.');if(!this.current(c))return;}
      if(this.incomingFileId!==v.id){this.incomingFileId=v.id;this.sequenceIssue=undefined;}
      c.meta=v;c.peerRevision=Number.isSafeInteger(v.revision)&&v.revision>0?v.revision:null;
      c.journalStage='storage_open';
      if(await this.disk.needsDestination(v)){
        if(!this.current(c))return;
        this.control(c,{kind:'waiting'});this.deadline(c,120000);
        const handle=await this.hooks.saveFile?.({peer:c.peer,name:v.name,size:v.size,kind:'file'});
        if(!this.current(c))return;
        if(!handle)throw new Error('Получатель отклонил выбор файла для сохранения.');
        await this.disk.attachDestination(v,handle);
        if(!this.current(c)){await this.disk.discardDestination(v.id);return;}
      }
      const record=await this.disk.open(v);if(!this.current(c))return;c.offset=record.offset;
      this.trace('resume',c,{offset:record.offset});
      if(record.complete){c.complete=true;this.trace('complete',c,{complete:true});await this.localFile(record);this.control(c,{kind:'done',id:v.id});this.report('received',100,v.name);this.finishReceive(c);return;}
      c.meter=new TransferMeter(c.offset,v.size,performance.now());this.emitMetrics(c);
      await this.localFile(record);this.report('receiving',this.percent(c.offset,v.size),v.name);this.control(c,{kind:'ready',offset:c.offset,windowBlocks:WINDOW_BLOCKS,checkpointBlocks:CHECKPOINT_BLOCKS,revision:28});return;
    }
    if(v.kind==='ready'&&c.role==='send'&&!c.started&&this.pending){
      if(!Number.isSafeInteger(v.offset)||v.offset<0||v.offset>this.pending.file.size||(v.offset!==this.pending.file.size&&v.offset%BLOCK_SIZE))throw new Error('Неверная позиция докачки.');
      // Old receivers advertise no window and keep their original one-block protocol.
      c.windowBlocks=Number.isSafeInteger(v.windowBlocks)&&v.windowBlocks>0?Math.min(WINDOW_BLOCKS,v.windowBlocks):1;
      c.checkpointBlocks=Number.isSafeInteger(v.checkpointBlocks)&&v.checkpointBlocks>0?Math.min(CHECKPOINT_BLOCKS,c.windowBlocks,v.checkpointBlocks):1;
      c.peerRevision=Number.isSafeInteger(v.revision)&&v.revision>0?v.revision:null;
      c.started=true;c.offset=v.offset;c.sendOffset=v.offset;c.meter=new TransferMeter(c.offset,this.pending.file.size,performance.now());c.clock=new SendClock(performance.now());c.reader=new BufferedFileReader(this.pending.file,c.offset);this.emitMetrics(c);
      this.trace('resume',c,{checkpointBlocks:c.checkpointBlocks,windowBytes:c.windowBlocks*BLOCK_SIZE});
      this.confirmed=this.percent(c.offset,this.pending.file.size);void this.pump(c);return;
    }
    if(v.kind==='block'&&c.role==='receive'&&c.meta&&!c.block){
      const issue=blockSequenceIssue(v,c.offset,c.meta.size);if(issue)throw new BlockSequenceError(issue);
      c.block={offset:v.offset,length:v.length,hash:v.hash,buffer:new Uint8Array(v.length),bytes:0};return;
    }
    if(v.kind==='block-end'&&c.role==='receive'&&c.meta&&c.block){
      const b=c.block;if(b.bytes!==b.length)throw new Error('Блок получен не полностью.');
      // Older senders have no checkpoint flag and still get a durable ACK per block.
      // Keep durable checkpoints at 1 MiB while allowing the next groups to be
      // in flight. A larger window never acknowledges an uncommitted write.
      const checkpoint=v.checkpoint!==false||c.acknowledgements.length+1>=CHECKPOINT_BLOCKS||c.offset+b.length===c.meta.size;
      if(Number.isFinite(v.readMsPerMiB)&&v.readMsPerMiB>=0&&v.readMsPerMiB<1e6)c.remoteReadMsPerMiB=v.readMsPerMiB;
      if(Number.isFinite(v.fileReadMsPerMiB)&&v.fileReadMsPerMiB>=0&&v.fileReadMsPerMiB<1e6)c.remoteFileReadMsPerMiB=v.fileReadMsPerMiB;
      if(Number.isFinite(v.hashMsPerMiB)&&v.hashMsPerMiB>=0&&v.hashMsPerMiB<1e6)c.remoteHashMsPerMiB=v.hashMsPerMiB;
      const sender=parseSenderDiagnostics(v.sender);if(sender)c.remoteSender=sender;
      const writeStarted=performance.now();
      c.journalStage='storage_write';const record=await this.disk.write(c.meta.id,b.offset,b.buffer.buffer as ArrayBuffer,b.hash,checkpoint);
      if(!this.current(c))return;c.offset=record.offset;c.block=undefined;
      c.writeMs+=performance.now()-writeStarted;c.writeBytes+=b.length;
      c.acknowledgements.push(c.offset);
      if(!checkpoint)return;
      c.meter?.advance(c.offset);
      if(this.progressDue(c,c.meta.size)){
        this.report('receiving',this.percent(c.offset,c.meta.size),c.meta.name);
        this.hooks.file({id:record.id,name:record.name,size:record.size,url:'',direction:'received',offset:record.offset,complete:false,payloadKind:record.payloadKind,destination:record.destination,savedName:record.savedName});
      }
      for(const offset of c.acknowledgements)this.control(c,{kind:'ack',offset,...(offset===c.offset?{writeMsPerMiB:c.writeMs/(c.writeBytes/1048576)}:{})});
      c.acknowledgements=[];return;
    }
    if(v.kind==='ack'&&c.role==='send'&&this.pending){
      if(!c.acknowledgements.length||v.offset!==c.acknowledgements[0]){this.trace('error',c,{error:'ack',expectedAck:c.acknowledgements[0],receivedAck:v.offset});throw new Error('Неверное подтверждение записи.');}
      const sentAt=c.ackTimes.get(v.offset);if(sentAt!==undefined){c.ackTotalMs+=performance.now()-sentAt;c.ackCount++;c.ackTimes.delete(v.offset);}
      c.offset=v.offset;c.acknowledgements.shift();this.retries=0;this.confirmed=this.percent(c.offset,this.pending.file.size);
      c.meter?.advance(c.offset);
      if(Number.isFinite(v.writeMsPerMiB)&&v.writeMsPerMiB>=0&&v.writeMsPerMiB<1e6)c.remoteWriteMsPerMiB=v.writeMsPerMiB;
      if(this.progressDue(c,this.pending.file.size))this.report('sending',this.confirmed,this.pending.file.name);
      void this.pump(c);return;
    }
    if(v.kind==='end'&&c.role==='receive'&&c.meta&&!c.block){
      if(c.offset!==c.meta.size)throw new Error('Файл получен не полностью.');
      const sender=parseSenderDiagnostics(v.sender);if(sender)c.remoteSender=sender;
      c.journalStage='storage_complete';const record=await this.disk.complete(c.meta.id);if(!this.current(c))return;
      c.complete=true;await this.localFile(record);c.meter?.finish(performance.now());this.emitMetrics(c);this.trace('complete',c,{complete:true});this.control(c,{kind:'done',id:c.meta.id});this.report('received',100,c.meta.name);this.finishReceive(c);return;
    }
    if(v.kind==='done'&&c.role==='send'&&this.pending&&this.pending.id===v.id){
      const p=this.pending;c.complete=true;c.clock?.stop(performance.now());c.meter?.finish(performance.now());this.emitMetrics(c);this.trace('complete',c,{complete:true});this.pending=null;this.retries=0;this.confirmed=100;
      this.hooks.file({id:p.id,name:p.file.name,size:p.file.size,url:URL.createObjectURL(p.file),direction:'sent',complete:true,payloadKind:p.payloadKind,text:p.payloadKind==='text'?await p.file.text():undefined});
      this.report('sent',100,p.file.name);this.close();void this.poll();return;
    }
    throw new Error('Неожиданное сообщение передачи. Обновите обе страницы.');
  }
  private percent(offset:number,size:number){return Math.min(99,Math.floor(offset/Math.max(1,size)*100));}
  private sourceMetrics(c:Connection){
    if(c.role==='receive')return {readMsPerMiB:c.remoteReadMsPerMiB,fileReadMsPerMiB:c.remoteFileReadMsPerMiB,hashMsPerMiB:c.remoteHashMsPerMiB};
    const fileReadMsPerMiB=c.reader?.millisecondsPerMiB??null,hashMsPerMiB=c.hashBytes?c.hashMs/(c.hashBytes/1048576):null;
    return {readMsPerMiB:fileReadMsPerMiB===null||hashMsPerMiB===null?null:fileReadMsPerMiB+hashMsPerMiB,fileReadMsPerMiB,hashMsPerMiB};
  }
  private senderDiagnostics(c:Connection):SenderDiagnostics|null{
    if(c.role==='receive')return c.remoteSender??null;
    if(!c.clock)return null;
    return {timing:c.clock.sample(performance.now()),ackMs:c.ackCount?c.ackTotalMs/c.ackCount:null,bufferedBytes:c.channel?.bufferedAmount??0,windowBytes:c.windowBlocks*BLOCK_SIZE,socketDrops:c.networkSample?.socketDrops??null,socketDropsSinceStart:true,pacingMs:c.pacingMs};
  }
  private emitMetrics(c:Connection,paused=false,cancelled=false){
    if(!c.meter||this.stopped)return;
    const metrics:TransferMetrics={...c.meter.sample(performance.now(),paused),rttMs:c.rttMs,...this.sourceMetrics(c),writeMsPerMiB:c.role==='receive'?(c.writeBytes?c.writeMs/(c.writeBytes/1048576):null):c.remoteWriteMsPerMiB,peerRevision:c.peerRevision,windowBytes:c.role==='send'?c.windowBlocks*BLOCK_SIZE:WINDOW_BLOCKS*BLOCK_SIZE,network:c.networkSample??null,sender:this.senderDiagnostics(c),cancelled,sequenceIssue:this.sequenceIssue,sequenceRecoveries:this.pending?.sequenceRecoveries};
    this.hooks.metrics(metrics);
    if(!c.lastJournalSample||performance.now()-c.lastJournalSample>=10000||paused||cancelled||c.complete){
      c.lastJournalSample=performance.now();const sender=metrics.sender;
      this.trace('sample',c,{...metrics,path:metrics.network?.path,wireBytesPerSecond:metrics.network?.bytesPerSecond,socketDrops:sender?.socketDrops,socketDropsSinceStart:sender?.socketDropsSinceStart,ackMs:sender?.ackMs,pacingMs:sender?.pacingMs,prepareMs:sender?.timing.prepare,channelMs:sender?.timing.channel,ackWaitMs:sender?.timing.ack,dispatchMs:sender?.timing.dispatch,timingMs:sender?.timing.total,...this.sequenceIssue});
    }
  }
  private progressDue(c:Connection,size:number){const now=performance.now();if(c.lastProgress&&now-c.lastProgress<150&&c.offset!==size)return false;c.lastProgress=now;return true;}
  private finishReceive(c:Connection){clearTimeout(c.timer);setTimeout(()=>{if(this.current(c)){this.close();void this.poll();}},1000);}
  private async bufferSpace(c:Connection,channel:RTCDataChannel){
    const limits=sendQueue(c.networkSample?.path);
    channel.bufferedAmountLowThreshold=limits.low;
    if(channel.bufferedAmount<=limits.high)return;
    c.clock?.set('channel',performance.now());
    try{await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{channel.removeEventListener('bufferedamountlow',ready);channel.removeEventListener('close',closed);channel.removeEventListener('error',closed);};
      const ready=()=>{cleanup();resolve();};
      const closed=()=>{cleanup();reject(new Error('Канал закрыт.'));};
      channel.addEventListener('bufferedamountlow',ready);channel.addEventListener('close',closed);channel.addEventListener('error',closed);
      if(!this.current(c)||channel.readyState!=='open')closed();else if(channel.bufferedAmount<=limits.low)ready();
    });}finally{c.clock?.set('dispatch',performance.now());}
  }
  private async pump(c:Connection){
    const p=this.pending,channel=c.channel;if(!p||!channel||!this.current(c)||c.pumping||c.endSent)return;
    c.pumping=true;c.journalStage='send_pump';
    try{
      if(!c.lastProgress){c.lastProgress=performance.now();this.report('sending',this.percent(c.offset,p.file.size),p.file.name);}
      while(this.current(c)&&c.sendOffset<p.file.size&&c.acknowledgements.length<c.windowBlocks){
        c.clock?.set('prepare',performance.now());
        const start=c.sendOffset,buffer=await c.reader!.read(start,Math.min(BLOCK_SIZE,p.file.size-start));
        if(!this.current(c))return;
        const hashStarted=performance.now(),digest=await hash(buffer);
        if(!this.current(c))return;
        c.hashMs+=performance.now()-hashStarted;c.hashBytes+=buffer.byteLength;
        c.clock?.set('dispatch',performance.now());
        c.sendOffset=start+buffer.byteLength;c.acknowledgements.push(c.sendOffset);
        this.control(c,{kind:'block',offset:start,length:buffer.byteLength,hash:digest});
        for(let i=0;i<buffer.byteLength;i+=PACKET_SIZE){
          await this.bufferSpace(c,channel);
          if(!this.current(c))return;
          const packet=buffer.subarray(i,i+PACKET_SIZE),delay=c.pacer.delay(packet.byteLength,performance.now(),!document.hidden);
          // Background timer throttling must never turn pacing into 1 packet/s.
          if(delay>0.5){const at=performance.now();c.clock?.set('channel',at);await sleep(delay);c.pacingMs+=performance.now()-at;c.clock?.set('dispatch',performance.now());}
          if(!this.current(c))return;channel.send(packet);
        }
        c.ackTimes.set(c.sendOffset,performance.now());
        this.control(c,{kind:'block-end',checkpoint:c.sendOffset===p.file.size||Math.floor(c.sendOffset/BLOCK_SIZE)%c.checkpointBlocks===0,...this.sourceMetrics(c),sender:this.senderDiagnostics(c)});this.deadline(c);
      }
      // ACK follows verified writes: OPFS uses durable checkpoints; a selected file
      // keeps a live transaction across reconnects and commits before done.
      if(this.current(c)&&c.offset===p.file.size){c.endSent=true;this.control(c,{kind:'end',sender:this.senderDiagnostics(c)});}
    }catch{this.fail(c,'Не удалось отправить блок. Повторно соединяемся с получателем…');}
    finally{c.pumping=false;c.clock?.set('ack',performance.now());}
  }
  stop(){this.journal.stop();this.stopped=true;this.stopNetworkWatch();clearInterval(this.interval);clearInterval(this.meterInterval);clearTimeout(this.retryTimer);this.close();this.disk.stop();this.clipboard.stop();document.removeEventListener('visibilitychange',this.wake);window.removeEventListener('online',this.wake);window.removeEventListener('pageshow',this.wake);}
}
