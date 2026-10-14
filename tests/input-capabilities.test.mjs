import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputCapabilities } from '../public/input-capabilities.js';

function environment(maxTouchPoints, coarse) {
  return { navigator: { maxTouchPoints }, matchMedia(query) {
    assert.equal(query, '(pointer:coarse)');
    return { matches: coarse };
  } };
}

test('mouse-only desktop keeps the native hover mode', () => {
  assert.deepEqual(inputCapabilities(environment(0, false)), { touch: false, touchPrimary: false });
});

test('a touchscreen with a primary mouse preserves hover and touch input', () => {
  assert.deepEqual(inputCapabilities(environment(10, false)), { touch: true, touchPrimary: false });
});

test('phone and tablet keep touch-primary mode', () => {
  for (const points of [1, 5, 10]) assert.deepEqual(inputCapabilities(environment(points, true)), { touch: true, touchPrimary: true });
});

test('primary-pointer changes are read on every viewport update', () => {
  let coarse = true;
  const device = { navigator: { maxTouchPoints: 10 }, matchMedia: () => ({ matches: coarse }) };
  assert.equal(inputCapabilities(device).touchPrimary, true);
  coarse = false;
  assert.deepEqual(inputCapabilities(device), { touch: true, touchPrimary: false });
  coarse = true;
  assert.equal(inputCapabilities(device).touchPrimary, true);
});

test('a coarse pointer without touchscreen support does not enable touch emulation', () => {
  assert.deepEqual(inputCapabilities(environment(0, true)), { touch: false, touchPrimary: false });
});
