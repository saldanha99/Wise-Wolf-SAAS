import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = path.join(ROOT, 'public/pwa-critical-refresh-20260824.js');
const VITE_CONFIG_PATH = path.join(ROOT, 'vite.config.ts');

test('critical refresh activation resolves without navigating controlled clients', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  const listeners = new Map();
  const markers = new Set();
  let claims = 0;
  let activation;

  class TestRequest {
    constructor(url) {
      this.url = url;
    }
  }

  class TestResponse {
    constructor(body) {
      this.body = body;
    }
  }

  const context = {
    Request: TestRequest,
    Response: TestResponse,
    caches: {
      open: async () => ({
        match: async (request) => markers.has(request.url),
        put: async (request) => {
          markers.add(request.url);
        },
      }),
    },
    self: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      clients: {
        claim: async () => {
          claims += 1;
        },
      },
    },
  };

  vm.runInNewContext(source, context, { filename: SCRIPT_PATH });
  listeners.get('activate')?.({
    waitUntil: (promise) => {
      activation = promise;
    },
  });

  assert.equal(typeof activation?.then, 'function');
  await Promise.race([
    activation,
    new Promise((_, reject) => setTimeout(() => reject(new Error('activate timeout')), 250)),
  ]);
  assert.equal(claims, 1);
  assert.deepEqual([...markers], ['/.well-known/profile-privacy-20260824']);
  assert.doesNotMatch(source, /\.navigate\s*\(/);
  assert.doesNotMatch(source, /clients\.matchAll\s*\(/);
});

test('service worker import URL is bumped after the activation repair', async () => {
  const config = await readFile(VITE_CONFIG_PATH, 'utf8');
  assert.match(config, /pwa-critical-refresh-20260824\.js\?v=3/);
  assert.doesNotMatch(config, /pwa-critical-refresh-20260824\.js\?v=2/);
});
