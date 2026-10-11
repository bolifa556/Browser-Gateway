import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {classifyVerificationRequest,startNetworkDiagnostic} from '../src/network-diagnostic.js';

const request=(url='https://brunhild.challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/flow/ov1/private-token?secret=private-query')=>({url:()=>url,resourceType:()=> 'fetch',method:()=> 'POST',failure:()=>({errorText:`net::ERR_CONNECTION_CLOSED at ${url}`})});
test('diagnostics include validation subdomains and exclude secret material and unrelated hosts',async()=>{
  const context=new EventEmitter(),events=[];
  const stop=startNetworkDiagnostic(context,{info:(event,value)=>events.push({event,...value})});
  const req=request();
  assert.deepEqual(classifyVerificationRequest(req),{host:'brunhild.challenges.cloudflare.com',stage:'flow',resource:'fetch',method:'POST'});
  const replies=new Promise(resolve=>context.once('response',()=>setImmediate(resolve)));
  context.emit('response',{request:()=>req,status:()=>403,allHeaders:async()=>({date:new Date().toUTCString(),'cf-mitigated':'challenge','set-cookie':'private-cookie',authorization:'private-password'})});
  await replies;
  context.emit('requestfailed',req);
  context.emit('requestfailed',request('https://unrelated.invalid/private-account'));
  context.emit('console',{text:()=> '[Cloudflare Turnstile] Error code: 110600 private-token'});
  stop();stop();
  assert.equal(context.listenerCount('response'),0);assert.equal(context.listenerCount('requestfailed'),0);assert.equal(context.listenerCount('console'),0);
  assert.equal(events.filter(e=>e.event==='verification_response').length,1);
  assert.equal(events.find(e=>e.event==='verification_response').status,403);
  assert.equal(events.find(e=>e.event==='verification_request_failed').code,'net::ERR_CONNECTION_CLOSED');
  assert.equal(events.find(e=>e.event==='verification_console_code').code,'110600');
  assert.ok(!/private|secret|unrelated/.test(JSON.stringify(events)));
  assert.equal(events.filter(e=>e.event==='verification_diagnostic_finished').length,1);
});
