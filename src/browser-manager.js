import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, request } from 'playwright';
import { CLIPBOARD_BRIDGE, NATIVE_SELECT_BRIDGE } from './page-bridges.js';
import { NativeCapture } from './native-capture.js';
import { NativeLogin } from './native-login.js';
import { startNetworkDiagnostic } from './network-diagnostic.js';
import { FrameFlow } from './frame-flow.js';
import { measureRender } from './render-diagnostic.js';
import { waitForPaint } from './paint-ready.js';
import { TOUCH_INPUT_BRIDGE } from './touch-bridge.js';
import { windowInsets } from './window-insets.js';
import { createBrowserKeepalive } from './browser-keepalive.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const filename=v=>String(v||'download').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').replace(/^\.+/,'').slice(0,180)||'download';
const send=(socket,message)=>{if(socket?.readyState===1)socket.send(JSON.stringify(message));};

export class BrowserManager {
  constructor(config,store,logger){
    Object.assign(this,{config,store,logger});this.sessions=new Map();this.byId=new Map();this.pageOwners=new Map();
    this.downloads=new Map();this.creating=new Map();this.context=null;this.keepalive=null;this.stopping=false;this.mode='normal';
  }
  async start(){
    for(const directory of [this.config.profileDir,this.config.uploadDir,this.config.downloadDir])await fsp.mkdir(directory,{recursive:true,mode:0o700});
    // The container entrypoint holds data/.service.lock. Chromium's symlinks can
    // survive a container replacement and reference the previous hostname.
    for(const name of ['SingletonLock','SingletonCookie','SingletonSocket']){
      const file=path.join(this.config.profileDir,name);
      if((await fsp.lstat(file).catch(()=>null))?.isSymbolicLink())await fsp.unlink(file);
    }
    const preferenceFile=path.join(this.config.profileDir,'Default/Preferences');
    await fsp.mkdir(path.dirname(preferenceFile),{recursive:true,mode:0o700});
    const preferences=await fsp.readFile(preferenceFile,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return {};throw error;});
    // A remote download is delivered to the client's browser. Showing Chromium's
    // own partial download bubble on the private server window is redundant.
    preferences.download_bubble={...preferences.download_bubble,partial_view_enabled:false};
    preferences.profile={...preferences.profile,exit_type:'Normal',exited_cleanly:true};
    preferences.browser={...preferences.browser,custom_chrome_frame:false};
    // Website language belongs to ChatGPT's own settings, not a browser UI popup
    // that can be painted over the remotely captured content area.
    preferences.translate={...preferences.translate,enabled:false};
    // Chrome's cookie store consults the profile's session startup preference.
    // Set ordinary "Continue where you left off" in addition to the launch flag.
    preferences.session={...preferences.session,restore_on_startup:1};
    const temporaryPreferences=`${preferenceFile}.gptw-${process.pid}`;
    await fsp.writeFile(temporaryPreferences,JSON.stringify(preferences),{mode:0o600});
    await fsp.rename(temporaryPreferences,preferenceFile);
    if(this.config.upstreamProxy){
      let last;for(let attempt=0;attempt<12;attempt++){
        let probe;try{probe=await request.newContext({proxy:{server:this.config.upstreamProxy}});await probe.get('https://chatgpt.com/cdn-cgi/trace',{timeout:10000});last=null;break;}
        catch(error){last=error;await pause(1000);}finally{await probe?.dispose().catch(()=>{});}
      }
      if(last)throw last;
    }
    this.windowManager=spawn('openbox',['--sm-disable','--config-file','/app/src/openbox.xml'],{stdio:'ignore'});
    await pause(300);
    await this.startControlledBrowser();
    this.cleanupTimer=setInterval(()=>void this.cleanup(),60000);this.cleanupTimer.unref();
  }
  async startControlledBrowser(){
    this.context=await chromium.launchPersistentContext(this.config.profileDir,{
      channel:'chrome',headless:false,acceptDownloads:true,chromiumSandbox:false,locale:'en-US',timezoneId:'America/Los_Angeles',
      viewport:{width:1280,height:800},proxy:this.config.upstreamProxy?{server:this.config.upstreamProxy}:undefined,
      permissions:['clipboard-read','clipboard-write'],
      args:['--restore-last-session','--hide-crash-restore-bubble','--autoplay-policy=no-user-gesture-required','--disable-quic',
        '--disable-breakpad','--disable-crash-reporter','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding','--no-first-run','--no-default-browser-check','--password-store=basic',
        '--num-raster-threads=32','--disable-gpu','--enable-logging=stderr',
        `--disk-cache-dir=${path.join(this.config.dataRoot,'cache/chromium')}`,'--disk-cache-size=268435456'],
    });
    this.browserCdp=await this.context.browser().newBrowserCDPSession();
    this.context.setDefaultTimeout(10000);this.context.setDefaultNavigationTimeout(45000);
    await this.context.exposeBinding('__gptWebClipboard',({page},value)=>{
      const image=value.image?.type==='image/png'&&typeof value.image.data==='string'&&value.image.data.length<=40_000_000?value.image:undefined;
      this.pageOwners.get(page)?.broadcast({type:'clipboard',text:String(value.text||''),html:String(value.html||''),image});
    });
    await this.context.exposeBinding('__gptWebCursor',({page},cursor)=>{
      const session=this.pageOwners.get(page);if(session?.page===page&&session.cursor!==cursor){session.cursor=cursor;session.broadcast({type:'cursor',cursor});}
    });
    await this.context.exposeBinding('__gptWebInputState',({page,frame},value)=>{
      const session=this.pageOwners.get(page);if(session?.page!==page)return false;
      if(value?.initialized)return Boolean(session.touchEnabled);
      return session.updateInputState(frame,value);
    });
    await this.context.addInitScript({content:CLIPBOARD_BRIDGE});await this.context.addInitScript({content:NATIVE_SELECT_BRIDGE});
    await this.context.addInitScript({content:TOUCH_INPUT_BRIDGE});
    this.context.on('page',page=>void this.adoptPopup(page));
    this.context.on('close',()=>{this.keepalive=null;if(!this.stopping&&!this.closingBrowser){this.logger.error('browser_closed');setTimeout(()=>process.exit(1),100).unref();}});
    this.bootstrap=this.context.pages()[0];for(const page of this.context.pages().slice(1))await page.close().catch(()=>{});
    this.keepalive=await createBrowserKeepalive(this.browserCdp);
    this.logger.info('browser_keepalive_ready',{minimized:true});
    this.mode='normal';
    this.logger.info('browser_started',{transport:'lossless-qoi',fps:this.config.streamMaxFps});
  }
  async startNativeLogin(key,ownerSid,viewport){
    if(this.transitioning)throw Error('浏览器正在切换模式，请稍后重试');
    if(this.nativeLogin){
      if(this.nativeLogin.ownerSid!==ownerSid||this.nativeLogin.key!==key)throw Error('另一管理员标签页正在手动登录');
      return this.nativeLogin.ready();
    }
    this.transitioning=true;this.mode='switching';
    try{
      for(const session of this.sessions.values())session.broadcast({type:'maintenance',message:'管理员正在手动登录共享账号，完成后将自动重连'});
      await Promise.allSettled([...this.creating.values()]);
      for(const session of [...this.sessions.values()])await session.close();
      this.closingBrowser=true;await this.context.close();this.context=null;this.browserCdp=null;this.bootstrap=null;this.closingBrowser=false;
      const login=new NativeLogin(this,key,ownerSid,viewport);this.nativeLogin=login;
      await login.start();this.mode='native-login';
      this.logger.info('native_login_started',{debugging:false,profile:'persistent'});
      return login.ready();
    }catch(error){
      await this.nativeLogin?.close();this.nativeLogin=null;
      if(!this.context)await this.startControlledBrowser();else this.mode='normal';
      throw error;
    }finally{this.closingBrowser=false;this.transitioning=false;}
  }
  async finishNativeLogin(ownerSid,internal=false){
    if(!this.nativeLogin)return;
    if(!internal&&this.nativeLogin.ownerSid!==ownerSid)throw Error('只有开启本次登录的管理员可以结束它');
    if(this.transitioning){if(internal)return;throw Error('浏览器正在切换，请稍后重试');}
    this.transitioning=true;this.mode='switching';
    try{
      await this.nativeLogin.close();this.nativeLogin=null;
      await this.startControlledBrowser();this.logger.info('native_login_finished',{profile:'persistent'});
    }catch(error){this.logger.error('native_login_finish_failed',{error});throw error;}
    finally{this.transitioning=false;}
  }
  getNativeLogin(key,ownerSid){
    if(this.mode!=='native-login'||!this.nativeLogin)throw Error('请先在管理员手动登录页点击“开始手动登录”');
    if(this.nativeLogin.ownerSid!==ownerSid||this.nativeLogin.key!==key)throw Error('手动登录画面仅对开启它的管理员标签页可见');
    return this.nativeLogin;
  }
  diagnoseNetwork(){
    this.networkDiagnosticStop?.();
    if(this.context&&this.mode==='normal')this.networkDiagnosticStop=startNetworkDiagnostic(this.context,this.logger);
  }
  async adoptPopup(page){const opener=await page.opener().catch(()=>null);const owner=this.pageOwners.get(opener);if(owner)await owner.attachPage(page);}
  requestEncoder(session){
    if(session===this.nativeLogin){if(this.mode==='native-login')session.startCapture();return;}
    if(this.mode!=='normal'||this.stopping)return;
    if(!session.clients.size||!session.page||session.page.isClosed()||session.layoutBusy||session.closing||session.minimized)return;
    const active=Math.max(1,[...this.sessions.values()].filter(s=>s.clients.size).length);
    const workers=Math.max(2,Math.floor(32/active));
    const signature=`${session.captureTitle}:${session.frameWidth}:${session.frameHeight}:${session.chromeLeft}:${session.chromeTop}:${workers}`;
    if(session.encoder?.readyState===1&&session.encoderSignature===signature)return;
    session.encoderSignature=signature;
    const capture=new NativeCapture(session,workers);session.attachEncoder(capture);
    session.streamInfo={type:'stream',transport:'rgb-qoi',width:session.frameWidth,height:session.frameHeight,fps:this.config.streamMaxFps};session.broadcast(session.streamInfo);
  }
  stopEncoder(session){session.encoder?.close();session.encoder=null;}
  async getOrCreateSession(key,role='member'){
    if(this.mode!=='normal')throw Error('管理员正在手动登录共享账号，完成后将自动重连');
    if(this.sessions.has(key))return this.sessions.get(key);
    if(this.creating.has(key))return this.creating.get(key);
    const work=(async()=>{
      await this.cleanup();
      if(this.mode!=='normal')throw Error('浏览器正在切换到管理员登录模式');
      if(this.sessions.size>=this.config.maxActiveSessions){
        const inactive=[...this.sessions.values()].filter(s=>!s.clients.size&&s.page&&!this.creating.has(s.key)).sort((a,b)=>a.lastActive-b.lastActive);
        if(inactive.length)await inactive[0].close();
      }
      if(this.sessions.size>=this.config.maxActiveSessions)throw Error('同时在线会话已达到容量限制');
      const session=new PageSession(this,key,role);this.sessions.set(key,session);this.byId.set(session.id,session);
      try{
        let page;
        if(this.bootstrap&&!this.bootstrap.isClosed()){page=this.bootstrap;this.bootstrap=null;}
        else{
          const {targetId}=await this.browserCdp.send('Target.createTarget',{url:'about:blank',newWindow:true});
          for(let retry=0;retry<50&&!page;retry++){
            for(const candidate of this.context.pages()){
              if(this.pageOwners.has(candidate))continue;
              const probe=await this.context.newCDPSession(candidate);const info=await probe.send('Target.getTargetInfo');await probe.detach();
              if(info.targetInfo.targetId===targetId){page=candidate;break;}
            }
            if(!page)await pause(20);
          }
          if(!page)throw Error('独立浏览器窗口未创建');
        }
        await session.attachPage(page);
        const saved=this.store.get(key)?.lastUrl;const url=saved&&/^https:\/\/(chatgpt\.com|auth\.openai\.com)(\/|$)/.test(saved)?saved:this.config.chatgptUrl;
        void page.goto(url,{waitUntil:'domcontentloaded'}).catch(error=>{this.logger.warn('navigation_retry',{id:session.id,error});session.retryNavigation(url);});
        return session;
      }catch(error){await session.close();throw error;}
    })();this.creating.set(key,work);try{return await work;}finally{this.creating.delete(key);}
  }
  async applyUploadedFiles(key,files,chooserId,point){const session=this.sessions.get(key);if(!session)throw Error('页面尚未连接');return session.applyUploadedFiles(files,chooserId,point);}
  async handleDownload(session,download){
    const token=crypto.randomBytes(24).toString('base64url');const destination=path.join(this.config.downloadDir,token);
    try{await download.saveAs(destination);await download.delete().catch(()=>{});this.downloads.set(token,{path:destination,filename:filename(download.suggestedFilename()),key:session.key,expires:Date.now()+this.config.downloadTtlMs});session.broadcast({type:'download',url:`/api/download/${token}`,filename:filename(download.suggestedFilename())});}
    catch(error){this.logger.warn('download_failed',{error});session.broadcast({type:'notice',message:'下载失败，请重试'});}
  }
  takeDownload(token,key){const item=this.downloads.get(token);if(!item||item.key!==key||item.expires<Date.now())return null;this.downloads.delete(token);return item;}
  async cleanup(){
    const now=Date.now();for(const session of this.sessions.values())if(!session.clients.size&&now-session.lastActive>this.config.sessionIdleMinutes*60000)await session.close();
    for(const [token,item] of this.downloads)if(item.expires<now){this.downloads.delete(token);await fsp.rm(item.path,{force:true});}
    this.logger.prune();
    for(const parent of await fsp.readdir(this.config.uploadDir,{withFileTypes:true})){
      if(!parent.isDirectory()||!/^[-a-f0-9]{24}$/.test(parent.name))continue;
      const directory=path.join(this.config.uploadDir,parent.name);
      for(const entry of await fsp.readdir(directory,{withFileTypes:true})){
        if(!entry.isDirectory()||!/^[-a-f0-9]{36}$/.test(entry.name))continue;
        const candidate=path.join(directory,entry.name),stat=await fsp.stat(candidate).catch(()=>null);
        if(stat&&now-stat.mtimeMs>30*60000)await fsp.rm(candidate,{recursive:true,force:true});
      }
      if(!(await fsp.readdir(directory)).length)await fsp.rmdir(directory).catch(()=>{});
    }
  }
  async stop(){this.stopping=true;this.networkDiagnosticStop?.();clearInterval(this.cleanupTimer);await this.nativeLogin?.close();for(const session of [...this.sessions.values()])await session.close();this.store.flush();await this.context?.close();this.windowManager?.kill();}
}

