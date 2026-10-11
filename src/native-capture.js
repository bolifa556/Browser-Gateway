import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
export class NativeCapture extends EventEmitter {
  constructor(session,workers){
    super();this.session=session;this.pendingNativeFrames=new Map();this.readyState=1;this.header=Buffer.allocUnsafe(4);this.headerLength=0;this.packet=null;this.position=0;this.stopped=false;
    this.child=spawn('/app/capture',[session.captureTitle,String(session.frameWidth),String(session.frameHeight),String(session.chromeLeft||0),String(session.chromeTop||0),String(session.manager.config.streamMaxFps),String(workers)],{stdio:['pipe','pipe','pipe']});
    this.child.stdout.on('data',chunk=>{
      let offset=0;
      while(offset<chunk.length){
        if(!this.packet){
          const n=Math.min(4-this.headerLength,chunk.length-offset);chunk.copy(this.header,this.headerLength,offset,offset+n);this.headerLength+=n;offset+=n;
          if(this.headerLength<4)continue;
          const size=this.header.readUInt32LE(0);this.headerLength=0;
          if(size<32||size>256*1024*1024){this.close();return;}
          this.packet=Buffer.allocUnsafe(size);this.position=0;
        }
        const n=Math.min(this.packet.length-this.position,chunk.length-offset);chunk.copy(this.packet,this.position,offset,offset+n);this.position+=n;offset+=n;
        if(this.position===this.packet.length){const packet=this.packet;this.packet=null;this.publish(packet);}
      }
    });
    this.child.stderr.on('data',chunk=>session.manager.logger.info('native_capture',{id:session.id,detail:String(chunk).slice(0,2000)}));
    this.child.on('error',error=>session.manager.logger.warn('native_capture_failed',{error}));
    this.child.stdin.on('error',()=>{});
    this.child.on('exit',(code,signal)=>{
      this.readyState=3;this.emit('close');
      if(!this.stopped&&!session.closing&&session.clients.size){session.manager.logger.warn('native_capture_exit',{id:session.id,code,signal});clearTimeout(session.retryTimer);session.retryTimer=setTimeout(()=>session.manager.requestEncoder(session),1000);session.retryTimer.unref();}
    });
  }
  publish(packet){
    if(this.stopped||this.readyState!==1)return;
    // A resize/reallocation restarts the native encoder at 1. Keep wire sequence
    // numbers unique for this session so a late pre-resize ACK cannot release a
    // new encoder's frame with the same native sequence number.
    const nativeSequence=packet.readUInt32LE(4);
    const sequence=this.session.frameSequence=((this.session.frameSequence||0)+1)>>>0;
    packet.writeUInt32LE(sequence,4);this.pendingNativeFrames.set(sequence,nativeSequence);
    this.emit('message',packet,true);
  }
  send(raw){
    if(this.readyState!==1)return;const message=JSON.parse(raw);
    if(message.type==='ack'&&this.pendingNativeFrames.has(message.sequence)){
      const native=this.pendingNativeFrames.get(message.sequence);this.pendingNativeFrames.delete(message.sequence);this.child.stdin.write(`A ${native}\n`);
    }
    if(message.type==='reset'){this.pendingNativeFrames.clear();this.child.stdin.write('R\n');}
  }
  close(){if(this.stopped)return;this.stopped=true;this.readyState=3;this.child.kill('SIGTERM');}
}
