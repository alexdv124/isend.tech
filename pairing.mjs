import {createHash,randomBytes,randomInt} from 'node:crypto';
import {existsSync,readFileSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';

const KEY=/^[a-f0-9]{48}$/, HASH=/^[a-f0-9]{64}$/;
export const CODE_TTL=120_000;
const randomKey=()=>randomBytes(24).toString('hex');
export class PairingError extends Error {
  constructor(status,code){super(code.startsWith('identity_')?'Обновите страницу, чтобы восстановить связь с устройствами.':code);this.status=status;this.code=code;}
}
export function identityHash(secret){
  if(secret===undefined)return null;
  if(typeof secret!=='string'||!KEY.test(secret))throw new PairingError(401,'identity_invalid');
  return createHash('sha256').update(secret).digest('hex');
}

// A code is only a rendezvous address. It never grants access without an
// authenticated approval of the exact immutable request by the code owner.
// Only hashes of browser secrets and confirmed relationships are persisted.
export class Pairing {
  constructor({now=Date.now,path=null,chooseCode=()=>String(randomInt(10000)).padStart(4,'0'),maxPairs=10000}={}){
    this.now=now;this.path=path;this.chooseCode=chooseCode;this.maxPairs=maxPairs;
    this.codes=new Map();this.requests=new Map();this.retired=new Map();this.limits=new Map();this.pairs=new Map();
    if(path&&existsSync(path)){
      const data=JSON.parse(readFileSync(path,'utf8'));
      if(data.version!==1||!Array.isArray(data.pairs)||data.pairs.length>maxPairs)throw new Error('Invalid pairing store');
      for(const p of data.pairs){
        if(!KEY.test(p.id)||!HASH.test(p.a)||!HASH.test(p.b)||p.a===p.b||!Number.isFinite(p.at)||!['Компьютер','Телефон'].includes(p.aName)||!['Компьютер','Телефон'].includes(p.bName)||!KEY.test(p.aDevice)||!KEY.test(p.bDevice)||this.pairs.has(p.id))throw new Error('Invalid pairing record');
        this.pairs.set(p.id,p);
      }
    }
  }
  persist(){
    if(!this.path)return;
    mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
    const tmp=this.path+'.'+randomKey()+'.tmp';let fd;
    try{
      fd=openSync(tmp,'wx',0o600);writeFileSync(fd,JSON.stringify({version:1,pairs:[...this.pairs.values()]}));fsyncSync(fd);closeSync(fd);fd=undefined;
      renameSync(tmp,this.path);
    }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch{}}
  }
  sweep(){
    const now=this.now();
    for(const [code,c]of this.codes)if(now>=c.expires){this.codes.delete(code);this.retired.set(code,now+CODE_TTL);}
    for(const [id,r]of this.requests)if(now>=r.expires)this.requests.delete(id);
    for(const [code,until]of this.retired)if(now>=until)this.retired.delete(code);
    for(const [key,l]of this.limits)if(now>=l.until)this.limits.delete(key);
  }
  limit(kind,who,network){
    // Count ALL attempts, including successful lookups. Browser restarts or
    // changing local identity cannot bypass the source-network/global limits.
    const rule=kind==='lookup'?[[`u:${who}`,5,600000],[`n:${network}`,20,600000],['all',120,60000]]:
      [[`u:${who}`,5,600000],[`n:${network}`,30,600000],['all',120,60000]];
    for(const [scope,max,ms]of rule){
      const k=kind+':'+scope,l=this.limits.get(k);
      if(l&&l.count>=max)throw new PairingError(429,'pair_rate_limited');
      if(!l){if(this.limits.size>=20000)throw new PairingError(429,'pair_rate_limited');this.limits.set(k,{count:1,until:this.now()+ms});}
      else l.count++;
    }
  }
  linked(identity){return [...this.pairs.values()].filter(p=>p.a===identity||p.b===identity);}
  relationship(a,b){return this.linked(a).find(p=>p.a===b||p.b===b);}
  retire(code){const c=this.codes.get(code);if(c){this.codes.delete(code);this.retired.set(code,Math.max(c.expires,this.now())+CODE_TTL);}}
  act(own,network,v){
    this.sweep();if(!own.identity)throw new PairingError(401,'identity_required');
    const now=this.now(),who=own.identity;
    if(v.action==='create'){
      const existing=[...this.codes.values()].find(c=>c.owner===who);
      if(existing)return this.snapshot(own);
      if([...this.requests.values()].some(r=>(r.owner===who||r.from===who)&&r.state==='pending'))throw new PairingError(409,'pair_pending');
      this.limit('create',who,network);
      if(this.linked(who).length>=32)throw new PairingError(409,'pair_limit');
      let code;
      for(let i=0;i<100;i++){const candidate=this.chooseCode();if(/^\d{4}$/.test(candidate)&&!this.codes.has(candidate)&&!this.retired.has(candidate)){code=candidate;break;}}
      if(code===undefined)throw new PairingError(503,'codes_busy');
      this.codes.set(code,{code,owner:who,device:own.id,name:own.name,expires:now+CODE_TTL});
    }else if(v.action==='lookup'){
      this.limit('lookup',who,network);
      const c=typeof v.code==='string'&&/^\d{4}$/.test(v.code)?this.codes.get(v.code):null;
      if(!c)throw new PairingError(404,'code_invalid');
      if(c.owner===who)throw new PairingError(409,'code_self');
      if(this.relationship(who,c.owner))throw new PairingError(409,'already_paired');
      if(this.linked(who).length>=32||this.linked(c.owner).length>=32)throw new PairingError(409,'pair_limit');
      if([...this.requests.values()].some(r=>r.state==='pending'&&(r.from===who||r.owner===who)))throw new PairingError(409,'pair_pending');
      // The first match consumes the code and fixes both identities. A later
      // guess cannot swap the device behind a visible Accept button.
      this.retire(v.code);
      for(const [code,ownCode]of this.codes)if(ownCode.owner===who)this.retire(code);
      const id=randomKey();this.requests.set(id,{id,owner:c.owner,ownerDevice:c.device,ownerName:c.name,from:who,fromDevice:own.id,fromName:own.name,state:'pending',expires:c.expires});
    }else if(['accept','decline','cancel'].includes(v.action)){
      const r=this.requests.get(v.request);
      if(!r||r.state!=='pending'||(v.action==='cancel'?r.from!==who:r.owner!==who))throw new PairingError(409,'request_expired');
      if(v.action==='accept'){
        if(this.linked(who).length>=32||this.linked(r.from).length>=32||this.pairs.size>=this.maxPairs)throw new PairingError(409,'pair_limit');
        const pair={id:randomKey(),a:r.owner,b:r.from,aName:r.ownerName,bName:r.fromName,aDevice:r.ownerDevice,bDevice:r.fromDevice,at:now};
        this.pairs.set(pair.id,pair);
        try{this.persist();}catch{this.pairs.delete(pair.id);throw new PairingError(503,'pair_save_failed');}
        r.state='accepted';r.pair=pair.id;
      }else r.state=v.action==='decline'?'declined':'cancelled';
    }else if(v.action==='close'){
      for(const [code,c]of this.codes)if(c.owner===who)this.retire(code);
      for(const r of this.requests.values())if(r.state==='pending'&&(r.owner===who||r.from===who))r.state='cancelled';
    }else if(v.action==='forget'){
      const p=this.pairs.get(v.pair);
      if(!p||(p.a!==who&&p.b!==who))throw new PairingError(404,'pair_missing');
      this.pairs.delete(p.id);try{this.persist();}catch{this.pairs.set(p.id,p);throw new PairingError(503,'pair_save_failed');}
      for(const [id,r]of this.requests)if(r.pair===p.id)this.requests.delete(id);
    }else if(v.action!=='status')throw new PairingError(400,'pair_invalid');
    return this.snapshot(own);
  }
  snapshot(own){
    this.sweep();const who=own.identity;
    const c=[...this.codes.values()].find(c=>c.owner===who);
    return {now:this.now(),code:c?{value:c.code,expires:c.expires}:null,
      requests:[...this.requests.values()].filter(r=>r.owner===who||r.from===who).map(r=>({id:r.id,...(r.state==='accepted'?{pairingId:r.pair}:{}),direction:r.owner===who?'incoming':'outgoing',state:r.state,expires:r.expires,peer:{id:r.owner===who?r.fromDevice:r.ownerDevice,name:r.owner===who?r.fromName:r.ownerName}})),
      remembered:this.linked(who).map(p=>({id:p.id,peer:{id:p.a===who?p.bDevice:p.aDevice,name:p.a===who?p.bName:p.aName}}))};
  }
}
