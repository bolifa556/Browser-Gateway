// Bounded native capture credits are acknowledged per sequence, not per latest
// packet. No lossy dropping: every client must consume each ordered delta.
export class FrameFlow {
  constructor(encoder,clients,maxBufferedBytes){
    Object.assign(this,{encoder,clients,maxBufferedBytes});this.frames=new Map();this.samples=[];this.rawBytes=0;
  }
  packet(packet){
    if(packet.length<32||packet.readUInt32LE(0)!==0x314f5147){this.encoder.close(1008,'Invalid frame');return;}
    const sequence=packet.readUInt32LE(4),frame={waiting:new Set(),timer:null,sealed:false,at:performance.now(),bytes:packet.length};
    this.rawBytes+=packet.length;
    this.frames.set(sequence,frame);
    for(const client of this.clients){
      if(client.readyState!==1)continue;
      if(client.bufferedAmount>this.maxBufferedBytes){client.close(1013,'Connection cannot keep up');this.remove(client);continue;}
      frame.waiting.add(client);client.send(packet,{binary:true,compress:true});
    }
    frame.sealed=true;frame.timer=setTimeout(()=>{
      for(const client of [...frame.waiting]){client.close(1013,'Frame acknowledgement timeout');this.remove(client);}
      this.flush(sequence);
    },2500);frame.timer.unref();this.flush(sequence);
  }
  flush(sequence){
    const frame=this.frames.get(sequence);if(!frame||!frame.sealed||frame.waiting.size)return;
    clearTimeout(frame.timer);this.frames.delete(sequence);
    this.samples.push({at:frame.at,ackMs:performance.now()-frame.at,bytes:frame.bytes});if(this.samples.length>240)this.samples.shift();
    if(this.encoder.readyState===1)this.encoder.send(JSON.stringify({type:'ack',sequence}));
  }
  ack(client,sequence){this.frames.get(sequence)?.waiting.delete(client);this.flush(sequence);}
  remove(client){for(const [sequence,frame] of this.frames){frame.waiting.delete(client);this.flush(sequence);}}
  reset(){this.clear();if(this.encoder.readyState===1)this.encoder.send(JSON.stringify({type:'reset'}));}
  clear(){for(const frame of this.frames.values())clearTimeout(frame.timer);this.frames.clear();}
}
