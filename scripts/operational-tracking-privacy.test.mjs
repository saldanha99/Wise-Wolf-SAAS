import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = template.match(/<!-- Meta Pixel Code -->\s*<script>([\s\S]*?)<\/script>/)[1];
function run(href) {
  const calls = [];
  const fbq = (...args) => calls.push(args);
  runInNewContext(script, { URL, window: { location: { href }, fbq }, document: {}, fbq });
  return calls;
}
test('operational, token, OAuth, localhost and foreign-tenant pages never load the pixel', () => {
  for (const url of [
    'https://system.wisewolflanguage.com.br/',
    'https://system.wisewolflanguage.com.br/confirmar-presenca?token=fixture',
    'https://system.wisewolflanguage.com.br/confirmar-alteracao?token=fixture',
    'https://system.wisewolflanguage.com.br/transferencia?token=fixture',
    'https://system.wisewolflanguage.com.br/hub?code=fixture&state=fixture',
    'https://system.wisewolflanguage.com.br/hub#access_token=fixture',
    'http://127.0.0.1:4179/hub',
    'https://other-school.example/hub',
  ]) assert.equal(run(url).length, 0, url);
  assert.match(template, /<meta name="referrer" content="no-referrer">/);
  assert.doesNotMatch(template, /<noscript>[\s\S]*?facebook\.com/);
});
test('campaign page keeps page view for non-sensitive attribution parameters', () => {
  assert.equal(run('https://system.wisewolflanguage.com.br/hub/wolfie?utm_source=test').length, 2);
});
