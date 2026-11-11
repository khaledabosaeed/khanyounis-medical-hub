import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

process.env.MANUS_PROJECT_ID = 'khanyonis-session-resume-test';
process.env.MANUS_JWT_SECRET = 'test-only-session-resume-signing-key';

const security = await import('../server/security.js');
const { createStudentRouter } = await import('../server/routes/student.js');
const { STUDENT_SESSION_SECONDS } = await import('../server/auth/student.js');
const passThrough = (_req, _res, next) => next();
const PASSWORD = 'Student-Pass-1';

async function makePool({ activeSessionId = null, sessions = [] } = {}) {
  const state = {
    passwordHash: await security.hashPassword(PASSWORD),
    sessions: activeSessionId ? [{ id: activeSessionId, status: 'active' }] : structuredClone(sessions),
    auth: new Map(), calls: [], txCalls: [], nextSessionId: 500, needsRenewal: false,
  };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.txCalls.push({ sql: normalized, params });
      if (normalized.startsWith('SELECT id FROM students WHERE id = ? FOR UPDATE')) return [[{ id: params[0] }], []];
      if (normalized.startsWith('SELECT id FROM study_sessions')) {
        if (normalized.includes("status = 'active'")) {
          const active = state.sessions.filter((session) => session.status === 'active').at(-1);
          return [active ? [{ id: active.id }] : [], []];
        }
        // Today's (hub time zone) completed session that is not archived yet.
        assert.match(normalized, /status = 'completed' AND archived_at IS NULL/);
        assert.match(normalized, /\(started_at AT TIME ZONE \?\)::date = \(CURRENT_TIMESTAMP AT TIME ZONE \?\)::date/);
        assert.equal(params[1], 'Asia/Gaza');
        const today = state.sessions.filter((session) => session.status === 'completed' && session.today && !session.archived).at(-1);
        return [today ? [{ id: today.id }] : [], []];
      }
      if (normalized.startsWith("UPDATE study_sessions SET status = 'active', ended_at = NULL, segment_started_at = UTC_TIMESTAMP(3)")) {
        const session = state.sessions.find((item) => item.id === String(params[0]) && item.status === 'completed' && !item.archived);
        if (session) session.status = 'active';
        return [{ affectedRows: session ? 1 : 0 }, []];
      }
      if (normalized.startsWith('INSERT INTO study_sessions')) {
        const id = String(state.nextSessionId++);
        state.sessions.push({ id, status: 'active' });
        return [{ affectedRows: 1, insertId: id }, []];
      }
      if (normalized.startsWith('INSERT INTO student_auth_sessions')) {
        state.auth.set(params[0], { studySessionId: params[2], lifetime: params[4] });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('SELECT id, DATE_FORMAT(started_at')) {
        return [[{ id: params[0], startedAt: '2026-11-09T08:00:00.000Z', status: 'active', durationSeconds: 0 }], []];
      }
      throw new Error(`Unexpected transaction SQL: ${normalized}`);
    },
  };
  const pool = {
    state,
    async getConnection() { return connection; },
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.calls.push({ sql: normalized, params });
      if (normalized.startsWith('SELECT id, full_name AS fullName, email, phone, password_hash')) {
        return [[{ id: '7', fullName: 'Test Student', email: 'student@example.test', phone: '0599000000', passwordHash: state.passwordHash }], []];
      }
      if (normalized.includes('FROM student_auth_sessions AS auth')) {
        const auth = state.auth.get(params[1]);
        return [auth ? [{
          tokenHash: params[1], csrfToken: 'csrf', currentStudySessionId: auth.studySessionId,
          id: '7', fullName: 'Test Student', email: 'student@example.test', phone: '0599000000',
          needsRenewal: state.needsRenewal,
        }] : [], []];
      }
      if (normalized.startsWith('UPDATE student_auth_sessions SET expires_at')) return [{ affectedRows: 1 }, []];
      if (normalized.startsWith('SELECT status FROM study_sessions')) return [[{ status: 'active' }], []];
      return [[], []];
    },
  };
  return pool;
}

