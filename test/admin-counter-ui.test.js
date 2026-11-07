import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadInterface() {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const nodes = new Map();
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const classes = new Set((match[0].match(/class="([^"]*)"/)?.[1] || '').split(/\s+/));
    const handlers = new Map();
    nodes.set(match[1], {
      handlers, textContent: '', disabled: false,
      classList: { contains(value) { return classes.has(value); }, add(value) { classes.add(value); }, remove(value) { classes.delete(value); },
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); } },
      addEventListener(event, callback) { handlers.set(event, callback); }, focus() {},
    });
  }
  const requests = [];
  let resolveReset;
  const window = { addEventListener() {}, scrollTo() {}, confirm() { return false; } };
  const context = {
    document: { querySelector(selector) { return nodes.get(selector.slice(1)) || null; }, querySelectorAll() { return []; } },
    window, location: { pathname: '/', hash: '', search: '' }, clearInterval() {},
    fetch(url, options) {
      if (url !== '/api/admin/study-counter/reset') return new Promise(() => {});
      requests.push({ url, options });
      return new Promise(resolve => { resolveReset = resolve; });
    },
  };
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // Expose internal helpers in this isolated VM only; production files stay unchanged.
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'window.counterTest = { state, renderAdminCounter }; })();'), context);
  window.counterTest.state.sessionCsrf = 'test-session-csrf';
  return { nodes, window, requests, click: nodes.get('admin-reset-total').handlers.get('click'),
    respond(body, ok = true) { resolveReset({ ok, status: ok ? 200 : 500, async json() { return body; } }); } };
}

test('reset UI confirms, submits once with CSRF, displays zero, and ignores an older overview snapshot', async () => {
  const fixture = loadInterface();
  const { nodes, window, requests, click } = fixture;
  window.counterTest.renderAdminCounter({ totalSeconds: 7200, activeSessionCount: 2, counterVersion: 0 });
  await click();
  assert.equal(requests.length, 0, 'canceling the confirmation makes no request');
  assert.equal(nodes.get('admin-total-time').textContent, '02:00:00');
  window.confirm = () => true;
  const pending = click();
  assert.equal(nodes.get('admin-reset-total').disabled, true);
  await click();
  assert.equal(requests.length, 1, 'a second click cannot reset again while a request is pending');
  assert.equal(requests[0].options.headers['X-CSRF-Token'] || requests[0].options.headers['x-csrf-token'], 'test-session-csrf');
  assert.equal(JSON.parse(requests[0].options.body).confirmed, true);
  fixture.respond({ totalSeconds: 0, activeSessionCount: 2, counterVersion: 1, counterResetAt: '2026-10-19T12:00:00.000Z' });
  await pending;
  assert.equal(nodes.get('admin-total-time').textContent, '00:00:00');
  assert.match(nodes.get('admin-total-period').textContent, /منذ آخر تصفير/);
  assert.equal(nodes.get('admin-reset-total').disabled, false);
  window.counterTest.renderAdminCounter({ totalSeconds: 7200, activeSessionCount: 2, counterVersion: 0 });
  assert.equal(nodes.get('admin-total-time').textContent, '00:00:00', 'a response started before reset must not restore old totals');
  window.counterTest.renderAdminCounter({ totalSeconds: 10, activeSessionCount: 2, counterVersion: 1, counterResetAt: '2026-10-19T12:00:00.000Z' });
  assert.equal(nodes.get('admin-total-time').textContent, '00:00:10');
});

test('a failed reset does not change the current total or baseline and re-enables the button', async () => {
  const fixture = loadInterface();
  fixture.window.counterTest.renderAdminCounter({ totalSeconds: 1800, activeSessionCount: 0, counterVersion: 3 });
  fixture.window.confirm = () => true;
  const pending = fixture.click();
  fixture.respond({ error: 'تعذر حفظ التصفير.' }, false);
  await pending;
  assert.equal(fixture.nodes.get('admin-total-time').textContent, '00:30:00');
  assert.equal(fixture.window.counterTest.state.adminCounterVersion, 3);
  assert.equal(fixture.nodes.get('admin-reset-total').disabled, false);
  assert.match(fixture.nodes.get('admin-status').textContent, /تعذر/);
});
