import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const file=new URL('../public/qoi.wasm',import.meta.url);
const create=async()=> (await WebAssembly.instantiate(fs.readFileSync(file),{})).instance.exports;
function size(wasm,w,h){const required=wasm.configure(w,h);if(required>wasm.memory.buffer.byteLength)wasm.memory.grow(Math.ceil((required-wasm.memory.buffer.byteLength)/65536));}
function unpack(wasm,packet,pixels,w){
  const view=new DataView(packet.buffer,packet.byteOffset,packet.byteLength);let pos=32;
  for(let n=0;n<view.getUint16(12,true);n++){
    const x=view.getUint16(pos,true),y=view.getUint16(pos+2,true),tw=view.getUint16(pos+4,true),th=view.getUint16(pos+6,true),len=view.getUint32(pos+8,true);pos+=12;
    const src=wasm.heap_base()+16,dest=src+49152;
    new Uint8Array(wasm.memory.buffer,src,len).set(packet.subarray(pos,pos+len));
    assert.equal(wasm.decode_tile(src,len,dest,tw,th),tw*th*4);
    const decoded=new Uint8Array(wasm.memory.buffer,dest,tw*th*4);
    for(let row=0;row<th;row++)pixels.set(decoded.subarray(row*tw*4,(row+1)*tw*4),((y+row)*w+x)*4);
    pos+=len;
  }
  assert.equal(pos,packet.length);
}
test('RGBA round-trip, odd dimensions, sparse updates, reconnect full frame',async()=>{
  const encoder=await create(),decoder=await create(),w=257,h=129;size(encoder,w,h);
  let seed=7919;const pixels=new Uint8Array(w*h*4);for(let i=0;i<pixels.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels[i]=seed>>>24;}
  new Uint8Array(encoder.memory.buffer,encoder.input_pointer(),pixels.length).set(pixels);
  const len=encoder.encode_frame(1,1);const packet=Buffer.from(new Uint8Array(encoder.memory.buffer,encoder.output_pointer(),len));
  const result=new Uint8Array(pixels.length);unpack(decoder,packet,result,w);assert.deepEqual(result,pixels);
  assert.equal(encoder.encode_frame(0,2),0);
  pixels[100]=17;new Uint8Array(encoder.memory.buffer,encoder.input_pointer(),pixels.length).set(pixels);
  const changed=encoder.encode_frame(0,2);assert.equal(new DataView(encoder.memory.buffer).getUint16(encoder.output_pointer()+12,true),1);
  unpack(decoder,Buffer.from(new Uint8Array(encoder.memory.buffer,encoder.output_pointer(),changed)),result,w);assert.deepEqual(result,pixels);
  assert.ok(encoder.encode_frame(1,3)>changed);
});
test('4K static page is lossless and unchanged frames do not transmit',async()=>{
  const encoder=await create(),decoder=await create(),w=3840,h=2160;size(encoder,w,h);
  const pixels=new Uint8Array(w*h*4).fill(255);new Uint8Array(encoder.memory.buffer,encoder.input_pointer(),pixels.length).set(pixels);
  const start=performance.now(),len=encoder.encode_frame(1,1),packet=Buffer.from(new Uint8Array(encoder.memory.buffer,encoder.output_pointer(),len));
  const result=new Uint8Array(pixels.length);unpack(decoder,packet,result,w);assert.deepEqual(result,pixels);
  assert.ok(len<300000);assert.equal(encoder.encode_frame(0,2),0);
  console.log(JSON.stringify({width:w,height:h,bytes:len,roundTripMs:performance.now()-start}));
});