async function startApp(pool, t) {
  const app = express();
  app.use(express.json());
  app.use('/api/student', createStudentRouter({ pool, requirePublicCsrf: passThrough, requireSessionCsrf: passThrough }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function login(origin) {
  return fetch(`${origin}/api/student/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'student@example.test', password: PASSWORD }),
  });
}

test('logging in while a study session is active resumes it instead of starting a second one', async (t) => {
  const pool = await makePool({ activeSessionId: '42' });
  const origin = await startApp(pool, t);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await login(origin);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.studySession.id, '42');
    assert.equal(body.resumedSession, true);
  }
  assert.equal(pool.state.sessions.length, 1, 'no new study session is created');
  assert.ok(!pool.state.txCalls.some((call) => call.sql.startsWith('INSERT INTO study_sessions')));
  assert.ok([...pool.state.auth.values()].every((auth) => auth.studySessionId === '42'), 'both sign-ins attach to the same session');
  assert.ok(pool.state.txCalls[0].sql.endsWith('FOR UPDATE'), 'the student row is locked before checking for an active session');
});

test('logging in with no active study session starts exactly one new session', async (t) => {
  const pool = await makePool();
  const origin = await startApp(pool, t);
  const first = await (await login(origin)).json();
  assert.equal(first.resumedSession, false);
  assert.equal(first.studySession.id, '500');
  const second = await (await login(origin)).json();
  assert.equal(second.resumedSession, true);
  assert.equal(second.studySession.id, '500');
  assert.equal(pool.state.sessions.length, 1);
});

test('signing in again on the same day reopens that day\'s session instead of starting another one', async (t) => {
  const pool = await makePool({ sessions: [{ id: '77', status: 'completed', today: true }] });
  const origin = await startApp(pool, t);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const body = await (await login(origin)).json();
    assert.equal(body.studySession.id, '77');
    assert.equal(body.resumedSession, true);
    pool.state.sessions[0].status = 'completed'; // signed out again
  }
  assert.equal(pool.state.sessions.length, 1, 'ten sign-ins in a day are still one session');
  assert.ok(!pool.state.txCalls.some((call) => call.sql.startsWith('INSERT INTO study_sessions')));
});

test('a session from an earlier day, or one already archived, is not reopened', async (t) => {
  for (const old of [{ id: '60', status: 'completed', today: false }, { id: '61', status: 'completed', today: true, archived: true }]) {
    const pool = await makePool({ sessions: [old] });
    const origin = await startApp(pool, t);
    const body = await (await login(origin)).json();
    assert.equal(body.resumedSession, false);
    assert.equal(body.studySession.id, '500');
    assert.equal(pool.state.sessions.find((session) => session.id === old.id).status, 'completed');
  }
});

test('student sign-ins use a persistent long-lived cookie that is renewed while in use', async (t) => {
  const pool = await makePool();
  const origin = await startApp(pool, t);
  const response = await login(origin);
  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, new RegExp(`Max-Age=${STUDENT_SESSION_SECONDS}`), 'the cookie persists even without "remember me"');
  assert.equal([...pool.state.auth.values()][0].lifetime, STUDENT_SESSION_SECONDS);
  const cookie = setCookie.split(';')[0];

  const fresh = await fetch(`${origin}/api/student/session-status`, { headers: { cookie } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get('set-cookie'), null, 'a recently renewed sign-in is not rewritten on every request');

  pool.state.needsRenewal = true;
  const renewed = await fetch(`${origin}/api/student/session-status`, { headers: { cookie } });
  assert.equal(renewed.status, 200);
  assert.match(renewed.headers.get('set-cookie') || '', new RegExp(`Max-Age=${STUDENT_SESSION_SECONDS}`));
  const update = pool.state.calls.find((call) => call.sql.startsWith('UPDATE student_auth_sessions SET expires_at'));
  assert.deepEqual(update.params.slice(0, 1), [STUDENT_SESSION_SECONDS]);
});
