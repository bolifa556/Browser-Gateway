import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('all entry pages use the local ChatGPT favicon', async () => {
  for (const page of ['index.html', 'admin-login.html', 'native-login.html']) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" sizes="any" href="\/assets\/favicon\.svg\?v=1\.3\.9">/);
  }
});

test('official vector favicon keeps its color-scheme behavior and no active content', async () => {
  const svg = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8');
  assert.match(svg, /viewBox="0 0 180 180"/);
  assert.match(svg, /prefers-color-scheme: dark/);
  assert.match(svg, /fill: #000;/);
  assert.match(svg, /fill: #fff;/);
  assert.doesNotMatch(svg, /<script\b|<foreignObject\b|\bon\w+=|\bhref=/i);
});
