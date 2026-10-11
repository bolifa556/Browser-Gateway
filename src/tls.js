import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

export class CertificateManager {
  constructor(config,logger){Object.assign(this,{config,logger});this.directory=path.join(config.dataRoot,'tls');this.acme=path.join(config.dataRoot,'acme');this.webroot=path.join(config.dataRoot,'acme-webroot');this.ready=false;this.running=false;}
  async load(){
    if(!this.config.publicHost)return false;
    try{
      const [key,cert]=await Promise.all(['key.pem','fullchain.pem'].map(f=>fs.readFile(path.join(this.directory,f))));
      const leaf=new crypto.X509Certificate(cert);
      if(Date.parse(leaf.validTo)<=Date.now()||!(net.isIP(this.config.publicHost)?leaf.checkIP(this.config.publicHost):leaf.checkHost(this.config.publicHost)))return false;
      this.options={key,cert,minVersion:'TLSv1.2'};this.expires=Date.parse(leaf.validTo);this.ready=true;this.onchange?.(this.options);return true;
    }catch{return false;}
  }
  async start(){
    if(!this.config.publicHost)return;
    if(!/^[a-zA-Z0-9.-]+$/.test(this.config.publicHost))throw Error('Invalid PUBLIC_HOST');
    for(const directory of [this.directory,this.acme,path.join(this.webroot,'.well-known/acme-challenge')])await fs.mkdir(directory,{recursive:true,mode:0o700});
    await this.load();
    if(!this.config.acmeEnabled)return;
    this.challenge=http.createServer(async(req,res)=>{
      const name=new URL(req.url,'http://localhost').pathname.match(/^\/\.well-known\/acme-challenge\/([a-zA-Z0-9_-]{10,256})$/)?.[1];
      if(!name){res.writeHead(404);res.end();return;}
      try{const content=await fs.readFile(path.join(this.webroot,'.well-known/acme-challenge',name));res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end(content);}catch{res.writeHead(404);res.end();}
    });
    await new Promise((resolve,reject)=>{this.challenge.once('error',reject);this.challenge.listen(this.config.challengePort,'0.0.0.0',resolve);});
    this.timer=setInterval(()=>void this.renew(),3600000);this.timer.unref();
    if(!this.ready)void this.renew();
  }
  async renew(){
    if(this.running||!this.config.acmeEnabled||this.expires-Date.now()>72*3600000)return;
    this.running=true;
    const common=['--home',this.acme,'--config-home',this.acme,'--cert-home',this.acme,'--log',path.join(this.config.logDir,'acme.log')];
    const options={env:{...process.env,LE_WORKING_DIR:this.acme,HOME:path.join(this.config.dataRoot,'home')},timeout:240000,maxBuffer:1024*1024};
    try{
      try{await execute('/bin/sh',['/app/vendor/acme.sh','--issue','--server','letsencrypt','-d',this.config.publicHost,'--certificate-profile','shortlived','--days','3','--keylength','ec-256','--webroot',this.webroot,...common],options);}catch(error){if(error.code!==2)throw error;}
      await execute('/bin/sh',['/app/vendor/acme.sh','--install-cert','-d',this.config.publicHost,'--ecc','--key-file',path.join(this.directory,'key.pem'),'--fullchain-file',path.join(this.directory,'fullchain.pem'),...common],options);
      await fs.chmod(path.join(this.directory,'key.pem'),0o600);
      if(!await this.load())throw Error('Certificate is not valid');
      this.logger.info('tls_certificate_ready',{expires:new Date(this.expires).toISOString()});
    }catch(error){this.logger.warn('tls_renew_failed',{code:error.code,detail:String(error.stderr||error.message).slice(-400)});}finally{this.running=false;}
  }
  async stop(){clearInterval(this.timer);if(this.challenge)await new Promise(resolve=>this.challenge.close(resolve));}
}

export function createGateway(app,certificates,config){
  const plain=http.createServer(app),secure=https.createServer(certificates.options||{},app);
  certificates.onchange=options=>secure.setSecureContext(options);
  const sockets=new Set(),peers=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.setNoDelay(true);socket.setTimeout(15000,()=>socket.destroy());
    socket.once('data',first=>{
      socket.pause();socket.setTimeout(0);
      if(first[0]===22){
        if(!certificates.ready||!secure.listening){socket.destroy();return;}
        // TLS must receive an intact stream through its native listener. Feeding
        // an already-read socket into HTTPS's connection event loses ClientHello
        // bytes on newer Node versions. The private loopback listener is never
        // published by Docker; HTTP keeps its direct, zero-extra-hop path.
        const peer=net.connect({host:'127.0.0.1',port:secure.address().port});peers.add(peer);peer.setNoDelay(true);
        peer.on('close',()=>{peers.delete(peer);socket.destroy();});peer.on('error',()=>socket.destroy());socket.on('error',()=>peer.destroy());socket.once('close',()=>peer.destroy());
        peer.once('connect',()=>{peer.write(first);socket.pipe(peer);peer.pipe(socket);socket.resume();});
      }else{socket.unshift(first);plain.emit('connection',socket);socket.resume();}
    });
  });
  return {server,plain,secure,start:()=>new Promise((resolve,reject)=>{secure.once('error',reject);secure.listen(0,'127.0.0.1',resolve);}),close:async()=>{for(const socket of sockets)socket.destroy();for(const peer of peers)peer.destroy();plain.closeAllConnections();secure.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));if(secure.listening)await new Promise(resolve=>secure.close(resolve));}};
}
