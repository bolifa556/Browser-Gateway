import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FrameFlow} from '../src/frame-flow.js';
const packet=sequence=>{const b=Buffer.alloc(32);b.writeUInt32LE(0x314f5147);b.writeUInt32LE(sequence,4);return b;};
const client=()=>({readyState:1,bufferedAmount:0,sent:[],send(b){this.sent.push(b.readUInt32LE(4));},close(){this.readyState=3;}});
const setup=clients=>{const commands=[],encoder={readyState:1,send(raw){commands.push(JSON.parse(raw));},close(){this.readyState=3;}};return {flow:new FrameFlow(encoder,new Set(clients),1000),commands};};
test('two in-flight frames retain independent ACKs; duplicate and unknown ACKs cannot create credits',()=>{
  const a=client(),b=client(),{flow,commands}=setup([a,b]);
  flow.packet(packet(1));flow.packet(packet(2));
  flow.ack(a,1);flow.ack(a,2);assert.equal(commands.length,0);
  flow.ack(b,1);assert.deepEqual(commands,[{type:'ack',sequence:1}]);
  flow.ack(b,1);flow.ack(a,900);assert.equal(commands.length,1);
  flow.ack(b,2);assert.deepEqual(commands.at(-1),{type:'ack',sequence:2});assert.equal(flow.frames.size,0);
});
test('three in-flight frames remain ordered and individually acknowledged',()=>{
  const a=client(),{flow,commands}=setup([a]);for(const n of [1,2,3])flow.packet(packet(n));
  assert.deepEqual(a.sent,[1,2,3]);assert.equal(flow.frames.size,3);
  for(const n of [1,2,3])flow.ack(a,n);
  assert.deepEqual(commands,[1,2,3].map(sequence=>({type:'ack',sequence})));assert.equal(flow.frames.size,0);
});
test('disconnect releases both pending frames without stalling another viewer',()=>{
  const a=client(),b=client(),{flow,commands}=setup([a,b]);flow.packet(packet(1));flow.packet(packet(2));
  flow.ack(a,1);flow.ack(a,2);flow.remove(b);
  assert.deepEqual(commands,[{type:'ack',sequence:1},{type:'ack',sequence:2}]);assert.equal(flow.frames.size,0);
});
test('reset retires the old epoch; delayed old ACKs do not release new frames',()=>{
  const a=client(),{flow,commands}=setup([a]);flow.packet(packet(1));flow.packet(packet(2));flow.reset();
  flow.packet(packet(3));flow.ack(a,1);flow.ack(a,2);assert.deepEqual(commands,[{type:'reset'}]);
  flow.ack(a,3);assert.deepEqual(commands.at(-1),{type:'ack',sequence:3});
});
test('slow socket removal cannot acknowledge a partially constructed frame',()=>{
  const slow=client(),fast=client();slow.bufferedAmount=1001;const {flow,commands}=setup([slow,fast]);
  flow.packet(packet(1));assert.equal(slow.readyState,3);assert.equal(commands.length,0);
  flow.ack(fast,1);assert.deepEqual(commands,[{type:'ack',sequence:1}]);
});
