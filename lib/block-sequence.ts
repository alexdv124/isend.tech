export type BlockSequenceIssue={code:'BLOCK_SEQUENCE';expectedOffset:number;receivedOffset:number|null;expectedLength:number;receivedLength:number|null;hashValid:boolean;recoverable:boolean};
const size=262144;
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
// Recovery never accepts an out-of-order block. The receiver closes this stream
// and reopens its last durable checkpoint; a bounded sender retry sends it again.
export function blockSequenceIssue(header:{offset:unknown;length:unknown;hash:unknown},expectedOffset:number,total:number):BlockSequenceIssue|null{
 const receivedOffset=integer(header.offset)?header.offset:null,receivedLength=integer(header.length)?header.length:null;
 const expectedLength=Math.min(size,total-expectedOffset),hashValid=typeof header.hash==='string'&&/^[a-f0-9]{64}$/.test(header.hash);
 if(receivedOffset===expectedOffset&&receivedLength===expectedLength&&expectedLength>0&&hashValid)return null;
 const recoverable=receivedOffset!==null&&receivedOffset!==expectedOffset&&receivedOffset<total&&receivedOffset%size===0&&receivedLength===Math.min(size,total-receivedOffset)&&hashValid;
 return {code:'BLOCK_SEQUENCE',expectedOffset,receivedOffset,expectedLength,receivedLength,hashValid,recoverable};
}
export function parseSequenceIssue(value:unknown,total:number):BlockSequenceIssue|null{
 if(!value||typeof value!=='object')return null;
 const v=value as Partial<BlockSequenceIssue>;
 if(v.code!=='BLOCK_SEQUENCE'||!integer(v.expectedOffset)||v.expectedOffset>total||(v.expectedOffset!==total&&v.expectedOffset%size!==0)||typeof v.hashValid!=='boolean')return null;
 // Recompute lengths and retry eligibility instead of trusting remote flags.
 return blockSequenceIssue({offset:v.receivedOffset,length:v.receivedLength,hash:v.hashValid?'0'.repeat(64):null},v.expectedOffset,total);
}
export class BlockSequenceError extends Error{
 issue:BlockSequenceIssue;
 constructor(issue:BlockSequenceIssue){super('Неверный порядок блоков.');this.name='BlockSequenceError';this.issue=issue;}
}
export const MAX_SEQUENCE_RECOVERIES=2;
export function sequenceRecoveryAllowed(issue:BlockSequenceIssue,attempts:number){return issue.recoverable&&attempts<MAX_SEQUENCE_RECOVERIES;}
