import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeCapture} from '../src/native-capture.js';
const packet=n=>{const b=Buffer.alloc(32);b.writeUInt32LE(n,4);return b;};
function mock(session){
 const commands=[],frames=[],capture=Object.create(NativeCapture.prototype);
 Object.assign(capture,{session,pendingNativeFrames:new Map(),readyState:1,child:{stdin:{write(v){commands.push(v);}}},emit(_event,b){frames.push(b.readUInt32LE(4));}});
 return {capture,commands,frames};
}
test('wire sequences survive encoder restart; old ACK cannot release the new frame',()=>{
 const session={},a=mock(session),b=mock(session);a.capture.publish(packet(1));b.capture.publish(packet(1));
 assert.deepEqual(a.frames,[1]);assert.deepEqual(b.frames,[2]);
 b.capture.send(JSON.stringify({type:'ack',sequence:1}));assert.deepEqual(b.commands,[]);
 b.capture.send(JSON.stringify({type:'ack',sequence:2}));assert.deepEqual(b.commands,['A 1\n']);
 b.capture.send(JSON.stringify({type:'ack',sequence:2}));assert.equal(b.commands.length,1);
});
test('reset and delayed duplicate ACKs do not manufacture native credits',()=>{
 const {capture,commands}=mock({});capture.publish(packet(1));capture.publish(packet(2));
 capture.send(JSON.stringify({type:'reset'}));capture.send(JSON.stringify({type:'ack',sequence:1}));
 assert.deepEqual(commands,['R\n']);capture.publish(packet(3));capture.send(JSON.stringify({type:'ack',sequence:3}));
 assert.deepEqual(commands,['R\n','A 3\n']);
});
test('a retired capture cannot advance a live session sequence',()=>{
 const session={frameSequence:7},{capture,frames}=mock(session);capture.stopped=true;capture.publish(packet(3));
 assert.equal(session.frameSequence,7);assert.deepEqual(frames,[]);
});
