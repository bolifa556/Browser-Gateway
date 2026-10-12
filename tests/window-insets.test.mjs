import {test} from 'node:test';
import assert from 'node:assert/strict';
import {windowInsets} from '../src/window-insets.js';
test('desktop and HiDPI native window insets retain their original mapping',()=>{
  assert.deepEqual(windowInsets({width:3840,height:2245},3840,2160),{horizontal:0,vertical:85,left:0,right:0,top:85,bottom:0});
  assert.deepEqual(windowInsets({width:1932,height:1177},1920,1080),{horizontal:12,vertical:97,left:6,right:6,top:91,bottom:6});
});
test('minimum-width clamping is content space, not 55-pixel Chrome borders',()=>{
  assert.deepEqual(windowInsets({width:500,height:929},390,844),{horizontal:0,vertical:85,left:0,right:0,top:85,bottom:0});
  assert.equal(windowInsets({width:500,height:929},390,844,12).left,6);
});
