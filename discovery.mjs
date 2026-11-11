import {createHash,createHmac,randomBytes} from 'node:crypto';
import {isIP} from 'node:net';

const KEY=/^[a-f0-9]{48}$/, ACTIVE=30_000, RETAIN=6*60*60*1000, INVITE=60_000;
export class DiscoveryError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
// Trust the single address overwritten by our own loopback nginx, never a
// forwarding header supplied directly by a remote client.
export function clientNetwork(req,trustProxy=false){
  let ip=req.socket.remoteAddress||'';
  if(trustProxy&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip)){
    const forwarded=req.headers['x-forwarded-for'];
    if(typeof forwarded==='string'&&isIP(forwarded))ip=forwarded;
  }
  if(ip.startsWith('::ffff:')&&isIP(ip.slice(7))===4)ip=ip.slice(7);
  if(isIP(ip)===4)return 'v4:'+ip;
  if(isIP(ip)===6){
    // IPv6 clients in a typical LAN share a /64, not an individual address.
    const halves=ip.toLowerCase().split('::'),left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];
    const words=halves.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left;
    return 'v6:'+words.slice(0,4).map(v=>parseInt(v,16).toString(16)).join(':');
  }
  return null;
}

// Discovery reveals only a generic device label and a random endpoint ID.
// A common Internet address is NOT proof of trust: exchange needs consent.
// Room secrets stay private. V18 may exchange transport SDP before consent;
// file/text content is gated separately by the receiving client.
export class Discovery {
  constructor({now=Date.now,max=2048}={}){
    this.now=now;this.max=max;this.salt=randomBytes(32);
    this.devices=new Map();this.invites=new Map();this.grants=new Map();
  }
  digest(token){return createHash('sha256').update(token).digest('hex');}
  network(value){return value?createHmac('sha256',this.salt).update(value).digest('hex'):null;}
  pair(a,b){return [a,b].sort().join(':');}
  sweep(){
    const now=this.now();
    for(const [id,d]of this.devices)if(now-d.at>RETAIN)this.devices.delete(id);
    for(const [id,r]of this.invites)if(now-r.at>INVITE||!this.devices.has(r.from)||!this.devices.has(r.to))this.invites.delete(id);
    for(const [id,g]of this.grants)if(now-g.at>RETAIN||!this.devices.has(g.a)||!this.devices.has(g.b))this.grants.delete(id);
  }
  presence(room,id,token,network,name){
    this.sweep();
    if(!KEY.test(id||'')||!KEY.test(token||''))throw new DiscoveryError(400,'Обновите страницу для поиска устройств.');
    const old=this.devices.get(id),auth=this.digest(token);
    if(old&&old.auth!==auth)throw new DiscoveryError(403,'Этот идентификатор уже занят. Откройте новую вкладку.');
    if(!old&&this.devices.size>=this.max)throw new DiscoveryError(503,'Поиск устройств временно занят.');
    const net=this.network(network);
    if(old&&old.network!==net)for(const [key,r]of this.invites)if(r.from===id||r.to===id)this.invites.delete(key);
    this.devices.set(id,{id,room,auth,network:net,name:name==='Телефон'?'Телефон':'Компьютер',at:this.now()});
    for(const g of this.grants.values())if(g.a===id||g.b===id)g.at=this.now();
    return this.snapshot(id);
  }
  authorize(room,id,token){
    const d=this.devices.get(id);
    if(!d||d.room!==room||!KEY.test(token||'')||d.auth!==this.digest(token))throw new DiscoveryError(403,'Обновите поиск устройств.');
    return d;
  }
  linked(id){return [...this.grants.values()].filter(g=>g.a===id||g.b===id).map(g=>g.a===id?g.b:g.a);}
  allowed(room,id){
    this.sweep();const d=this.devices.get(id);if(!d||d.room!==room)return [];
    return this.linked(id).map(peer=>this.devices.get(peer)).filter(Boolean).map(({id,room})=>({id,room}));
  }
  nearby(room,id){
    this.sweep();const own=this.devices.get(id);if(!own||own.room!==room||!own.network)return [];
    return [...this.devices.values()].filter(d=>d.id!==id&&d.room!==room&&d.network===own.network&&this.now()-d.at<=ACTIVE).slice(0,32).map(({id,room})=>({id,room}));
  }
  action(room,id,token,action,to){
    this.sweep();const own=this.authorize(room,id,token),peer=this.devices.get(to),now=this.now();
    if(!peer||!KEY.test(to||'')||to===id)throw new DiscoveryError(404,'Устройство уже не в сети.');
    const key=this.pair(id,to),r=this.invites.get(key);
    if(action==='request'){
      if(this.grants.has(key))return this.snapshot(id);
      if(!own.network||own.network!==peer.network||now-own.at>ACTIVE||now-peer.at>ACTIVE)throw new DiscoveryError(409,'Устройство сменило сеть. Обновляем список…');
      if(r){if(r.state==='pending')return this.snapshot(id);throw new DiscoveryError(429,'Запрос уже закрыт. Подождите немного перед повтором.');}
      if(this.invites.size>=this.max||[...this.invites.values()].filter(v=>(v.from===id||v.to===id||v.to===to)&&v.state==='pending').length>=8)throw new DiscoveryError(429,'Дождитесь ответа на предыдущие запросы.');
      this.invites.set(key,{from:id,to,at:now,state:'pending'});
    }else if(action==='accept'||action==='decline'){
      if(!r||r.to!==id||r.from!==to||r.state!=='pending')throw new DiscoveryError(409,'Запрос уже закрыт или истёк.');
      if(action==='accept'){
        if(own.network!==peer.network||!own.network||now-peer.at>ACTIVE)throw new DiscoveryError(409,'Устройство сменило сеть. Отправьте запрос заново.');
        if(this.linked(id).length>=8||this.linked(to).length>=8||this.grants.size>=this.max)throw new DiscoveryError(429,'Подключено слишком много устройств.');
        this.grants.set(key,{a:id,b:to,at:now});this.invites.delete(key);
      }else r.state='declined';
    }else if(action==='cancel'){
      if(!r||r.from!==id||r.to!==to)throw new DiscoveryError(409,'Запрос уже закрыт.');
      this.invites.delete(key);
    }else throw new DiscoveryError(400,'Неизвестное действие.');
    return this.snapshot(id);
  }
  snapshot(id){
    const own=this.devices.get(id),now=this.now(),linked=this.linked(id),view=d=>({id:d.id,name:d.name,seenAt:d.at});
    return {
      nearby:[...this.devices.values()].filter(d=>d.id!==id&&d.room!==own.room&&own.network&&d.network===own.network&&now-d.at<=ACTIVE&&!linked.includes(d.id)).slice(0,32).map(view),
      requests:[...this.invites.values()].filter(r=>(r.from===id||r.to===id)&&r.state!=='cancelled').map(r=>({peer:view(this.devices.get(r.from===id?r.to:r.from)),direction:r.from===id?'outgoing':'incoming',state:r.state,expires:r.at+INVITE})),
      connected:linked,
    };
  }
}
