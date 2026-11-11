import test from 'node:test';
import assert from 'node:assert/strict';
import {textFile,validPayload,MAX_TEXT_BYTES} from '../lib/clipboard.ts';
test('text preserves Cyrillic, emoji, whitespace, newlines and markup literally',async()=>{
 const value='  Привет 👋\nhttps://example.org/?a=1&b=2\n<script>alert(1)</script>\t\n';
 const file=textFile(value);assert.equal(await file.text(),value);assert.equal(file.size,new TextEncoder().encode(value).byteLength);
});
test('text limit is encoded UTF-8 bytes, not character count',()=>{
 assert.equal(textFile('я'.repeat(MAX_TEXT_BYTES/2)).size,MAX_TEXT_BYTES);
 assert.throws(()=>textFile('я'.repeat(MAX_TEXT_BYTES/2+1)),/512/);
 assert.throws(()=>textFile('   \n\t'),/Введите|Вставьте/);
});
test('file protocol remains compatible, text size and unknown kinds are bounded',()=>{
 assert.ok(validPayload(undefined,2**40));assert.ok(validPayload('file',2**40));
 assert.ok(validPayload('text',MAX_TEXT_BYTES));assert.equal(validPayload('text',MAX_TEXT_BYTES+1),false);assert.equal(validPayload('html',3),false);
});
