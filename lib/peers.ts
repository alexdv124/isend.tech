import type {Peer} from './signaling';
export function deviceName(userAgent:string){return /Android|iPhone|iPad/i.test(userAgent)?'Телефон':'Компьютер';}
// Keep sleeping devices for the file picker, but never prefer them over an active peer.
export function rankPeers(peers:Peer[],ownName:string,now=Date.now()){
  const score=(p:Peer)=>(now-p.seenAt<30000?1:0);
  return [...peers].sort((a,b)=>score(b)-score(a)||(a.name+' '+a.id).localeCompare(b.name+' '+b.id,'ru'));
}
export function peerLabel(peer:Peer,now=Date.now(),lang:'ru'|'en'='ru'){
  return `${lang==='en'?(peer.name==='Телефон'?'Phone':'Computer'):peer.name} · ${peer.id.slice(0,4)}${now-peer.seenAt>=20000?(lang==='en'?' · offline':' · ждём возврата'):''}`;
}
