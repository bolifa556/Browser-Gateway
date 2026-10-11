import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';

test('native WebSocket DEFLATE preserves ordered QOI bytes and reduces repeated tile patterns',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0,perMessageDeflate:{threshold:1024,
    serverNoContextTakeover:false,clientNoContextTakeover:true,zlibDeflateOptions:{level:6,memLevel:9}}});
  await once(server,'listening');const incoming=once(server,'connection');
  const client=new WebSocket(`ws://127.0.0.1:${server.address().port}`,{perMessageDeflate:true});
  const [peer]=await incoming;await once(client,'open');
  try{
    assert.ok(client.extensions.includes('permessage-deflate'));
    const packet=Buffer.alloc(400000);for(let n=0;n<packet.length;n++)packet[n]=n%193;
    const before=peer._socket.bytesWritten;
    for(let sequence=1;sequence<=3;sequence++){
      packet.writeUInt32LE(0x314f5147);packet.writeUInt32LE(sequence,4);
      const received=once(client,'message');peer.send(packet,{binary:true,compress:true});
      const [decoded,binary]=await received;assert.equal(binary,true);assert.deepEqual(decoded,packet);
    }
    assert.ok(peer._socket.bytesWritten-before<packet.length,'Compression should reduce repeated data');
  }finally{client.terminate();peer.terminate();await new Promise(resolve=>server.close(resolve));}
});
