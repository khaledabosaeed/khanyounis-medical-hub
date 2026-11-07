import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import vm from 'node:vm';
import express from 'express';
import { buildPublicSite } from '../scripts/build.js';
import { createStaticMiddleware } from '../server/static.js';

const publicSource = resolve(new URL('../public', import.meta.url).pathname);

function temporaryDirectory(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'studyhub-frontend-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('production HTML loads content-versioned JS and CSS, with a new URL when content changes', (t) => {
  const directory = temporaryDirectory(t);
  const output = resolve(directory, 'output');
  const assets = buildPublicSite({ source: publicSource, output });
  const html = readFileSync(resolve(output, 'index.html'), 'utf8');
  for (const [original, versioned] of Object.entries(assets)) {
    assert.match(versioned, /\.[a-f0-9]{16}\.(?:js|css)$/);
    assert.ok(html.includes(`"/${versioned}"`));
    assert.ok(!html.includes(`"/${original}"`));
    assert.ok(existsSync(resolve(output, versioned)));
    assert.deepEqual(readFileSync(resolve(output, versioned)), readFileSync(resolve(publicSource, original)));
  }

  const modifiedSource = resolve(directory, 'modified-source');
  buildPublicSite({ source: publicSource, output: modifiedSource });
  writeFileSync(resolve(modifiedSource, 'index.html'), readFileSync(resolve(publicSource, 'index.html')));
  writeFileSync(resolve(modifiedSource, 'app.js'), `${readFileSync(resolve(publicSource, 'app.js'), 'utf8')}\n// Different release\n`);
  const changed = buildPublicSite({ source: modifiedSource, output });
  assert.notEqual(changed['app.js'], assets['app.js']);
  assert.equal(changed['hub-app.css'], assets['hub-app.css']);
  assert.ok(readFileSync(resolve(output, 'index.html'), 'utf8').includes(`"/${changed['app.js']}"`));
});

test('unversioned frontend files do not cache while content-versioned files are cacheable', async (t) => {
  const output = resolve(temporaryDirectory(t), 'output');
  const assets = buildPublicSite({ source: publicSource, output });
  const app = express();
  app.use(createStaticMiddleware(output));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [original, versioned] of Object.entries(assets)) {
    const stable = await fetch(`${origin}/${original}`);
    assert.equal(stable.status, 200);
    assert.match(stable.headers.get('cache-control'), /no-store/);
    const hashed = await fetch(`${origin}/${versioned}`);
    assert.equal(hashed.status, 200);
    assert.match(hashed.headers.get('cache-control'), /immutable/);
    assert.equal(await hashed.text(), readFileSync(resolve(publicSource, original), 'utf8'));
  }
});

test('current frontend initializes against the actual HTML and wires signup, login and owner form events', () => {
  const html = readFileSync(resolve(publicSource, 'index.html'), 'utf8');
  const nodes = new Map();
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const classes = new Set((match[0].match(/class="([^"]*)"/)?.[1] || '').split(/\s+/));
    const handlers = new Map();
    nodes.set(match[1], {
      handlers,
      classList: {
        contains(value) { return classes.has(value); },
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
      },
      addEventListener(event, callback) { handlers.set(event, callback); },
      focus() {}, textContent: '',
    });
  }
  const location = { pathname: '/', hash: '', search: '' };
  const context = {
    document: { querySelector(selector) { return nodes.get(selector.slice(1)) || null; }, querySelectorAll() { return []; } },
    window: { addEventListener() {}, scrollTo() {} }, location,
    history: { replaceState(_state, _title, target) { const url = new URL(target, 'https://hub.example'); location.pathname = url.pathname; location.hash = url.hash; } },
    fetch() { return new Promise(() => {}); }, clearInterval() {},
  };
  assert.doesNotThrow(() => vm.runInNewContext(readFileSync(resolve(publicSource, 'app.js'), 'utf8'), context));
  assert.ok(nodes.get('admin-login-form').handlers.has('submit'));
  assert.ok(nodes.get('login-form').handlers.has('submit'));
  assert.ok(nodes.get('signup-form').handlers.has('submit'));
  const event = { preventDefault() {} };
  nodes.get('show-signup').handlers.get('click')(event);
  assert.equal(nodes.get('signup-view').classList.contains('hub-hidden'), false);
  assert.equal(nodes.get('login-view').classList.contains('hub-hidden'), true);
  nodes.get('show-login').handlers.get('click')(event);
  assert.equal(nodes.get('login-view').classList.contains('hub-hidden'), false);
  assert.equal(nodes.get('signup-view').classList.contains('hub-hidden'), true);
});
