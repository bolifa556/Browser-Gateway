import fs from 'node:fs';
const wasm=(await WebAssembly.instantiate(fs.readFileSync(new URL('../public/qoi.wasm',import.meta.url)),{})).instance.exports;
const required=wasm.configure(3840,2160);if(required>wasm.memory.buffer.byteLength)wasm.memory.grow(Math.ceil((required-wasm.memory.buffer.byteLength)/65536));
new Uint8Array(wasm.memory.buffer,wasm.input_pointer(),3840*2160*4).fill(255);
let samples=[];for(let n=0;n<30;n++){const at=performance.now();wasm.encode_frame(1,n+1);samples.push(performance.now()-at);}
samples=samples.slice(5).sort((a,b)=>a-b);console.log(JSON.stringify({stage:'4k-full-lossless-encode',medianMs:samples[Math.floor(samples.length/2)],p95Ms:samples[Math.floor(samples.length*.95)]}));
samples=[];for(let n=0;n<100;n++){const at=performance.now();wasm.encode_frame(0,n+31);samples.push(performance.now()-at);}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({stage:'4k-damage-detection',medianMs:samples[50],p95Ms:samples[95]}));
