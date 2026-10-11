import crypto from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {NativeCapture} from './native-capture.js';
import {FrameFlow} from './frame-flow.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const send=(socket,message)=>{if(socket?.readyState===1)socket.send(JSON.stringify(message));};
const keys={Escape:'Escape',Enter:'Return',NumpadEnter:'KP_Enter',Tab:'Tab',Backspace:'BackSpace',Delete:'Delete',Insert:'Insert',
  Home:'Home',End:'End',PageUp:'Prior',PageDown:'Next',ArrowLeft:'Left',ArrowRight:'Right',ArrowUp:'Up',ArrowDown:'Down',
  ShiftLeft:'Shift_L',ShiftRight:'Shift_R',ControlLeft:'Control_L',ControlRight:'Control_R',AltLeft:'Alt_L',AltRight:'Alt_R',
  MetaLeft:'Super_L',MetaRight:'Super_R',CapsLock:'Caps_Lock',Space:'space',Minus:'minus',Equal:'equal',BracketLeft:'bracketleft',
  BracketRight:'bracketright',Backslash:'backslash',Semicolon:'semicolon',Quote:'apostrophe',Backquote:'grave',Comma:'comma',Period:'period',Slash:'slash'};
const keyName=m=>keys[m.code]||(/^Key[A-Z]$/.test(m.code)?m.code.slice(3).toLowerCase():/^Digit[0-9]$/.test(m.code)?m.code.slice(5):/^F([1-9]|1[0-2])$/.test(m.code)?m.code:'');

