import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const HEX={identity:/^[a-f0-9]{64}$/,device:/^[a-f0-9]{12}$/,visitor:/^[a-f0-9]{32}$/};
const digest=s=>createHash('sha256').update(s).digest('hex');
const empty=()=>({version:1,identities:[],devices:[],visitors:[],invites:[]});
export class AudienceError extends Error{constructor(status,message){super(message);this.status=status;}}
export class AudienceStore{
  constructor({path=null,now=Date.now}={}){this.path=path;this.now=now;this.cached=null;this.loadedAt=0;this.limits=new Map();this.global={at:0,count:0};}
  limit(network){
    const now=this.now();for(const [k,v]of this.limits)if(now-v.at>=60000)this.limits.delete(k);
    if(now-this.global.at>=60000)this.global={at:now,count:0};
    const key=digest(network||'unknown'),v=this.limits.get(key)||{at:now,count:0};
    if(v.count>=20||this.global.count>=120||!this.limits.has(key)&&this.limits.size>=512)throw new AudienceError(429,'Слишком много попыток. Подождите минуту.');
    v.count++;this.global.count++;this.limits.set(key,v);
  }
  snapshot(fresh=false){
    if(!this.path)return empty();
    if(!fresh&&this.cached&&this.now()-this.loadedAt<1000)return this.cached;
    let s;try{s=JSON.parse(readFileSync(this.path,'utf8'));}catch(e){if(e.code==='ENOENT')s=empty();else throw e;}
    if(s.version!==1||!['identities','devices','visitors','invites'].every(k=>Array.isArray(s[k])&&s[k].length<=1024))throw new Error('Invalid audience registry');
    for(const [kind,field]of [['identity','identities'],['device','devices'],['visitor','visitors']])for(const r of s[field])if(!HEX[kind].test(r.value))throw new Error('Invalid audience record');
    for(const r of s.invites)if(!HEX.identity.test(r.hash)||!Number.isFinite(r.expires)||!Number.isInteger(r.remaining)||r.remaining<0)throw new Error('Invalid audience invite');
    this.cached=s;this.loadedAt=this.now();return s;
  }
  change(fn){
    if(!this.path)throw new AudienceError(503,'Учёт тестовых устройств пока не настроен.');
    mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
    const lock=this.path+'.lock';let fd,tmp;
    try{fd=openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new AudienceError(503,'Список устройств обновляется. Повторите через несколько секунд.');throw e;}
    try{
      const s=structuredClone(this.snapshot(true));s.invites=s.invites.filter(v=>v.expires>this.now()&&v.remaining>0);
      const result=fn(s);tmp=this.path+'.'+randomBytes(12).toString('hex')+'.tmp';
      const out=openSync(tmp,'wx',0o600);try{writeFileSync(out,JSON.stringify(s));fsyncSync(out);}finally{closeSync(out);}
      renameSync(tmp,this.path);this.cached=s;this.loadedAt=this.now();return result;
    }finally{closeSync(fd);try{unlinkSync(lock);}catch{}if(tmp)try{unlinkSync(tmp);}catch{}}
  }
  add(kind,value,label=''){
    if(!HEX[kind]?.test(value))throw new Error('Use the full hash or 12-character endpoint, never a four-character display label');
    const field={identity:'identities',device:'devices',visitor:'visitors'}[kind];
    return this.change(s=>{const found=s[field].find(r=>r.value===value);if(found)return found;if(s[field].length>=1024)throw new AudienceError(429,'Список тестовых устройств заполнен.');const r={value,label:String(label).slice(0,100),at:new Date(this.now()).toISOString()};s[field].push(r);return r;});
  }
  invite({hours=24,uses=16}={}){
    if(!Number.isFinite(hours)||hours<=0||hours>168||!Number.isInteger(uses)||uses<1||uses>64)throw new Error('Invalid invite lifetime/uses');
    const token=randomBytes(24).toString('hex');const expires=this.now()+hours*3600000;
    this.change(s=>{if(s.invites.length>=32)throw new AudienceError(429,'Слишком много ссылок.');s.invites.push({hash:digest(token),expires,remaining:uses});});
    return {token,expires,uses};
  }
  isInternal(identity,device){const s=this.snapshot();return s.identities.some(r=>r.value===identity)||!!device&&s.devices.some(r=>r.value===device.slice(0,12));}
  enroll(identity,token){
    if(!HEX.identity.test(identity||''))throw new AudienceError(401,'Не удалось определить этот браузер.');
    if(typeof token!=='string'||!/^[a-f0-9]{48}$/.test(token))throw new AudienceError(403,'Нужна действующая ссылка владельца.');
    return this.change(s=>{
      const invite=s.invites.find(r=>r.hash===digest(token));if(!invite)throw new AudienceError(403,'Ссылка истекла или уже использована. Попросите новую у владельца.');
      if(!s.identities.some(r=>r.value===identity)){if(s.identities.length>=1024)throw new AudienceError(429,'Список тестовых устройств заполнен.');s.identities.push({value:identity,label:'Отмечен по ссылке владельца',at:new Date(this.now()).toISOString()});invite.remaining--;}
      return {internal:true};
    });
  }
}
