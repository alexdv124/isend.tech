import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
const {code}=await transform(await readFile(new URL('../lib/block-sequence.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
const {blockSequenceIssue,parseSequenceIssue,sequenceRecoveryAllowed}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const B=262144,hash='a'.repeat(64),total=8*B+17;
const header=(offset,length=B)=>({offset,length,hash});
test('normal and final partial blocks retain strict ordering',()=>{
 assert.equal(blockSequenceIssue(header(B),B,total),null);
 assert.equal(blockSequenceIssue(header(8*B,17),8*B,total),null);
 assert.equal(blockSequenceIssue(header(total,0),total,total).recoverable,false);
});
test('aligned stale and skipped positions reject the block but permit bounded checkpoint recovery',()=>{
 for(const offset of [3*B,5*B]){
  const issue=blockSequenceIssue(header(offset),4*B,total);
  assert.equal(issue.expectedOffset,4*B);assert.equal(issue.receivedOffset,offset);
  assert.equal(issue.recoverable,true);
  assert.equal(sequenceRecoveryAllowed(issue,0),true);
  assert.equal(sequenceRecoveryAllowed(issue,1),true);
  assert.equal(sequenceRecoveryAllowed(issue,2),false);
  assert.deepEqual(parseSequenceIssue(JSON.parse(JSON.stringify(issue)),total),issue);
 }
});
test('invalid positions, lengths and hashes never trigger automatic sequence recovery',()=>{
 for(const h of [header(-B),header(3*B+1),header(total+B),header('0'),header(3*B,B-1),header(3*B,0),{...header(3*B),hash:'invalid'},header(NaN)]){
  const issue=blockSequenceIssue(h,4*B,total);assert.equal(issue.recoverable,false);
  assert.equal(sequenceRecoveryAllowed(issue,0),false);
 }
});
test('remote diagnostics cannot enable retries through forged flags or unsafe offsets',()=>{
 const issue=blockSequenceIssue(header(3*B),4*B,total);
 assert.equal(parseSequenceIssue({...issue,expectedOffset:-1},total),null);
 assert.equal(parseSequenceIssue({...issue,expectedOffset:total+1},total),null);
 assert.equal(parseSequenceIssue({...issue,expectedOffset:1},total),null);
 assert.equal(parseSequenceIssue({...issue,hashValid:'true'},total),null);
 assert.equal(parseSequenceIssue({...issue,receivedLength:1,recoverable:true},total).recoverable,false);
 assert.equal(parseSequenceIssue({...issue,expectedLength:1},total).expectedLength,B);
 assert.equal(parseSequenceIssue({...issue,receivedOffset:4*B},total),null);
});
