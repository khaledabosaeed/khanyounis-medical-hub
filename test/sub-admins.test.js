import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

process.env.MANUS_PROJECT_ID = 'khanyonis-sub-admin-test';
process.env.MANUS_JWT_SECRET = 'test-only-sub-admin-signing-key';

const security = await import('../server/security.js');
const { createCsrfRouter, requirePublicCsrf, requireSessionCsrf } = await import('../server/auth/csrf.js');
const { createAdminRouter } = await import('../server/routes/admin.js');

const OWNER_TOKEN = 'owner-session-token';
const VIEWER_TOKEN = 'viewer-session-token';

function makePool() {
  const state = { calls: [], admins: [], nextId: 100 };
  const sessions = new Map([
    [security.hashOpaqueToken(OWNER_TOKEN), { id: '1', openId: 'local:owner', email: 'owner@example.test', fullName: 'Owner', role: 'owner', csrfToken: 'owner-csrf' }],
    [security.hashOpaqueToken(VIEWER_TOKEN), { id: '2', openId: 'local:viewer', email: 'viewer@example.test', fullName: 'Viewer', role: 'viewer', csrfToken: 'viewer-csrf' }],
  ]);
  async function run(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    state.calls.push({ sql: normalized, params });
    if (normalized.includes('FROM admin_auth_sessions AS auth')) {
      const row = sessions.get(params[0]);
      return [row ? [{ ...row, tokenHash: params[0] }] : [], []];
    }
    if (normalized.startsWith('INSERT INTO admins')) {
      if (state.admins.some((admin) => admin.email === params[2])) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      const id = String(state.nextId++);
      state.admins.push({ id, email: params[2], fullName: params[3], passwordHash: params[4], role: 'viewer', createdBy: params[5] });
      return [{ affectedRows: 1, insertId: id }, []];
    }
    if (normalized.startsWith('SELECT id, full_name AS fullName, email')) {
      return [state.admins.map((admin) => ({ id: admin.id, fullName: admin.fullName, email: admin.email, createdAt: null, lastLoginAt: null })), []];
    }
    if (normalized.startsWith('DELETE FROM admins')) {
      const before = state.admins.length;
      state.admins = state.admins.filter((admin) => admin.id !== params[0]);
      return [{ affectedRows: before - state.admins.length }, []];
    }
    if (normalized.includes('FROM students')) return [[{ studentCount: 4 }], []];
    if (normalized.includes('FROM messages')) return [[{ messageCount: 9 }], []];
    if (normalized.includes('FROM admin_study_counter AS counter')) {
      return [[{ activeCount: 1, completedCount: 2, totalSeconds: 60, resetAt: null, counterVersion: 0 }], []];
    }
    return [[], []];
  }
  return { state, query: run, execute: run };
}

