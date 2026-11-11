export type Signal = { id: string; to: string; type: 'offer' | 'answer'; sdp: string };
export type Peer = { id: string; name: string; protocol?: number; clipboard?: number; warm?:number; preferred?:string|null; sameRoom?:boolean;paired?:boolean;remembered?:boolean;pairingId?:string; seenAt: number; signal: Signal | null };
