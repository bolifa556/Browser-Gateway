import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForPaint} from '../src/paint-ready.js';

test('paint readiness retries a context replaced by navigation',async()=>{
  let calls=0,loads=0;const page={isClosed:()=>false,waitForLoadState:async()=>{loads++},evaluate:async()=>{
    if(!calls++)throw Error('Execution context was destroyed, most likely because of a navigation');return true;
  }};
  assert.equal(await waitForPaint(page),true);assert.equal(calls,2);assert.equal(loads,1);
});
test('repeated navigation and a throttled rendering clock have a bounded wait',async()=>{
  let calls=0;assert.equal(await waitForPaint({isClosed:()=>false,waitForLoadState:async()=>{},evaluate:async()=>{
    calls++;throw Error('Execution context was destroyed');
  }}),false);assert.equal(calls,3);
  assert.equal(await waitForPaint({isClosed:()=>false,evaluate:async()=>false}),false);
});
test('a real closed-page error is not hidden',async()=>{
  await assert.rejects(waitForPaint({isClosed:()=>true,evaluate:async()=>{throw Error('Target closed')}}),/Target closed/);
});