export class NativeLogin {
  constructor(manager,key,ownerSid,viewport){
    Object.assign(this,{manager,key,ownerSid});this.role='admin';this.id=crypto.randomUUID();this.clients=new Set();
    this.pending=new Map();this.printableKeys=new Set();this.serial=0;this.chromeLeft=this.chromeTop=0;this.lastActive=Date.now();this.closing=false;
    this.resizeQueue=Promise.resolve();this.setViewport(viewport);
  }
  setViewport({width=1280,height=800,deviceScaleFactor=1}={}){
    this.width=Math.max(320,Math.min(8192,Math.round(Number(width)||1280)));
    this.height=Math.max(240,Math.min(4320,Math.round(Number(height)||800)));
    const requested=Math.max(.5,Math.min(4,Number(deviceScaleFactor)||1));
    // Chrome itself performs its ordinary HiDPI rendering; no CDP emulation.
    this.dpr=this.dpr||Math.min(requested,this.manager.config.streamMaxWidth/this.width,this.manager.config.streamMaxHeight/this.height);
    this.frameWidth=Math.min(this.manager.config.streamMaxWidth,Math.round(this.width*this.dpr));
    this.frameHeight=Math.min(this.manager.config.streamMaxHeight,Math.round(this.height*this.dpr));
  }
  async start(){
    const {config}=this.manager;
    // The same persistent profile, cache, proxy and Chrome executable are used.
    // No debugging pipe/port, test type, automation switches or injected scripts.
    const args=[`--user-data-dir=${config.profileDir}`,'--restore-last-session','--no-sandbox','--no-first-run','--no-default-browser-check',
      '--hide-crash-restore-bubble','--password-store=basic','--disable-gpu','--disable-quic',
      '--disable-breakpad','--disable-crash-reporter','--lang=en-US','--force-color-profile=srgb',`--force-device-scale-factor=${this.dpr}`,
      `--disk-cache-dir=${path.join(config.dataRoot,'cache/chromium')}`,'--disk-cache-size=268435456',
      '--window-position=0,0',`--window-size=${this.width},${this.height}`];
    if(config.upstreamProxy)args.push(`--proxy-server=${config.upstreamProxy}`);
    args.push(config.chatgptUrl);
    this.chrome=spawn('/opt/google/chrome/chrome',args,{stdio:'ignore',env:{...process.env,TZ:'America/Los_Angeles'}});
    this.chromeExited=new Promise(resolve=>this.chrome.once('exit',()=>{this.exited=true;resolve();}));
    this.chrome.on('error',error=>{this.manager.logger.warn('native_login_browser_failed',{error});});
    this.chrome.on('exit',()=>{if(!this.closing)void this.manager.finishNativeLogin(null,true);});
    this.input=spawn('/app/native-input',[String(this.chrome.pid)],{stdio:['pipe','pipe','ignore']});
    this.input.stdin.on('error',()=>{});
    this.input.on('error',()=>this.failPending());this.input.on('exit',()=>this.failPending());
    this.lines=createInterface({input:this.input.stdout});
    this.lines.on('line',line=>{try{const m=JSON.parse(line),pending=this.pending.get(m.request);if(pending){this.pending.delete(m.request);clearTimeout(pending.timer);m.ok?pending.resolve(m):pending.reject(Error('原生浏览器窗口尚未就绪'));}}catch{}});
    let geometry;
    for(let retry=0;retry<120;retry++){
      if(this.exited)throw Error('手动登录浏览器启动失败');
      geometry=await this.command('info').catch(()=>null);if(geometry)break;await pause(100);
    }
    if(!geometry)throw Error('手动登录浏览器窗口启动超时');
    await this.applyGeometry(geometry,true);
    this.poll=setInterval(()=>void this.pollWindow(),500);this.poll.unref();
    this.idle=setInterval(()=>{if(Date.now()-this.lastActive>30*60_000)void this.manager.finishNativeLogin(null,true);},60_000);this.idle.unref();
  }
  failPending(){for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error('手动登录窗口已关闭'));}this.pending.clear();}
  command(command,wait=true){
    if(this.closing&&command!=='close')return Promise.reject(Error('登录窗口正在关闭'));
    const id=wait?++this.serial:0;
    if(!wait){if(!this.input?.stdin.destroyed)this.input.stdin.write(`${id} ${command}\n`);return;}
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('原生输入接口超时'));},5000);timer.unref();
      this.pending.set(id,{resolve,reject,timer});
      this.input.stdin.write(`${id} ${command}\n`,error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
    });
  }
  broadcast(message){for(const client of this.clients)send(client,message);}
  ready(){return {type:'ready',id:this.id,role:'admin',mode:'native-login',width:this.width,height:this.height,deviceScaleFactor:this.dpr,frameWidth:this.frameWidth,frameHeight:this.frameHeight,transport:'qoi'};}
  async applyGeometry(geometry,resize=false){
    if(resize){await this.command(`resize ${this.frameWidth} ${this.frameHeight}`);await pause(120);geometry=await this.command('info');}
    const changed=this.windowId!==geometry.window||this.frameWidth!==geometry.width||this.frameHeight!==geometry.height;
    this.windowId=geometry.window;this.captureTitle=`xid:${geometry.window}`;
    this.frameWidth=geometry.width;this.frameHeight=geometry.height;this.width=this.frameWidth/this.dpr;this.height=this.frameHeight/this.dpr;
    if(changed||resize){this.manager.stopEncoder(this);this.broadcast(this.ready());if(this.clients.size)this.startCapture();}
  }
  async pollWindow(){
    if(this.closing||this.polling)return;this.polling=true;
    try{const geometry=await this.command('info');if(geometry.window!==this.windowId)await this.applyGeometry(geometry,true);}catch{}finally{this.polling=false;}
  }
  startCapture(){
    if(this.closing||!this.clients.size)return;
    this.attachEncoder(new NativeCapture(this,32));
    this.broadcast({type:'stream',transport:'rgb-qoi',width:this.frameWidth,height:this.frameHeight,fps:this.manager.config.streamMaxFps});
  }
  addClient(socket){
    if(this.clients.size)throw Error('手动登录窗口已由另一个管理员标签页连接');
    this.clients.add(socket);this.lastActive=Date.now();socket._socket?.setNoDelay(true);send(socket,this.ready());this.startCapture();
  }
  removeClient(socket){this.clients.delete(socket);this.frameFlow?.remove(socket);if(!this.clients.size)this.manager.stopEncoder(this);}
  attachEncoder(socket){
    this.frameFlow?.clear();this.encoder?.close();this.encoder=socket;
    const flow=this.frameFlow=new FrameFlow(socket,this.clients,Math.max(64*1024*1024,this.frameWidth*this.frameHeight*4+48*1024*1024));
    socket.on('message',(packet,binary)=>{
      if(!binary||this.encoder!==socket)return;flow.packet(packet);
    });
    socket.on('close',()=>{flow.clear();if(this.encoder===socket)this.encoder=null;});
  }
  async handleMessage(raw,socket){
    let m;try{m=JSON.parse(String(raw));}catch{return;}
    if(m.type==='frameAck'){this.frameFlow?.ack(socket,m.sequence);return;}
    if(m.type==='frameReset'){this.frameFlow?.reset();return;}
    if(m.type==='diagnostic-ping'){send(socket,{type:'diagnostic-pong',probeId:m.probeId});return;}
    if(!['viewport','mouse','wheel','key','text','reload','back','forward'].includes(m.type))return;
    this.lastActive=Date.now();
    try{
      if(m.type==='viewport'){
        this.latestViewport=m;this.resizeQueue=this.resizeQueue.catch(()=>{}).then(async()=>{const value=this.latestViewport;if(value){this.latestViewport=null;this.setViewport(value);await this.applyGeometry(await this.command('info'),true);}});await this.resizeQueue;return;
      }
      if(m.type==='mouse'||m.type==='wheel'){
        this.command(`move ${Math.round((Number(m.x)||0)*this.dpr)} ${Math.round((Number(m.y)||0)*this.dpr)}`,false);
        if(m.type==='mouse'&&m.eventType!=='mouseMoved'){
          const button={left:1,middle:2,right:3,back:8,forward:9}[m.button]||1;
          this.command(`button ${m.eventType==='mousePressed'?1:0} ${button}`,false);
          if(m.eventType==='mouseReleased')send(socket,{type:'ime-anchor',x:Number(m.x)||0,y:(Number(m.y)||0)+20});
        }
        if(m.type==='wheel')for(const [delta,positive,negative] of [[Number(m.deltaY)||0,5,4],[Number(m.deltaX)||0,7,6]]){
          for(let i=0;i<Math.min(12,Math.ceil(Math.abs(delta)/100));i++){this.command(`button 1 ${delta>0?positive:negative}`,false);this.command(`button 0 ${delta>0?positive:negative}`,false);}
        }
      }else if(m.type==='key'){
        if(m.eventType==='keyDown'&&typeof m.text==='string'&&m.text.length>0&&m.text.length<=4){this.printableKeys.add(m.code);this.command(`text ${Buffer.from(m.text).toString('hex')}`,false);return;}
        if(m.eventType==='keyUp'&&this.printableKeys.delete(m.code))return;
        const name=keyName(m);if(name)this.command(`key ${m.eventType==='keyDown'?1:0} ${name}`,false);
        else if(m.eventType==='keyDown'&&typeof m.text==='string'&&m.text.length<=4)this.command(`text ${Buffer.from(m.text).toString('hex')}`,false);
      }else if(m.type==='text'&&typeof m.text==='string'&&Buffer.byteLength(m.text)<=65536){this.command(`text ${Buffer.from(m.text).toString('hex')}`,false);}
      else if(m.type==='reload')await this.command('key 1 ctrl+r').then(()=>this.command('key 0 ctrl+r'));
      else if(m.type==='back'||m.type==='forward')await this.command(`key 1 alt+${m.type==='back'?'Left':'Right'}`).then(()=>this.command(`key 0 alt+${m.type==='back'?'Left':'Right'}`));
    }catch{this.broadcast({type:'notice',message:'手动登录窗口暂不可用，请等待或结束登录模式'});}
  }
  async close(){
    if(this.closing)return;this.closing=true;clearInterval(this.poll);clearInterval(this.idle);clearTimeout(this.ackTimer);clearTimeout(this.retryTimer);
    this.manager.stopEncoder(this);for(const client of this.clients)client.close(1001,'Login mode finished');
    // Ask Chrome to close normally so the persistent cookie database is flushed.
    await this.command('close').catch(()=>{});
    await Promise.race([this.chromeExited,pause(5000)]);
    if(!this.exited){this.chrome.kill('SIGTERM');await Promise.race([this.chromeExited,pause(5000)]);}
    if(!this.exited)throw Error('浏览器仍在退出；为保护 profile，不会启动第二个实例');
    this.input?.stdin.end();this.input?.kill();this.lines?.close();this.failPending();
  }
}
