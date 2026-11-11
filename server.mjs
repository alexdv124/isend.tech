import {Pairing,PairingError,identityHash} from './pairing.mjs';
import {TransferJournal,TelemetryError} from './telemetry.mjs';
import {AudienceStore,AudienceError} from './audience.mjs';
import {TextSignals} from './text-signals.mjs';
import {Discovery,DiscoveryError,clientNetwork} from './discovery.mjs';
import {createServer} from 'node:http';
import {createHash,createHmac} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const KEY=/^[a-f0-9]{48}$/;
const ACTIVE_MS=120_000,RETAIN_MS=6*60*60*1000;
const STUN=[{urls:'stun:stun.cloudflare.com:3478'},{urls:'stun:stun.l.google.com:19302'}];
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const SECURITY={
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), screen-wake-lock=(self)',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

class HttpError extends Error{
  constructor(status,message,code){super(message);this.status=status;this.code=code;}
}

// Only connection metadata lives here. No HTTP endpoint accepts file contents.
export class Registry{
  constructor({now=Date.now,maxRooms=1024,maxPeers=2048}={}){
    this.now=now;this.maxRooms=maxRooms;this.maxPeers=maxPeers;this.rooms=new Map();this.count=0;this.identities=new Map();
  }
  sweep(){
    const now=this.now();
    for(const [key,room] of this.rooms){
      for(const [id,peer] of room)if(now-peer.seenAt>RETAIN_MS){room.delete(id);this.identities.delete(key+':'+id);this.count--;}
      if(!room.size)this.rooms.delete(key);
    }
  }
  get(key){return [...(this.rooms.get(key)?.values()||[])].filter(peer=>this.now()-peer.seenAt<=RETAIN_MS);}
  identity(key,id){return this.identities.get(key+':'+id)||null;}
  verify(key,id,identity){if(this.identity(key,id)&&this.identity(key,id)!==identity)throw new PairingError(403,'identity_mismatch');}
  put(key,value,identity=null){
    if(!value||typeof value!=='object'||!KEY.test(value.id||''))throw new HttpError(400,'Неверное устройство.');
    this.verify(key,value.id,identity);
    const s=value.signal;
    if(s&&(!KEY.test(s.id||'')||!KEY.test(s.to||'')||!['offer','answer'].includes(s.type)||typeof s.sdp!=='string'||s.sdp.length>18000||!s.sdp.startsWith('v=0')))
      throw new HttpError(400,'Неверные параметры соединения.');
    let room=this.rooms.get(key);
    const now=this.now();
    if(!room?.has(value.id)){
      if(room&&[...room.values()].filter(p=>now-p.seenAt<ACTIVE_MS).length>=8)
        throw new HttpError(429,'Слишком много активных вкладок. Закройте лишние и повторите через 2 минуты.','active_limit');
      if(this.count>=this.maxPeers||this.rooms.size>=this.maxRooms)this.sweep();
      room=this.rooms.get(key);
      if(room?.size>=64){
        const oldest=[...room.values()].sort((a,b)=>a.seenAt-b.seenAt)[0];
        room.delete(oldest.id);this.identities.delete(key+':'+oldest.id);this.count--;
      }
      if(this.count>=this.maxPeers||(!room&&this.rooms.size>=this.maxRooms))
        throw new HttpError(503,'Сервер подключения занят. Повторите чуть позже.');
      if(!room){room=new Map();this.rooms.set(key,room);}
      this.count++;
    }
    if(identity)this.identities.set(key+':'+value.id,identity);
    room.set(value.id,{id:value.id,name:value.name==='Телефон'?'Телефон':'Компьютер',
      ...(value.protocol===3?{protocol:3}:{}),...(value.clipboard===1?{clipboard:1}:{}),...(value.warm===1?{warm:1,preferred:KEY.test(value.preferred||'')?value.preferred:null}:{}),seenAt:now,
      signal:s?{id:s.id,to:s.to,type:s.type,sdp:s.sdp}:null});
  }
}

function roomKey(req){
  const header=req.headers.authorization||'';
  if(!header.startsWith('Bearer ')||!KEY.test(header.slice(7)))throw new HttpError(401,'Неверная ссылка подключения.');
  return createHash('sha256').update(header.slice(7)).digest('hex');
}
async function body(req){
  if(Number(req.headers['content-length'])>24000)throw new HttpError(413,'Слишком большой запрос.');
  let length=0;const chunks=[];
  // destroyOnReturn:false lets the server send 413 before closing the connection.
  for await(const chunk of req.iterator({destroyOnReturn:false})){
    length+=chunk.length;if(length>24000)throw new HttpError(413,'Слишком большой запрос.');chunks.push(chunk);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'Неверный запрос.');}
}
function json(res,value,status=200){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(value));
}