async function startApp(pool, t) {
  const app = express();
  app.use(express.json());
  app.use('/api', createCsrfRouter());
  app.use('/api/admin', createAdminRouter({ pool, requirePublicCsrf, requireSessionCsrf }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function as(token, csrf) {
  return { cookie: `${security.ADMIN_COOKIE}=${token}`, 'content-type': 'application/json', 'x-csrf-token': csrf };
}

test('owner can create, list and remove view-only sub-admins without storing the password', async (t) => {
  const pool = makePool();
  const origin = await startApp(pool, t);
  const password = 'Viewer-Password-2026!';

  const created = await fetch(`${origin}/api/admin/sub-admins`, {
    method: 'POST', headers: as(OWNER_TOKEN, 'owner-csrf'),
    body: JSON.stringify({ fullName: ' Sara Helper ', email: ' Sara@Example.Test ', password }),
  });
  assert.equal(created.status, 201);
  const { subAdmin } = await created.json();
  assert.deepEqual(subAdmin, { id: '100', fullName: 'Sara Helper', email: 'sara@example.test', role: 'viewer', lastLoginAt: null });
  assert.match(pool.state.calls.find((call) => call.sql.startsWith('INSERT INTO admins')).sql, /'viewer', TRUE/);
  assert.equal(await security.verifyPassword(password, pool.state.admins[0].passwordHash), true);
  assert.ok(pool.state.calls.every((call) => !call.params.includes(password)), 'the password must never reach SQL parameters');
  assert.equal(pool.state.admins[0].createdBy, '1');

  const duplicate = await fetch(`${origin}/api/admin/sub-admins`, {
    method: 'POST', headers: as(OWNER_TOKEN, 'owner-csrf'),
    body: JSON.stringify({ fullName: 'Sara Again', email: 'sara@example.test', password }),
  });
  assert.equal(duplicate.status, 409);

  const weak = await fetch(`${origin}/api/admin/sub-admins`, {
    method: 'POST', headers: as(OWNER_TOKEN, 'owner-csrf'),
    body: JSON.stringify({ fullName: 'Weak', email: 'weak@example.test', password: 'short' }),
  });
  assert.equal(weak.status, 400);

  const missingCsrf = await fetch(`${origin}/api/admin/sub-admins`, {
    method: 'POST', headers: as(OWNER_TOKEN, 'wrong'),
    body: JSON.stringify({ fullName: 'No Csrf', email: 'nocsrf@example.test', password }),
  });
  assert.equal(missingCsrf.status, 403);

  const list = await fetch(`${origin}/api/admin/sub-admins`, { headers: as(OWNER_TOKEN) });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).subAdmins.length, 1);

  const removed = await fetch(`${origin}/api/admin/sub-admins/100`, { method: 'DELETE', headers: as(OWNER_TOKEN, 'owner-csrf') });
  assert.equal(removed.status, 200);
  assert.match(pool.state.calls.find((call) => call.sql.startsWith('DELETE FROM admins')).sql, /admin_role = 'viewer'/);
  const missing = await fetch(`${origin}/api/admin/sub-admins/100`, { method: 'DELETE', headers: as(OWNER_TOKEN, 'owner-csrf') });
  assert.equal(missing.status, 404);
});

test('sub-admins can view the dashboard but cannot read messages or change anything', async (t) => {
  const pool = makePool();
  const origin = await startApp(pool, t);
  const viewer = as(VIEWER_TOKEN, 'viewer-csrf');

  const me = await fetch(`${origin}/api/admin/me`, { headers: viewer });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).admin.role, 'viewer');

  const overview = await fetch(`${origin}/api/admin/overview`, { headers: viewer });
  assert.equal(overview.status, 200);
  const overviewBody = await overview.json();
  assert.equal(overviewBody.studentCount, 4);
  assert.equal('messageCount' in overviewBody, false, 'viewers must not see message counts');

  for (const path of ['/students', '/sessions?status=all', '/study-counter/archive', '/archive/days', '/archive/days/2026-11-03']) {
    const response = await fetch(`${origin}/api/admin${path}`, { headers: viewer });
    assert.equal(response.status, 200, path);
  }

  const forbidden = [
    ['GET', '/messages'],
    ['POST', '/messages', { studentId: '7', body: 'hello' }],
    ['POST', '/messages/read', { studentId: '7' }],
    ['POST', '/sessions/5/close', {}],
    ['POST', '/study-counter/reset', { confirmed: true }],
    ['GET', '/sub-admins'],
    ['POST', '/sub-admins', { fullName: 'Other', email: 'other@example.test', password: 'Viewer-Password-2026!' }],
    ['DELETE', '/sub-admins/100'],
    ['PATCH', '/students/7', { fullName: 'New Name', email: 'new@example.test', phone: '0599000000' }],
    ['DELETE', '/students/7'],
  ];
  for (const [method, path, body] of forbidden) {
    const response = await fetch(`${origin}/api/admin${path}`, {
      method, headers: viewer, body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal((await response.json()).code, 'OWNER_REQUIRED');
  }
  assert.ok(!pool.state.calls.some((call) => /^(INSERT|UPDATE|DELETE)/.test(call.sql)), 'a viewer request must never write');
  assert.ok(!pool.state.calls.some((call) => call.sql.includes('FROM messages')), 'a viewer request must never read messages');
});
