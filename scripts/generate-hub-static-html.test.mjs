import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  renderDedicatedHubMarketingHtml,
  renderHubMarketingHtml,
} from './generate-hub-static-html.mjs';

const template = `<!doctype html>
<html>
  <head>
    <title>Template</title>
    <!-- Meta Pixel Code -->
    <script>window.fbq = function fbq() {}; fbq('track', 'PageView');</script>
    <!-- End Meta Pixel Code -->
  </head>
  <body>
    <!-- Meta Pixel (noscript): fallback -->
    <noscript><img src="https://www.facebook.com/tr?id=fixture" /></noscript>
    <div id="root"></div>
  </body>
</html>`;

const metadata = {
  segment: '',
  title: 'Wise Wolf Hub',
  description: 'Hub fixture',
  imagePath: '/hub.webp',
  imageAlt: 'Hub fixture',
};

test('dedicated Hub static shell omits Meta Pixel before consent', () => {
  const html = renderDedicatedHubMarketingHtml(template, metadata);

  assert.doesNotMatch(html, /\bfbq\b/i);
  assert.doesNotMatch(html, /Meta Pixel/i);
  assert.doesNotMatch(html, /facebook\.com\/tr/i);
});

test('system-host Hub mirror preserves the existing Pixel', () => {
  const html = renderHubMarketingHtml(template, metadata);

  assert.match(html, /\bfbq\b/i);
  assert.match(html, /facebook\.com\/tr/i);
});

test('nginx serves legal documents on the system mirror and dedicated Hub', async () => {
  const nginxConfig = await readFile(
    new URL('../deploy/vps/proxy/nginx-spa.conf', import.meta.url),
    'utf8',
  );

  assert.match(
    nginxConfig,
    /location ~ \^\/hub\/\([^\n)]*termos[^\n)]*privacidade[^\n)]*\)\/\?\$ \{/,
  );
  assert.match(
    nginxConfig,
    /location ~ \^\/\([^\n)]*termos[^\n)]*privacidade[^\n)]*\)\/\?\$ \{/,
  );
});

test('nginx serves every generated PWA runtime dependency on the dedicated Hub', async () => {
  const nginxConfig = await readFile(
    new URL('../deploy/vps/proxy/nginx-spa.conf', import.meta.url),
    'utf8',
  );

  const pwaRuntimeLocations = nginxConfig.match(
    /location ~ \^\/\(pwa-critical-refresh-\[A-Za-z0-9\._-\]\+\\\.js\|workbox-\[A-Za-z0-9\._-\]\+\\\.js\)\$ \{/g,
  ) ?? [];
  assert.equal(pwaRuntimeLocations.length, 2);
});

test('nginx serves Hub captions as WebVTT on both hosts', async () => {
  const nginxConfig = await readFile(
    new URL('../deploy/vps/proxy/nginx-spa.conf', import.meta.url),
    'utf8',
  );

  const captionLocations = nginxConfig.match(
    /location ~ \^\/assets\/hub\/videos\/captions\/\[A-Za-z0-9\._-\]\+\\\.vtt\$ \{[\s\S]*?default_type text\/vtt;/g,
  ) ?? [];
  assert.equal(captionLocations.length, 2);
});

test('nginx serves the PWA manifest with its standard media type on both hosts', async () => {
  const nginxConfig = await readFile(
    new URL('../deploy/vps/proxy/nginx-spa.conf', import.meta.url),
    'utf8',
  );

  const manifestLocations = nginxConfig.match(
    /location = \/manifest\.webmanifest \{[\s\S]*?default_type application\/manifest\+json;/g,
  ) ?? [];
  assert.equal(manifestLocations.length, 2);
});

test('PWA precache excludes document marks blocked by the dedicated Hub', async () => {
  const viteConfig = await readFile(
    new URL('../vite.config.ts', import.meta.url),
    'utf8',
  );

  const globIgnores = viteConfig.match(/globIgnores:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  assert.match(globIgnores, /['"]wise-wolf-signature\.png['"]/);
  assert.match(globIgnores, /['"]director-signature\.png['"]/);
  assert.match(globIgnores, /['"]digital-stamp\.png['"]/);
});