class PageSession {
  constructor(manager,key,role){
    Object.assign(this,{manager,key,role});this.id=crypto.randomUUID();this.streamKey=`gptw:${this.id}`;this.pages=[];this.clients=new Set();
    this.width=1280;this.height=800;this.dpr=1;this.frameWidth=1280;this.frameHeight=800;this.lastActive=Date.now();this.resizeQueue=Promise.resolve();this.closing=false;
    this.slot=Array.from({length:12},(_,i)=>i).find(i=>![...manager.sessions.values()].some(s=>s.slot===i));
    if(this.slot===undefined)throw Error('显示窗口容量已满');this.chromeTop=85;this.chromeLeft=0;this.chromeRight=0;this.chromeBottom=0;
  }
  broadcast(message){for(const client of this.clients)send(client,message);}
  ready(){return {type:'ready',id:this.id,role:this.role,width:this.width,height:this.height,deviceScaleFactor:this.dpr,frameWidth:this.frameWidth,frameHeight:this.frameHeight,transport:'qoi'};}
  async attachPage(page){
    if(this.page===page)return;
    await this.resizeQueue.catch(()=>{});clearTimeout(this.layoutTimer);this.layoutBusy=true;
    this.manager.stopEncoder(this);await this.cdp?.detach().catch(()=>{});
    this.page=page;this.cursor='default';this.inputStates=new Map();this.pages.push(page);this.manager.pageOwners.set(page,this);
    this.cdp=await this.manager.context.newCDPSession(page);
    const info=await this.cdp.send('Target.getTargetInfo');
    const window=await this.manager.browserCdp.send('Browser.getWindowForTarget',{targetId:info.targetInfo.targetId});
    if(this.windowId&&this.windowId!==window.windowId)await this.manager.browserCdp.send('Browser.setWindowBounds',{windowId:this.windowId,bounds:{windowState:'minimized'}}).catch(()=>{});
    this.windowId=window.windowId;
    await this.manager.browserCdp.send('Browser.setWindowBounds',{windowId:this.windowId,bounds:{windowState:'normal'}});
    await this.setWindowSize();
    await this.setPageMetrics();
    this.captureTitle=`gptw-${this.id}-${this.pages.length}`;
    const register=()=>page.evaluate(({key,title})=>{
      window.name=key;
      const update=()=>{if(!document.title.startsWith(title))document.title=`${title} | ${document.title}`;};
      update();if(document.querySelector('title'))new MutationObserver(update).observe(document.querySelector('title'),{childList:true,subtree:true,characterData:true});
    },{key:this.streamKey,title:this.captureTitle}).catch(()=>{});
    await register();page.on('domcontentloaded',()=>{void register();if(this.page===page){this.scheduleLayoutCalibration();void this.configureTouchBridge();}});
    page.on('framenavigated',frame=>{if(frame!==page.mainFrame())return;void register();if(/^https?:/.test(frame.url()))this.manager.store.update(this.key,{lastUrl:frame.url(),role:this.role});});
    page.on('download',download=>void this.manager.handleDownload(this,download));
    page.on('filechooser',async chooser=>{
      const id=crypto.randomBytes(12).toString('base64url');this.chooser={id,chooser,expires:Date.now()+120000};
      const input=chooser.element();this.broadcast({type:'filechooser',id,accept:await input.getAttribute('accept').catch(()=>''),multiple:await input.getAttribute('multiple').then(v=>v!==null).catch(()=>true)});
    });
    page.on('close',()=>void this.pageClosed(page));
    page.on('crash',()=>{this.broadcast({type:'notice',message:'页面崩溃，正在重新载入…'});void page.reload().catch(()=>{});});
    this.layoutBusy=false;
    if(!this.layoutPoll){this.layoutPoll=setInterval(()=>{if(this.clients.size&&!this.minimized&&!this.layoutBusy)this.scheduleLayoutCalibration(0);},1500);this.layoutPoll.unref();}
    if(this.clients.size){this.broadcast(this.ready());this.manager.requestEncoder(this);}
  }
  async pageClosed(page){
    this.pages=this.pages.filter(p=>p!==page);this.manager.pageOwners.delete(page);
    if(this.closing||this.manager.stopping||!this.manager.context?.browser()?.isConnected()||this.page!==page)return;
    const next=this.pages.at(-1)||await this.manager.context.newPage();this.page=null;await this.attachPage(next);
    if(!this.pages.length||next.url()==='about:blank')void next.goto(this.manager.config.chatgptUrl).catch(()=>{});
  }
  retryNavigation(url){clearTimeout(this.navigationTimer);this.navigationTimer=setTimeout(()=>{if(!this.closing&&this.clients.size)void this.page.goto(url,{waitUntil:'domcontentloaded'}).catch(()=>this.retryNavigation(url));},5000);this.navigationTimer.unref();}
  addClient(socket){
    clearTimeout(this.disconnectTimer);
    if(this.minimized){
      this.minimized=false;this.layoutBusy=true;
      this.resizeQueue=this.resizeQueue.catch(()=>{}).then(async()=>{
        try{
          if(this.closing)return;
          await this.cdp.send('Emulation.setScriptExecutionDisabled',{value:false}).catch(()=>{});
          await this.cdp.send('Page.setWebLifecycleState',{state:'active'}).catch(()=>{});
          await this.manager.browserCdp.send('Browser.setWindowBounds',{windowId:this.windowId,bounds:{windowState:'normal'}}).catch(()=>{});
        }finally{this.layoutBusy=false;if(!this.closing){this.scheduleLayoutCalibration(0);this.manager.requestEncoder(this);}}
      });
    }
    this.clients.add(socket);socket._socket?.setNoDelay(true);this.lastActive=Date.now();send(socket,this.ready());send(socket,{type:'cursor',cursor:this.cursor||'default'});if(this.streamInfo)send(socket,this.streamInfo);
    this.broadcastInputState();
    this.frameFlow?.reset();for(const session of this.manager.sessions.values())if(session.clients.size)this.manager.requestEncoder(session);
  }
  removeClient(socket){
    if(!this.clients.delete(socket))return;this.frameFlow?.remove(socket);this.lastActive=Date.now();
    if(this.closing||this.manager.stopping||this.manager.mode!=='normal')return;
    if(!this.clients.size){
      clearTimeout(this.disconnectTimer);this.disconnectTimer=setTimeout(()=>{
        if(this.clients.size||this.closing)return;
        this.manager.stopEncoder(this);this.minimized=true;
        this.resizeQueue=this.resizeQueue.catch(()=>{}).then(async()=>{
          if(this.clients.size||this.closing)return;
          await this.manager.browserCdp.send('Browser.setWindowBounds',{windowId:this.windowId,bounds:{windowState:'minimized'}}).catch(()=>{});
          if(!this.clients.size){
            await this.cdp.send('Page.setWebLifecycleState',{state:'frozen'}).catch(()=>{});
            // The automation driver keeps a synthetic foreground state for
            // independent windows. Explicitly stop script execution as well.
            await this.cdp.send('Emulation.setScriptExecutionDisabled',{value:true}).catch(()=>{});
          }
        });
      },1000);this.disconnectTimer.unref();
    }
    if(!this.manager.stopping)for(const session of this.manager.sessions.values())if(session.clients.size)this.manager.requestEncoder(session);
  }
  attachEncoder(socket){
    this.frameFlow?.clear();this.encoder?.close();this.encoder=socket;socket._socket?.setNoDelay(true);
    const flow=this.frameFlow=new FrameFlow(socket,this.clients,Math.max(64*1024*1024,this.frameWidth*this.frameHeight*4+48*1024*1024));
    socket.on('message',(packet,binary)=>{
      if(!binary||this.encoder!==socket)return;
      flow.packet(packet);
    });
    socket.on('close',()=>{flow.clear();if(this.encoder===socket)this.encoder=null;});
  }
  async handleMessage(raw,socket){
    let m;try{m=JSON.parse(String(raw));}catch{return;}this.lastActive=Date.now();
    if(m.type==='frameAck'){this.frameFlow?.ack(socket,m.sequence);return;}
    if(m.type==='frameReset'){this.frameFlow?.reset();return;}
    if(m.type==='diagnostic-ping'){send(socket,{type:'diagnostic-pong',probeId:m.probeId});return;}
    if(m.type==='diagnostic-render'){
      if(this.renderProbe||!this.page||this.page.isClosed())return;
      this.renderProbe=true;
      try{send(socket,{type:'diagnostic-render',probeId:m.probeId,render:await measureRender(this.page,m),wheelSamples:(this.wheelSamples||[]).slice(-240),frameSamples:this.frameFlow?.samples,bufferedBytes:socket.bufferedAmount,wireBytes:socket._socket?.bytesWritten,rawBytes:this.frameFlow?.rawBytes,extensions:socket.extensions});}
      catch{send(socket,{type:'diagnostic-render',probeId:m.probeId,error:'Render probe unavailable'});}
      finally{this.renderProbe=false;}
      return;
    }
    if(m.type==='viewport'){
      this.latestViewport=m;this.resizeQueue=this.resizeQueue.catch(()=>{}).then(async()=>{const next=this.latestViewport;if(next){this.latestViewport=null;await this.resize(next);}});
      try{await this.resizeQueue;}catch(error){this.manager.logger.warn('viewport_failed',{id:this.id,error});}
      return;
    }
    if(!this.page||this.page.isClosed())return;
    try{
      await this.resizeQueue.catch(()=>{});
      // Touch taps focus the remote control at touchEnd. A local software
      // keyboard may commit before that asynchronous dispatch has completed.
      if(['text','key','composition'].includes(m.type))await this.touchQueue?.catch(()=>{});
      switch(m.type){
        case 'touch':{
          if(!['touchStart','touchMove','touchEnd','touchCancel'].includes(m.eventType))break;
          if(!Array.isArray(m.points)||m.points.length>10)break;
          const touchPoints=m.points.map(p=>({id:Number(p.id),x:Number(p.x)*this.dpr,y:Number(p.y)*this.dpr}));
          if(touchPoints.some(p=>!Number.isInteger(p.id)||p.id<0||p.id>9||!Number.isFinite(p.x)||!Number.isFinite(p.y)))break;
          if(new Set(touchPoints.map(p=>p.id)).size!==touchPoints.length)break;
          if(['touchEnd','touchCancel'].includes(m.eventType)&&touchPoints.length)break;
          this.touchQueue=(this.touchQueue||Promise.resolve()).catch(()=>{}).then(()=>this.cdp.send('Input.dispatchTouchEvent',{type:m.eventType,touchPoints}));
          await this.touchQueue;
          if(m.eventType==='touchEnd'||m.eventType==='touchCancel')void this.selectionAndAnchor();
          break;
        }
        case 'touch-select':{
          const x=Number(m.x),y=Number(m.y);if(!Number.isFinite(x)||!Number.isFinite(y))break;
          this.touchQueue=(this.touchQueue||Promise.resolve()).catch(()=>{}).then(async()=>{
            if(await this.selectableAtPoint(x,y)){
              await this.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:x*this.dpr,y:y*this.dpr,button:'left',buttons:1,clickCount:2});
              void this.selectionAndAnchor();
            }
          });await this.touchQueue;break;
        }
        case 'mouse':
          if(this.touchQueue)await this.touchQueue.catch(()=>{});
          await this.cdp.send('Input.dispatchMouseEvent',{type:m.eventType,x:(Number(m.x)||0)*this.dpr,y:(Number(m.y)||0)*this.dpr,button:m.button||'none',buttons:Number(m.buttons)||0,clickCount:Number(m.clickCount)||0,modifiers:Number(m.modifiers)||0});
          if(m.eventType==='mouseReleased')void this.selectionAndAnchor();break;
        case 'wheel':{
          const at=performance.now();
          await this.cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:(Number(m.x)||0)*this.dpr,y:(Number(m.y)||0)*this.dpr,deltaX:(Number(m.deltaX)||0)*this.dpr,deltaY:(Number(m.deltaY)||0)*this.dpr,modifiers:Number(m.modifiers)||0});
          const samples=this.wheelSamples||= [];samples.push({at,dispatchMs:performance.now()-at,deltaY:Number(m.deltaY)||0});if(samples.length>240)samples.shift();break;
        }
        case 'key':{
          const text=m.eventType==='keyDown'?String(m.text||''):'';
          await this.cdp.send('Input.dispatchKeyEvent',{type:m.eventType==='keyDown'?(text?'keyDown':'rawKeyDown'):'keyUp',key:String(m.key||''),code:String(m.code||''),text,unmodifiedText:text,windowsVirtualKeyCode:Number(m.keyCode)||0,nativeVirtualKeyCode:Number(m.keyCode)||0,modifiers:Number(m.modifiers)||0,autoRepeat:Boolean(m.repeat),isKeypad:m.location===3});
          if(m.eventType==='keyUp')void this.selectionAndAnchor();break;
        }
        case 'text':
          if(typeof m.text==='string'&&m.text.length<=4000000){await this.cdp.send('Input.insertText',{text:m.text});void this.selectionAndAnchor();}break;
        case 'composition':
          await this.cdp.send('Input.imeSetComposition',{text:String(m.text||''),selectionStart:String(m.text||'').length,selectionEnd:String(m.text||'').length});break;
        case 'selection':await this.selectionAndAnchor();break;
        case 'reload':await this.page.reload({waitUntil:'domcontentloaded'});break;
        case 'back':await this.page.goBack({waitUntil:'domcontentloaded'});break;
        case 'forward':await this.page.goForward({waitUntil:'domcontentloaded'});break;
      }
    }catch(error){this.manager.logger.warn('input_failed',{type:m.type,error});}
  }
  async resize({width,height,deviceScaleFactor,touch=false}){
    const w=Math.max(320,Math.min(8192,Math.round(Number(width)||1280))),h=Math.max(128,Math.min(4320,Math.round(Number(height)||800)));
    const requestedDpr=Math.max(.5,Math.min(4,Number(deviceScaleFactor)||1));
    const dpr=Math.min(requestedDpr,this.manager.config.streamMaxWidth/w,this.manager.config.streamMaxHeight/h);
    const touchEnabled=touch===true;
    if(w===this.width&&h===this.height&&dpr===this.dpr&&touchEnabled===Boolean(this.touchEnabled))return;
    this.width=w;this.height=h;this.dpr=dpr;this.touchEnabled=touchEnabled;this.frameWidth=Math.round(w*dpr);this.frameHeight=Math.round(h*dpr);
    this.layoutBusy=true;this.manager.stopEncoder(this);
    try{await this.setWindowSize();await this.setPageMetrics();this.streamInfo=null;this.broadcast(this.ready());this.broadcastInputState();}
    finally{this.layoutBusy=false;}
    this.manager.requestEncoder(this);
    if(dpr!==requestedDpr)this.broadcast({type:'notice',message:'当前屏幕像素超过服务上限，已限制到8K范围'});
  }
  async setWindowSize(){
    const browserCdp=this.manager.browserCdp,windowId=this.windowId;
    await browserCdp.send('Browser.setWindowBounds',{windowId,bounds:{left:(this.slot%3)*8208,top:Math.floor(this.slot/3)*4500}});
    // Resize Chrome's native contents, not an emulated JS viewport. This stays
    // valid when browser UI (e.g. an infobar) appears after the initial page.
    await browserCdp.send('Browser.setContentsSize',{windowId,width:this.frameWidth,height:this.frameHeight});
    const {bounds}=await browserCdp.send('Browser.getWindowBounds',{windowId});
    const {horizontal,vertical,left,right,bottom,top}=windowInsets(bounds,this.frameWidth,this.frameHeight,this.windowHorizontalInset||0);
    this.windowHorizontalInset=horizontal;
    const changed=this.chromeLeft!==left||this.chromeRight!==right||this.chromeTop!==top||this.chromeBottom!==bottom;
    Object.assign(this,{chromeLeft:left,chromeRight:right,chromeTop:top,chromeBottom:bottom});
    if(changed)this.manager.logger.info('window_insets',{id:this.id,horizontal,vertical,left,top,bottom});
    return changed;
  }
  scheduleLayoutCalibration(delay=150){
    if(this.closing||this.manager.stopping||this.minimized)return;
    clearTimeout(this.layoutTimer);
    this.layoutTimer=setTimeout(()=>{
      this.resizeQueue=this.resizeQueue.catch(()=>{}).then(async()=>{
        if(this.closing||this.minimized||!this.page||this.page.isClosed())return;
        this.layoutBusy=true;
        try{
          if(await this.setWindowSize()){
            this.manager.stopEncoder(this);await this.setPageMetrics();this.streamInfo=null;this.broadcast(this.ready());this.broadcastInputState();
          }
        }catch(error){this.manager.logger.warn('window_calibration_failed',{id:this.id,error});}
        finally{this.layoutBusy=false;if(this.clients.size)this.manager.requestEncoder(this);}
      });
    },delay);this.layoutTimer.unref();
  }
  async setPageMetrics(){
    await this.cdp.send('Emulation.setDeviceMetricsOverride',{width:this.width,height:this.height,deviceScaleFactor:this.dpr,scale:this.dpr,dontSetVisibleSize:true,mobile:false,screenWidth:this.width,screenHeight:this.height});
    await this.cdp.send('Emulation.setTouchEmulationEnabled',{enabled:Boolean(this.touchEnabled),maxTouchPoints:10});
    await this.configureTouchBridge();
    // CDP's logical viewport and the native widget's visible extent are separate.
    // Keep the physical widget full-sized instead of clipping it to CSS pixels.
    await this.cdp.send('Emulation.setVisibleSize',{width:this.frameWidth,height:this.frameHeight});
    // CDP acknowledges geometry before the renderer has painted the new native
    // surface. Do not seed a lossless delta stream from its previous backing.
    if(!await waitForPaint(this.page))this.manager.logger.info('paint_wait_interrupted',{id:this.id});
  }
  async configureTouchBridge(){
    await Promise.all((this.page?.frames()||[]).map(frame=>frame.evaluate(enabled=>globalThis.__gptWebSetTouchInput?.(enabled),Boolean(this.touchEnabled)).catch(()=>{})));
  }
  async selectableAtPoint(x,y){
    let frame=this.page.mainFrame();
    for(let depth=0;depth<12;depth++){
      const element=await frame.evaluateHandle(({x,y})=>document.elementFromPoint(x,y),{x,y});
      const child=await element.asElement()?.contentFrame().catch(()=>null);
      if(!child){await element.dispose();break;}
      const offset=await element.evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x+e.clientLeft,y:r.y+e.clientTop};});
      await element.dispose();x-=offset.x;y-=offset.y;frame=child;
    }
    return frame.evaluate(({x,y})=>{
      const element=document.elementFromPoint(x,y);if(!element)return false;
      if(element.isContentEditable||element instanceof HTMLTextAreaElement)return !element.disabled;
      if(element instanceof HTMLInputElement)return !element.disabled&&['text','search','email','url','tel','number','password'].includes(element.type);
      if(getComputedStyle(element).userSelect==='none')return false;
      const position=document.caretPositionFromPoint?.(x,y),caret=position?null:document.caretRangeFromPoint?.(x,y);
      const node=position?.offsetNode||caret?.startContainer,offset=position?.offset??caret?.startOffset;
      if(node?.nodeType!==Node.TEXT_NODE||!node.parentElement||getComputedStyle(node.parentElement).userSelect==='none')return false;
      for(const start of [offset-1,offset]){
        if(start<0||start>=node.length)continue;
        const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+1);
        if([...range.getClientRects()].some(r=>x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom))return true;
      }
      return false;
    },{x,y});
  }
  async updateInputState(frame,value){
    if(this.closing||!Array.isArray(value?.fields)||frame.isDetached())return;
    let x=0,y=0;
    if(frame!==this.page.mainFrame()){
      const element=await frame.frameElement(),box=await element.boundingBox();await element.dispose();
      if(!box)return;x=box.x;y=box.y;
    }
    const fields=value.fields.slice(0,64).filter(f=>[f.x,f.y,f.width,f.height].every(Number.isFinite)&&f.width>0&&f.height>0)
      .map(f=>({x:f.x+x,y:f.y+y,width:f.width,height:f.height,multiline:Boolean(f.multiline),focused:Boolean(f.focused),
        inputMode:['none','text','decimal','numeric','tel','search','email','url'].includes(f.inputMode)?f.inputMode:'text',
        enterKeyHint:['enter','done','go','next','previous','search','send'].includes(f.enterKeyHint)?f.enterKeyHint:'enter'}));
    this.inputStates?.set(frame,fields);this.broadcastInputState();
  }
  broadcastInputState(){
    const frames=new Set(this.page?.frames()||[]),fields=[];
    for(const [frame,entries]of this.inputStates||[]){if(!frames.has(frame)){this.inputStates.delete(frame);continue;}fields.push(...entries);}
    this.broadcast({type:'input-state',width:this.width,height:this.height,fields:fields.slice(0,128)});
  }
  async selectionAndAnchor(){
    try{
      // The focused document may be a cross-origin iframe. Reading only the
      // main frame overwrites a genuine child selection with an empty string.
      let frame=this.page.mainFrame();
      for(let depth=0;depth<12;depth++){
        const active=await frame.evaluateHandle(()=>document.activeElement);
        const child=await active.asElement()?.contentFrame().catch(()=>null);await active.dispose();
        if(!child||child===frame||child.isDetached())break;frame=child;
      }
      const value=await frame.evaluate(()=>{
        const active=document.activeElement,selection=getSelection();let text=String(selection?.toString()||''),html='',anchor=null;
        if(active&&typeof active.value==='string'&&Number.isInteger(active.selectionStart))text=active.value.slice(active.selectionStart,active.selectionEnd);
        if(selection?.rangeCount){const range=selection.getRangeAt(0).cloneRange();if(text){const holder=document.createElement('div');holder.append(range.cloneContents());html=holder.innerHTML;}range.collapse(false);const rect=range.getClientRects()[0]||range.getBoundingClientRect();if(rect.height)anchor={x:rect.left,y:rect.bottom};}
        if(!anchor&&active?.getBoundingClientRect){const r=active.getBoundingClientRect();if(r.width&&r.height)anchor={x:r.left+8,y:r.top+Math.min(28,r.height)};}
        return {text,html,anchor};
      });
      if(value.anchor&&frame!==this.page.mainFrame()){
        const element=await frame.frameElement(),box=await element.boundingBox();await element.dispose();
        if(box){value.anchor.x+=box.x;value.anchor.y+=box.y;}
      }
      this.broadcast({type:'selection',text:value.text.slice(0,4000000),html:value.html.slice(0,4000000)});if(value.anchor)this.broadcast({type:'ime-anchor',...value.anchor});
    }catch{}
  }
  async applyUploadedFiles(files,chooserId,point={}){
    if(!files.length)throw Error('没有选中文件');const paths=files.map(f=>f.path);
    if(chooserId&&this.chooser?.id===chooserId&&this.chooser.expires>Date.now()){
      const {chooser}=this.chooser;this.chooser=null;await chooser.setFiles(paths);return 'filechooser';
    }
    const x=(Number.isFinite(Number(point.x))?Number(point.x):this.width/2)*this.dpr,y=(Number.isFinite(Number(point.y))?Number(point.y):this.height/2)*this.dpr;
    if(point.mode!=='paste'){
      const data={items:[],files:paths,dragOperationsMask:1};
      for(const type of ['dragEnter','dragOver','drop'])await this.cdp.send('Input.dispatchDragEvent',{type,x,y,data});
      return 'drop';
    }
    if(files.reduce((total,f)=>total+f.size,0)>50*1024*1024)throw Error('粘贴图片超过50MB，请直接拖入文件');
    const items=await Promise.all(files.map(async f=>({name:filename(f.originalname),type:f.mimetype,data:(await fsp.readFile(f.path)).toString('base64')})));
    await this.page.evaluate(items=>{
      const transfer=new DataTransfer();for(const item of items){const bytes=Uint8Array.from(atob(item.data),c=>c.charCodeAt(0));transfer.items.add(new File([bytes],item.name,{type:item.type}));}
      const target=document.activeElement||document.body;target.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
    },items);return 'paste';
  }
  async close(){
    if(this.closing)return;this.closing=true;clearTimeout(this.retryTimer);clearTimeout(this.navigationTimer);clearTimeout(this.disconnectTimer);clearTimeout(this.ackTimer);clearTimeout(this.layoutTimer);clearInterval(this.layoutPoll);
    this.manager.stopEncoder(this);for(const client of this.clients)client.close(1001,'Session closed');
    await this.cdp?.detach().catch(()=>{});for(const page of this.pages){this.manager.pageOwners.delete(page);await page.close().catch(()=>{});}
    this.manager.sessions.delete(this.key);this.manager.byId.delete(this.id);
  }
}
