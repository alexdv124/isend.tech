import type {PairingState} from './browser-identity';
import type {Peer} from './signaling';

// Pair IDs survive new tabs, networks and endpoint IDs. A confirmation is a
// one-time selection intent, not a reason to override later manual choices.
export class PeerSelection{
  private known:Set<string>|null=null;
  private pending:{pair:string;endpoint?:string}|null=null;
  private manualChoice=false;
  private preferredPair:string;private save:(pair:string)=>void;
  constructor(preferredPair='',save:(pair:string)=>void=()=>{}){this.preferredPair=preferredPair;this.save=save;}
  private remember(pair:string){if(this.preferredPair===pair)return;this.preferredPair=pair;this.save(pair);}
  pairing(state:PairingState){
    const ids=new Set(state.remembered.map(p=>p.id));
    if(this.pending&&!ids.has(this.pending.pair))this.pending=null;
    if(this.preferredPair&&!ids.has(this.preferredPair))this.remember('');
    const added=this.known?state.remembered.filter(p=>!this.known!.has(p.id)):[];
    const initial=!this.known&&!this.manualChoice;
    const chosen=added.at(-1)||(initial?(state.remembered.find(p=>p.id===this.preferredPair)||state.remembered.filter(p=>p.online).at(-1)||state.remembered.at(-1)):undefined);
    this.known=ids;
    if(chosen){
      const request=state.requests.find(r=>r.state==='accepted'&&r.pairingId===chosen.id);
      this.pending={pair:chosen.id,endpoint:request?.peer.id||chosen.peer.id};this.remember(chosen.id);
    }
  }
  manual(peer?:Peer){this.manualChoice=true;this.pending=null;this.remember(peer?.remembered?peer.pairingId||'':'');}
  choose(peers:Peer[],current:string,busy=false,now=Date.now()){
    if(busy)return current;
    const livePair=(pair:string)=>peers.filter(p=>p.remembered&&p.pairingId===pair&&now-p.seenAt<30000);
    if(this.pending){
      const candidates=livePair(this.pending.pair),peer=candidates.find(p=>p.id===this.pending!.endpoint)||candidates[0];
      if(peer){this.pending=null;return peer.id;}
    }
    const selected=peers.find(p=>p.id===current);
    if(selected){
      const replacement=selected.remembered&&selected.pairingId&&now-selected.seenAt>=30000?livePair(selected.pairingId)[0]:undefined;
      return replacement?.id||current;
    }
    return livePair(this.preferredPair)[0]?.id||peers[0]?.id||'';
  }
}
