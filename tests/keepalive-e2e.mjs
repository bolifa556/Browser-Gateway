// Run only in an isolated test container. No production profile or account is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';
import { BrowserManager } from '../src/browser-manager.js';

assert.equal(process.env.KEEPALIVE_TEST_ISOLATED, 'true', 'An isolated container is required');
const root = path.join(config.dataRoot, 'tmp');
await fs.mkdir(root, { recursive: true });
const directory = await fs.mkdtemp(path.join(root, 'keepalive-e2e-'));
const report = { ok: false, checks: [] }, events = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let display, server, manager;
try {
  process.env.DISPLAY = ':199';
  display = spawn('Xvfb', [':199', '-screen', '0', '10000x5000x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await fs.stat('/tmp/.X11-unix/X199').catch(() => null)) break;
    await pause(50);
  }
  server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'keepalive_probe=profile-retained; Path=/; Max-Age=3600; SameSite=Lax',
    });
    response.end('<!doctype html><meta charset="utf-8"><style>body{margin:0}#input{width:200px;height:80px}</style><div id="input" contenteditable></div><script>window.touches=0;document.addEventListener("touchstart",()=>window.touches++);</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  const testConfig = {
    ...config, dataRoot: directory, profileDir: path.join(directory, 'profile'),
    uploadDir: path.join(directory, 'uploads'), downloadDir: path.join(directory, 'downloads'),
    upstreamProxy: '', chatgptUrl: origin, sessionIdleMinutes: 120,
  };
  const saved = new Map();
  const store = { get: key => saved.get(key), update: (key, value) => saved.set(key, value), flush() {} };
  const logger = { info: event => events.push(event), warn: event => events.push(event), error: event => events.push(event), prune() {} };
  manager = new BrowserManager(testConfig, store, logger);
  await manager.start();

  async function keepaliveStatus() {
    assert.ok(manager.keepalive);
    const { targetInfo } = await manager.browserCdp.send('Target.getTargetInfo', { targetId: manager.keepalive.targetId });
    const { bounds } = await manager.browserCdp.send('Browser.getWindowBounds', { windowId: manager.keepalive.windowId });
    assert.equal(targetInfo.url, 'about:blank');
    assert.equal(bounds.windowState, 'minimized');
    assert.ok(![...manager.sessions.values()].some(session => session.windowId === manager.keepalive.windowId));
  }
  async function member(key) {
    const session = await manager.getOrCreateSession(key);
    await session.page.locator('#input').waitFor();
    assert.notEqual(session.windowId, manager.keepalive.windowId);
    return session;
  }
  await keepaliveStatus();
  report.checks.push('separate-minimized-blank-window');
  const first = await member('member:first'), second = await member('member:second');
  assert.notEqual(first.windowId, second.windowId);
  assert.equal(manager.sessions.size, 2);
  assert.equal(manager.pageOwners.size, 2);
  assert.equal(manager.context.pages().length, 3);
  report.checks.push('independent-member-windows-and-no-keepalive-member-slot');

  await first.resize({ width: 1920, height: 1080, deviceScaleFactor: 2 });
  assert.equal(first.frameWidth, 3840);assert.equal(first.frameHeight, 2160);
  await first.page.locator('#input').click();
  await first.handleMessage(JSON.stringify({ type: 'text', text: 'desktop-中文' }), {});
  assert.equal(await first.page.locator('#input').textContent(), 'desktop-中文');
  await second.resize({ width: 390, height: 844, deviceScaleFactor: 3, touch: true });
  assert.equal(second.frameWidth, 1170);assert.equal(second.frameHeight, 2532);
  await second.handleMessage(JSON.stringify({ type: 'touch', eventType: 'touchStart', points: [{ id: 0, x: 40, y: 40 }] }), {});
  await second.handleMessage(JSON.stringify({ type: 'touch', eventType: 'touchEnd', points: [] }), {});
  assert.ok(await second.page.evaluate(() => window.touches) >= 1);
  assert.equal(first.frameWidth, 3840);
  report.checks.push('desktop-4K-text-and-independent-mobile-touch');

  const browser = manager.context.browser(), originalKeepalive = manager.keepalive.targetId;
  for (const session of manager.sessions.values()) session.lastActive = Date.now() - 121 * 60_000;
  await manager.cleanup();
  await pause(1500);
  assert.equal(manager.sessions.size, 0);
  assert.equal(manager.pageOwners.size, 0);
  assert.equal(manager.context.pages().length, 1);
  assert.equal(manager.keepalive.targetId, originalKeepalive);
  assert.equal(browser.isConnected(), true);
  assert.equal(events.includes('browser_closed'), false);
  await keepaliveStatus();
  report.checks.push('last-idle-member-cleaned-without-browser-exit');

  const returned = await member('member:return');
  assert.equal(manager.sessions.size, 1);
  assert.ok((await manager.context.cookies(origin)).some(cookie => cookie.name === 'keepalive_probe'));
  await returned.page.locator('#input').click();
  await returned.handleMessage(JSON.stringify({ type: 'text', text: 'returned-session' }), {});
  assert.equal(await returned.page.locator('#input').textContent(), 'returned-session');
  report.checks.push('new-member-after-idle-uses-original-profile-and-browser');

  await manager.startNativeLogin('admin:diagnostic', 'diagnostic-owner', { width: 1280, height: 800, deviceScaleFactor: 1 });
  assert.equal(manager.mode, 'native-login');assert.equal(manager.keepalive, null);
  await manager.finishNativeLogin('diagnostic-owner');
  assert.equal(manager.mode, 'normal');await keepaliveStatus();
  await member('member:after-login');
  assert.ok((await manager.context.cookies(origin)).some(cookie => cookie.name === 'keepalive_probe'));
  assert.equal(events.filter(event => event === 'browser_keepalive_ready').length, 2);
  assert.equal(events.includes('browser_closed'), false);
  assert.equal(events.includes('input_failed'), false);
  report.checks.push('native-login-mode-switch-retains-cookies-and-recreates-keepalive');
  report.ok = true;
} catch (error) {
  report.error = error.stack;process.exitCode = 1;
} finally {
  await manager?.stop().catch(() => {});
  server?.close();display?.kill();
  const resolved = path.resolve(directory);
  if (resolved.startsWith(`${root}/keepalive-e2e-`)) await fs.rm(resolved, { recursive: true, force: true });
  const results = path.join(config.dataRoot, 'check-results/1.4.2');
  await fs.mkdir(results, { recursive: true });
  await fs.writeFile(path.join(results, 'keepalive-e2e.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
