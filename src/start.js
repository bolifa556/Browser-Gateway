import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {config} from './config.js';
// flock --no-fork holds the only service/profile lock throughout Node's lifetime.
for(const name of ['home','tmp','cache','config'])await fs.mkdir(`${config.dataRoot}/${name}`,{recursive:true,mode:0o700});
await fs.mkdir('/tmp/.X11-unix',{recursive:true});
for(const stale of ['/tmp/.X99-lock','/tmp/.X11-unix/X99'])await fs.rm(stale,{force:true});
process.env.DISPLAY=':99';
await fs.mkdir(`${config.dataRoot}/logs`,{recursive:true,mode:0o700});
const displayLog=await fs.open(`${config.dataRoot}/logs/xvfb.log`,'a',0o600);
const display=spawn('Xvfb',[':99','-screen','0','24624x18000x24','-nolisten','tcp','-noreset'],{stdio:['ignore',displayLog.fd,displayLog.fd]});
await displayLog.close();
display.on('error',()=>process.exit(1));
display.on('exit',()=>process.exit(1));
let available=false;
for(let i=0;i<100;i++){if(await fs.stat('/tmp/.X11-unix/X99').catch(()=>null)){available=true;break;}await new Promise(r=>setTimeout(r,50));}
if(!available)throw Error('Xvfb startup failed');
await import('./server.js');
