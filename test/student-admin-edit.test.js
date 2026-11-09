import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

process.env.MANUS_PROJECT_ID = 'khanyonis-student-edit-test';
process.env.MANUS_JWT_SECRET = 'test-only-student-edit-signing-key';

const security = await import('../server/security.js');
const { requireSessionCsrf } = await import('../server/auth/csrf.js');
const { createAdminRouter } = await import('../server/routes/admin.js');

const OWNER_TOKEN = 'owner-edit-token';

function makePool() {
  const state = {
    students: new Map([['7', { email: 'old@example.test', fullName: 'Old Name', phone: '0599000000', passwordHash: 'old-hash' }]]),
    authSessions: new Set(['7']), calls: [], events: [],
  };
  async function run(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    state.calls.push({ sql: normalized, params });
    if (normalized.includes('FROM admin_auth_sessions AS auth')) {
      return [params[0] === security.hashOpaqueToken(OWNER_TOKEN)
        ? [{ id: '1', openId: 'local:owner', role: 'owner', fullName: 'Owner', email: 'owner@example.test', csrfToken: 'owner-csrf' }] : [], []];
    }
    if (normalized.startsWith('UPDATE students SET full_name')) {
      const [fullName, email, , phone, id] = params;
      if (!state.students.has(id)) return [{ affectedRows: 0 }, []];
      if ([...state.students.entries()].some(([otherId, s]) => otherId !== id && s.email === email)) {
        throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      }
      Object.assign(state.students.get(id), { fullName, email, phone });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('UPDATE students SET password_hash')) {
      state.students.get(params[1]).passwordHash = params[0];
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('DELETE FROM student_auth_sessions WHERE student_id')) {
      state.authSessions.delete(params[0]);
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('DELETE FROM students')) {
      return [{ affectedRows: state.students.delete(params[0]) ? 1 : 0 }, []];
    }
    return [[], []];
  }
  const connection = {
    execute: run, query: run,
    async beginTransaction() { state.events.push('begin'); },
    async commit() { state.events.push('commit'); },
    async rollback() { state.events.push('rollback'); },
    release() {},
  };
  return { state, execute: run, query: run, async getConnection() { return connection; } };
}

async function startApp(pool, t) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({ pool, requirePublicCsrf: (_q, _s, n) => n(), requireSessionCsrf }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const headers = { cookie: `${security.ADMIN_COOKIE}=${OWNER_TOKEN}`, 'content-type': 'application/json', 'x-csrf-token': 'owner-csrf' };

test('owner can update a student email without signing them out, and a new password signs them out everywhere', async (t) => {
  const pool = makePool();
  const origin = await startApp(pool, t);
  const patch = (body) => fetch(`${origin}/api/admin/students/7`, { method: 'PATCH', headers, body: JSON.stringify(body) });

  const emailOnly = await patch({ fullName: 'New Name', email: ' New@Example.Test ', phone: '0599111111', password: '' });
  assert.equal(emailOnly.status, 200);
  assert.deepEqual(await emailOnly.json(), {
    student: { id: '7', fullName: 'New Name', email: 'new@example.test', phone: '0599111111' }, passwordChanged: false,
  });
  assert.equal(pool.state.students.get('7').email, 'new@example.test');
  assert.equal(pool.state.students.get('7').passwordHash, 'old-hash');
  assert.ok(pool.state.authSessions.has('7'), 'changing only details keeps the student signed in');

  const withPassword = await patch({ fullName: 'New Name', email: 'new@example.test', phone: '0599111111', password: 'Fresh-Pass-99' });
  assert.equal(withPassword.status, 200);
  assert.equal((await withPassword.json()).passwordChanged, true);
  assert.equal(await security.verifyPassword('Fresh-Pass-99', pool.state.students.get('7').passwordHash), true);
  assert.equal(pool.state.authSessions.has('7'), false, 'a new password signs the student out');
  assert.ok(pool.state.calls.every((call) => !call.params.includes('Fresh-Pass-99')), 'the password never reaches SQL');
  assert.ok(pool.state.events.includes('commit'));

  assert.equal((await patch({ fullName: 'X', email: 'new@example.test', phone: '0599111111' })).status, 400);
  assert.equal((await patch({ fullName: 'New Name', email: 'not-an-email', phone: '0599111111' })).status, 400);
  assert.equal((await patch({ fullName: 'New Name', email: 'new@example.test', phone: '0599111111', password: 'short' })).status, 400);

  pool.state.students.set('8', { email: 'taken@example.test', fullName: 'Other', phone: '0599222222', passwordHash: 'h' });
  assert.equal((await patch({ fullName: 'New Name', email: 'taken@example.test', phone: '0599111111' })).status, 409);

  const missing = await fetch(`${origin}/api/admin/students/99`, {
    method: 'PATCH', headers, body: JSON.stringify({ fullName: 'Nobody Here', email: 'nobody@example.test', phone: '0599333333' }),
  });
  assert.equal(missing.status, 404);
  const noCsrf = await fetch(`${origin}/api/admin/students/7`, {
    method: 'PATCH', headers: { ...headers, 'x-csrf-token': 'wrong' }, body: JSON.stringify({ fullName: 'New Name', email: 'new@example.test', phone: '0599111111' }),
  });
  assert.equal(noCsrf.status, 403);
});

test('owner can delete a student entirely', async (t) => {
  const pool = makePool();
  const origin = await startApp(pool, t);
  const removed = await fetch(`${origin}/api/admin/students/7`, { method: 'DELETE', headers });
  assert.equal(removed.status, 200);
  assert.equal(pool.state.students.has('7'), false);
  assert.equal((await fetch(`${origin}/api/admin/students/7`, { method: 'DELETE', headers })).status, 404);
});
