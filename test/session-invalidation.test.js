import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import express from 'express';

process.env.MANUS_PROJECT_ID = 'khanyonis-session-invalidation-test';
process.env.MANUS_JWT_SECRET = 'test-only-session-invalidation-signing-key';

const security = await import('../server/security.js');
const { createStudentRouter } = await import('../server/routes/student.js');
const { createAdminRouter } = await import('../server/routes/admin.js');
const passThrough = (_req, _res, next) => next();

function createSessionStore({ status = 'active', currentStudySessionId = '42' } = {}) {
  const token = randomBytes(32).toString('hex');
  const adminToken = randomBytes(32).toString('hex');
  const adminTokenHash = security.hashOpaqueToken(adminToken);
  const state = { status, currentStudySessionId, authExists: true, calls: [], transactionEvents: [] };
  const studentRow = () => ({
    tokenHash: security.hashOpaqueToken(token), csrfToken: 'test-csrf',
    currentStudySessionId: state.currentStudySessionId, id: '7',
    fullName: 'Test Student', email: 'student@example.test', phone: '0000000000',
  });

  const connection = {
    async beginTransaction() { state.transactionEvents.push({ type: 'begin' }); },
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.transactionEvents.push({ type: 'execute', sql: normalized, params });
      if (normalized.startsWith('UPDATE study_sessions')) {
        const changed = state.status === 'active' && String(params[0]) === String(state.currentStudySessionId);
        if (changed) state.status = 'completed';
        return [{ affectedRows: changed ? 1 : 0 }, []];
      }
      if (normalized.startsWith('DELETE FROM student_auth_sessions')) {
        state.authExists = false;
        return [{ affectedRows: 1 }, []];
      }
      return [{ affectedRows: 0 }, []];
    },
    async commit() { state.transactionEvents.push({ type: 'commit' }); },
    async rollback() { state.transactionEvents.push({ type: 'rollback' }); },
    release() { state.transactionEvents.push({ type: 'release' }); },
  };

  const pool = {
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.calls.push({ sql: normalized, params });
      if (normalized.includes('FROM admin_auth_sessions AS auth')) {
        return [params[0] === adminTokenHash ? [{
          id: '1', openId: 'owner-test', email: 'owner@example.test', fullName: 'Owner',
          role: 'owner', tokenHash: adminTokenHash, csrfToken: 'test-admin-csrf',
        }] : [], []];
      }
      if (normalized.includes('FROM student_auth_sessions AS auth')) {
        return [state.authExists ? [studentRow()] : [], []];
      }
      if (normalized.includes('FROM study_sessions')) {
        return [state.status ? [{ status: state.status }] : [], []];
      }
      if (normalized.startsWith('DELETE FROM student_auth_sessions')) {
        state.authExists = false;
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    },
    async getConnection() { return connection; },
  };
  return { pool, state, token, adminToken };
}

async function startApp(pool, t) {
  const app = express();
  app.use(express.json());
  app.use('/api/student', createStudentRouter({
    pool, requirePublicCsrf: passThrough, requireSessionCsrf: passThrough,
  }));
  app.use('/api/admin', createAdminRouter({ pool, requirePublicCsrf: passThrough, requireSessionCsrf: passThrough }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function studentCookie(token) {
  return `${security.STUDENT_COOKIE}=${token}`;
}

test('admin closure completes only the linked session and invalidates its student login atomically', async (t) => {
  const { pool, state, token, adminToken } = createSessionStore();
  const origin = await startApp(pool, t);
  const studentHeaders = { cookie: studentCookie(token) };

  const activeStatus = await fetch(`${origin}/api/student/session-status`, { headers: studentHeaders });
  assert.equal(activeStatus.status, 200);
  assert.deepEqual(await activeStatus.json(), { active: true });

  const closed = await fetch(`${origin}/api/admin/sessions/42/close`, {
    method: 'POST', headers: { cookie: `${security.ADMIN_COOKIE}=${adminToken}` },
  });
  assert.equal(closed.status, 200);
  assert.deepEqual(await closed.json(), { ok: true, sessionId: '42' });
  assert.equal(state.status, 'completed');
  assert.equal(state.authExists, false);

  const tx = state.transactionEvents;
  assert.deepEqual(tx.map((event) => event.type), ['begin', 'execute', 'execute', 'commit', 'release']);
  assert.match(tx[1].sql, /WHERE id = \? AND status = 'active'/);
  assert.deepEqual(tx[1].params, ['42']);
  assert.match(tx[2].sql, /DELETE FROM student_auth_sessions WHERE current_study_session_id = \?/);
  assert.deepEqual(tx[2].params, ['42'], 'only auth records tied to the closed study session are removed');

  const nextStatus = await fetch(`${origin}/api/student/session-status`, { headers: studentHeaders });
  assert.equal(nextStatus.status, 401, 'the next heartbeat must reject the invalidated student login');
});

test('session-status rejects a lingering login whose linked study session is already completed', async (t) => {
  const { pool, state, token } = createSessionStore({ status: 'completed' });
  const origin = await startApp(pool, t);

  const response = await fetch(`${origin}/api/student/session-status`, {
    headers: { cookie: studentCookie(token) },
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'STUDENT_STUDY_SESSION_CLOSED');
  assert.equal(state.authExists, false);
  assert.match(response.headers.get('set-cookie') || '', new RegExp(`${security.STUDENT_COOKIE}=`));
  assert.ok(state.calls.some((call) => call.sql.startsWith('DELETE FROM student_auth_sessions WHERE token_hash = ?')));
});