export async function createApp({dist=new URL('./dist/',import.meta.url),registry=new Registry(),discovery=new Discovery(),env=process.env,pairing=new Pairing({path:env.PAIRING_STORE||null}),audience=new AudienceStore({path:env.ANALYTICS_AUDIENCE_FILE||(env.DIAGNOSTICS_DIR?resolve(env.DIAGNOSTICS_DIR,'audience.json'):null)}),journal=new TransferJournal({directory:env.DIAGNOSTICS_DIR||null,audience})}={}){
  const directory=dist instanceof URL?fileURLToPath(dist):dist;
  const assets=new Map();
  for(const path of await readdir(directory,{recursive:true})){
    const type=MIME[extname(path)];if(!type)continue;
    const bytes=await readFile(resolve(directory,path));
    const gzip=await readFile(resolve(directory,path+'.gz')).catch(()=>null);
    assets.set('/'+path,{bytes,gzip,type});
  }
  if(!assets.has('/index.html'))throw new Error('Run npm run build first');
  const publicOrigins=[env.PUBLIC_ORIGIN,...(env.PUBLIC_ORIGINS||'').split(',')].filter(Boolean).map(v=>new URL(v).origin);
  const sweep=setInterval(()=>{registry.sweep();discovery.sweep();pairing.sweep();void journal.sweep().catch(()=>{});},60_000);sweep.unref();
  const iceCache=new Map(),textSignals=new TextSignals();
  const peersFor=(key,device)=>{
    const peers=new Map(registry.get(key).map(p=>[p.id,{peer:{...p,sameRoom:true},room:key}]));
    const warm=peers.get(device)?.peer.warm===1;
    const allowed=device?discovery.allowed(key,device):[],trustedIds=new Set(allowed.map(p=>p.id));
    if(device)for(const other of [...allowed,...(warm?discovery.nearby(key,device):[])]){
      const p=registry.get(other.room).find(p=>p.id===other.id);
      const trusted=trustedIds.has(other.id);
      if(p&&!peers.has(p.id)&&(trusted||p.warm===1))peers.set(p.id,{room:other.room,peer:{...p,sameRoom:false,paired:trusted,signal:trusted&&p.signal?.to===device?p.signal:null}});
    }
    const identity=registry.identity(key,device);
    if(identity)for(const [id,v]of peers)if(id!==device&&registry.identity(v.room,id)===identity)peers.delete(id);
    const links=new Map(identity?pairing.linked(identity).map(p=>[p.a===identity?p.b:p.a,p]):[]);
    const remembered=new Map();
    if(links.size)for(const [otherRoom,entries]of registry.rooms)for(const p of entries.values()){
      if(p.id===device)continue;
      const otherIdentity=registry.identity(otherRoom,p.id),pair=links.get(otherIdentity);
      if(pair&&Date.now()-p.seenAt<RETAIN_MS){
        const list=remembered.get(otherIdentity)||[];list.push({room:otherRoom,peer:{...p,sameRoom:otherRoom===key,paired:true,remembered:true,pairingId:pair.id,signal:p.signal?.to===device?p.signal:null}});remembered.set(otherIdentity,list);
      }
    }
    for(const list of remembered.values()){
      const online=list.filter(v=>Date.now()-v.peer.seenAt<30000);
      // A reopened browser must not leave six hours of duplicate offline tabs.
      for(const v of online.length?online:list.sort((a,b)=>b.peer.seenAt-a.peer.seenAt).slice(0,1))peers.set(v.peer.id,v);
    }
    return peers;
  };
  const server=createServer({maxHeaderSize:8192,requestTimeout:15_000,headersTimeout:10_000,keepAliveTimeout:5000},async(req,res)=>{
    for(const [name,value]of Object.entries(SECURITY))res.setHeader(name,value);
    try{
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/healthz')return json(res,{ok:true,version:'27-vps'});
      if(url.pathname.startsWith('/api/')){
        if(req.headers['sec-fetch-site']==='cross-site'||(publicOrigins.length&&req.headers.origin&&!publicOrigins.includes(req.headers.origin)))
          throw new HttpError(403,'Неверный источник запроса.');
        const identity=identityHash(req.headers['x-isend-identity']);
        if(url.pathname==='/api/internal-device'){
          if(!identity)throw new AudienceError(401,'Не удалось определить этот браузер.');
          res.setHeader('Cache-Control','no-store');
          if(req.method==='GET')return json(res,{internal:audience.isInternal(identity)});
          if(req.method==='POST'){audience.limit(clientNetwork(req,env.TRUST_PROXY==='loopback'));const value=await body(req);return json(res,audience.enroll(identity,value?.token));}
          throw new HttpError(405,'Метод не поддерживается.');
        }
        const key=roomKey(req);
        const requestedDevice=url.searchParams.get('device');
        if(requestedDevice)registry.verify(key,requestedDevice,identity);
        if(url.pathname==='/api/diagnostics'){
          if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
          const device=requestedDevice||'',peer=registry.get(key).find(p=>p.id===device&&Date.now()-p.seenAt<120000);
          if(!peer||!identity||registry.identity(key,device)!==identity)throw new HttpError(403,'Device not registered');
          const v=await body(req);
          const accepted=await journal.append(identity,device,v?.events);
          return json(res,{ok:true,accepted});
        }
        if(url.pathname==='/api/pairing'&&req.method==='POST'){
          const device=requestedDevice||'',peer=registry.get(key).find(p=>p.id===device&&Date.now()-p.seenAt<120000);
          if(!peer||!identity||registry.identity(key,device)!==identity)throw new PairingError(403,'identity_required');
          const v=await body(req);if(!v||typeof v!=='object')throw new PairingError(400,'pair_invalid');
          const network=clientNetwork(req,env.TRUST_PROXY==='loopback')||'unknown';
          const own={identity,id:device,name:peer.name};
          const result=pairing.act(own,network,v);
          // No IP addresses, credentials or room secrets leave this endpoint.
          for(const saved of result.remembered){
            const pair=pairing.pairs.get(saved.id),other=pair.a===identity?pair.b:pair.a;
            saved.online=false;
            for(const [r,entries]of registry.rooms)for(const p of entries.values())if(registry.identity(r,p.id)===other&&Date.now()-p.seenAt<30000){saved.online=true;saved.peer={id:p.id,name:p.name};}
          }
          return json(res,result);
        }
        if(url.pathname==='/api/discovery'&&req.method==='POST'){
          const device=url.searchParams.get('device')||'',own=registry.get(key).find(p=>p.id===device&&Date.now()-p.seenAt<120000);
          if(!KEY.test(device)||!own)throw new HttpError(403,'Подключаем устройство к поиску…');
          const token=req.headers['x-perebros-device'],v=await body(req);
          if(typeof token!=='string'||!v||typeof v!=='object')throw new HttpError(400,'Неверный запрос поиска.');
          const presence=discovery.presence(key,device,token,clientNetwork(req,env.TRUST_PROXY==='loopback'),own.name);
          const result=v.action==='presence'?presence:discovery.action(key,device,token,v.action,v.to);
          return json(res,result);
        }
        if(url.pathname==='/api/peers'){
          if(req.method==='GET'){
            const device=url.searchParams.get('device');
            if(device&&(!KEY.test(device)||!registry.get(key).some(p=>p.id===device)))throw new HttpError(403,'Устройство не подключено.');
            return json(res,{peers:[...peersFor(key,device).values()].map(v=>v.peer)});
          }
          if(req.method==='PUT'){registry.put(key,await body(req),identity);return json(res,{ok:true});}
          throw new HttpError(405,'Метод не поддерживается.');
        }
        if(url.pathname==='/api/text-signals'){
          const device=url.searchParams.get('device')||'';
          if(!KEY.test(device)||!registry.get(key).some(p=>p.id===device&&Date.now()-p.seenAt<120000))throw new HttpError(403,'Устройство не подключено.');
          const peers=peersFor(key,device);
          if(req.method==='GET')return json(res,{signals:textSignals.get(key,device).filter(s=>peers.has(s.from))});
          if(req.method==='POST'){
            const v=await body(req);
            if(!v||!KEY.test(v.to||'')||v.to===device||!KEY.test(v.id||'')||!['offer','answer'].includes(v.type)||typeof v.sdp!=='string'||v.sdp.length>18000||!v.sdp.startsWith('v=0'))throw new HttpError(400,'Неверные параметры соединения.');
            const target=peers.get(v.to);
            if(target?.peer.clipboard!==1)throw new HttpError(403,'Обновите второе устройство или подтвердите подключение.');
            if(!textSignals.put(target.room,device,v.to,{id:v.id,type:v.type,sdp:v.sdp}))throw new HttpError(503,'Сервер подключения занят.');
            return json(res,{ok:true});
          }
          throw new HttpError(405,'Метод не поддерживается.');
        }
        if(url.pathname==='/api/ice'&&req.method==='GET'){
          const device=url.searchParams.get('device')||'';
          if(!KEY.test(device))throw new HttpError(400,'Неверное устройство.');
          if(!env.TURN_AUTH_SECRET&&!env.CF_TURN_API_TOKEN)return json(res,{iceServers:STUN,relayAvailable:false});
          if(!registry.get(key).some(p=>p.id===device&&Date.now()-p.seenAt<15*60*1000))throw new HttpError(403,'Устройство не подключено.');
          try{
            const cacheKey=key+device;
            const cached=iceCache.get(cacheKey);
            if(cached&&cached.expires>Date.now()+600_000)return json(res,{...cached,relayAvailable:true});
            const ttl=6*60*60;let iceServers;
            if(env.TURN_AUTH_SECRET&&env.TURN_URLS){
              const urls=env.TURN_URLS.split(',').map(u=>u.trim()).filter(u=>/^turns?:[^\s]+$/.test(u));
              if(!urls.length)throw new Error('Invalid TURN URLs');
              const username=`${Math.floor(Date.now()/1000)+ttl}:${device}`;
              const credential=createHmac('sha1',env.TURN_AUTH_SECRET).update(username).digest('base64');
              iceServers=[...STUN,{urls,username,credential}];
            }else if(env.CF_TURN_KEY_ID&&env.CF_TURN_API_TOKEN){
              const response=await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,{
                method:'POST',headers:{Authorization:`Bearer ${env.CF_TURN_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({ttl}),signal:AbortSignal.timeout(8000),
              });
              if(!response.ok)throw new Error('TURN unavailable');
              const result=await response.json();
              if(!Array.isArray(result.iceServers)||!result.iceServers.some(s=>[s.urls].flat().some(u=>typeof u==='string'&&/^turns?:/.test(u))))throw new Error('Invalid TURN response');
              iceServers=result.iceServers;
            }else throw new Error('Incomplete TURN configuration');
            const data={iceServers,expires:Date.now()+ttl*1000};
            if(iceCache.size>=2048)iceCache.delete(iceCache.keys().next().value);
            iceCache.set(cacheKey,data);return json(res,{...data,relayAvailable:true});
          }catch{return json(res,{iceServers:STUN,relayAvailable:false,relayUnavailable:true});}
        }
        if(url.pathname==='/api/files'){
          if(req.method==='GET'&&!url.searchParams.has('id'))return json(res,{files:[]});
          throw new HttpError(410,'Файлы на этом сервере не хранятся.');
        }
        throw new HttpError(404,'Адрес не найден.');
      }
      if(!['GET','HEAD'].includes(req.method))throw new HttpError(405,'Метод не поддерживается.');
      const path=url.pathname==='/'?'/index.html':url.pathname;
      const asset=assets.get(path);if(!asset)throw new HttpError(404,'Адрес не найден.');
      const zipped=asset.gzip&&/\bgzip\b/.test(req.headers['accept-encoding']||'');
      const bytes=zipped?asset.gzip:asset.bytes;
      res.writeHead(200,{'Content-Type':asset.type,'Content-Length':bytes.length,'Vary':'Accept-Encoding',
        'Cache-Control':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache',
        ...(zipped?{'Content-Encoding':'gzip'}:{})});
      res.end(req.method==='HEAD'?undefined:bytes);
    }catch(error){
      if(res.headersSent){res.destroy();return;}
      const expected=error instanceof HttpError||error instanceof DiscoveryError||error instanceof PairingError||error instanceof TelemetryError||error instanceof AudienceError;
      const status=expected?error.status:500;
      if(status===413||!req.complete)res.setHeader('Connection','close');
      json(res,{error:expected?error.message:'Сервер подключения временно недоступен.',...(error.code&&(error instanceof HttpError||error instanceof PairingError)?{code:error.code}:{})},status);
    }
  });
  server.maxConnections=512;
  server.on('close',()=>clearInterval(sweep));server.flushDiagnostics=()=>journal.flush();
  return server;
}

if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||8788);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
  const server=await createApp();
  server.listen(port,'127.0.0.1',()=>console.log(`isend.tech V27 listening on 127.0.0.1:${port}`));
  const stop=()=>{server.close(()=>{void server.flushDiagnostics().finally(()=>process.exit(0));});setTimeout(()=>process.exit(1),10_000).unref();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
