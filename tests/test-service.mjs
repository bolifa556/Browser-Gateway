// Run only with a separate DATA_ROOT/profile; never point this at production data.
import { spawn } from 'node:child_process';
const fixtures={mobile:'mobile-fixture',desktop:'fixture',pointer:'pointer-fixture',window:'window-fixture'};
const name=fixtures[process.env.TEST_FIXTURE||'desktop'];if(!name)throw Error('Unsupported test fixture');
const fixture = spawn(process.execPath,[`tests/${name}.mjs`],{stdio:'inherit'});
const service = spawn('flock',['--no-fork','-n',`${process.env.DATA_ROOT}/.service.lock`,process.execPath,'src/start.js'],{stdio:'inherit'});
let stopping = false;
const stop = signal => { if(stopping)return;stopping=true;service.kill(signal);fixture.kill(signal); };
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>stop(signal));
for(const child of [fixture,service])child.on('exit',code=>{if(!stopping)stop('SIGTERM');if(code&&!stopping)process.exitCode=code;});
