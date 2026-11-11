import {randomKey} from './transfer';
let cached='';
export function browserIdentity(){
  if(cached)return cached;
  try{
    const value=localStorage.getItem('isend-browser-key');
    cached=value&&/^[a-f0-9]{48}$/.test(value)?value:randomKey();
    localStorage.setItem('isend-browser-key',cached);
  }catch{cached=randomKey();}
  return cached;
}
export function identityHeaders(){return {'X-Isend-Identity':browserIdentity()};}
export function identityIsSaved(){try{return localStorage.getItem('isend-browser-key')===browserIdentity();}catch{return false;}}

export type PairRequest={id:string;pairingId?:string;direction:'incoming'|'outgoing';state:'pending'|'accepted'|'declined'|'cancelled';expires:number;peer:{id:string;name:string}};
export type PairingState={now:number;code:{value:string;expires:number}|null;requests:PairRequest[];remembered:{id:string;peer:{id:string;name:string};online:boolean}[]};
