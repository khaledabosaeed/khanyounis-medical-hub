import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { getStudyCounterOverview, resetStudyCounter } from '../server/admin-counter.js';
import { createAdminRouter } from '../server/routes/admin.js';
import { requireSessionCsrf } from '../server/auth/csrf.js';
import { ADMIN_COOKIE, STUDENT_COOKIE, hashOpaqueToken } from '../server/security.js';

const now = Date.parse('2026-10-19T12:00:00.000Z');
const fixtures = [
  { id: '1', status: 'completed', start: now - 14400000, end: now - 10800000, duration: 3600 },
  { id: '2', status: 'completed', start: now - 10800000, end: now - 3600000, duration: 7200 },
  { id: '3', status: 'active', start: now - 10800000, end: null, duration: 0 },
  { id: '4', status: 'active', start: now - 1800000, end: null, duration: 0 },
];

function makePool() {
  const state = { now, resetAt: null, version: 0, owner: null, calls: [], events: [], failRead: false, sessions: structuredClone(fixtures) };
  const activeCount = () => state.sessions.filter(s => s.status === 'active').length;
  let snapshot;
  const connection = {
    async beginTransaction() { snapshot = { resetAt: state.resetAt, version: state.version, owner: state.owner }; state.events.push('begin'); },
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.calls.push({ sql: normalized, params });
      if (normalized === 'SELECT id FROM admin_study_counter WHERE id = 1 FOR UPDATE') return [[{ id: 1 }], []];
      if (normalized.startsWith('UPDATE admin_study_counter')) {
        state.resetAt = state.now; state.version += 1; state.owner = params[0];
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('SELECT reset_at AS resetAt')) {
        if (state.failRead) throw new Error('Simulated database failure');
        return [[{ resetAt: new Date(state.resetAt), counterVersion: state.version, activeCount: activeCount() }], []];
      }
      throw new Error(`Unexpected transaction SQL: ${normalized}`);
    },
    async commit() { state.events.push('commit'); },
    async rollback() { Object.assign(state, snapshot); state.events.push('rollback'); },
    release() { state.events.push('release'); },
  };
  return {
    state,
    async getConnection() { return connection; },
    async execute(sql, params) {
      assert.match(sql, /FROM admin_auth_sessions AS auth/);
      return [params[0] === hashOpaqueToken('owner-test-token') ? [{ id: '8', role: 'owner', openId: 'test-owner', csrfToken: 'owner-csrf' }] : [], []];
    },
    async query(sql) {
      if (sql.includes('FROM students')) return [[{ studentCount: 3 }], []];
      if (sql.includes('FROM messages')) return [[{ messageCount: 2 }], []];
      assert.match(sql, /FROM admin_study_counter AS counter/);
      assert.match(sql, /GREATEST\(session.started_at, counter.reset_at\)/);
      assert.match(sql, /LEAST\(COALESCE\(session.ended_at, UTC_TIMESTAMP\(3\)\), UTC_TIMESTAMP\(3\)\)/);
      const totalSeconds = state.sessions.reduce((sum, session) => {
        if (state.resetAt === null && session.status === 'completed') return sum + session.duration;
        const start = Math.max(session.start, state.resetAt ?? session.start);
        const end = Math.min(session.end ?? state.now, state.now);
        return sum + Math.max(0, Math.floor((end - start) / 1000));
      }, 0);
      return [[{ activeCount: activeCount(), completedCount: state.sessions.length - activeCount(), totalSeconds,
        resetAt: state.resetAt === null ? null : new Date(state.resetAt), counterVersion: state.version }], []];
    },
  };
}

test('counter reset zeros only the administrative total and preserves session history and individual durations', async () => {
  const pool = makePool();
  const originalSessions = structuredClone(pool.state.sessions);
  const before = await getStudyCounterOverview(pool);
  assert.equal(before.totalSeconds, fixtures.reduce((sum, session) => sum + (session.status === 'completed' ? session.duration : (now - session.start) / 1000), 0));
  const reset = await resetStudyCounter(pool, '8');
  assert.equal(reset.totalSeconds, 0);
  assert.equal(reset.counterResetAt, new Date(now).toISOString());
  assert.equal(reset.counterVersion, 1);
  assert.equal(pool.state.owner, '8');
  assert.deepEqual(pool.state.events, ['begin', 'commit', 'release']);
  assert.deepEqual(pool.state.sessions, originalSessions);
  assert.ok(pool.state.calls.every(call => !/DELETE|UPDATE study_sessions|UPDATE students/i.test(call.sql)));

  assert.equal((await getStudyCounterOverview(pool)).totalSeconds, 0, 'a fresh request uses the saved baseline');
  pool.state.now += 30000;
  const later = await getStudyCounterOverview(pool);
  assert.equal(later.totalSeconds, 30 * before.activeSessionCount);
  assert.equal(later.activeSessionCount, before.activeSessionCount);
  assert.equal(later.completedSessionCount, before.completedSessionCount);
  await resetStudyCounter(pool, '8');
  assert.equal((await getStudyCounterOverview(pool)).totalSeconds, 0);
  assert.equal(pool.state.version, 2);
});

test('sessions crossing the period boundary include only their time after the reset, even when completed', async () => {
  const pool = makePool();
  pool.state.resetAt = Date.parse('2026-10-19T10:00:00.000Z');
  pool.state.version = 1;
  const overview = await getStudyCounterOverview(pool);
  const expected = [3600, 7200, 1800].reduce((sum, seconds) => sum + seconds, 0);
  assert.equal(overview.totalSeconds, expected);
  assert.equal(overview.counterResetAt, '2026-10-19T10:00:00.000Z');
  pool.state.sessions = [];
  const empty = await getStudyCounterOverview(pool);
  assert.equal(empty.totalSeconds, 0);
  assert.equal(empty.activeSessionCount, 0);
});

test('reset rolls back its baseline if the transaction does not complete', async () => {
  const pool = makePool();
  pool.state.failRead = true;
  await assert.rejects(resetStudyCounter(pool, '8'), /Simulated database failure/);
  assert.equal(pool.state.resetAt, null);
  assert.equal(pool.state.version, 0);
  assert.deepEqual(pool.state.events, ['begin', 'rollback', 'release']);
});

test('reset API requires an owner session, CSRF and explicit confirmation; overview keeps the baseline on later requests', async (t) => {
  const pool = makePool();
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({ pool, requirePublicCsrf: (_req, _res, next) => next(), requireSessionCsrf }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${origin}/api/admin/study-counter/reset`;
  const headers = { cookie: `${ADMIN_COOKIE}=owner-test-token`, 'content-type': 'application/json', 'x-csrf-token': 'owner-csrf' };
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { cookie: `${STUDENT_COOKIE}=student-test-token` } })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { cookie: headers.cookie } })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ confirmed: false }) })).status, 400);
  assert.equal(pool.state.version, 0);
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ confirmed: true }) });
  assert.equal(response.status, 200);
  const reset = await response.json();
  assert.equal(reset.totalSeconds, 0);
  pool.state.now += 5000;
  const nextOverview = await fetch(`${origin}/api/admin/overview`, { headers });
  assert.equal(nextOverview.status, 200);
  const data = await nextOverview.json();
  assert.equal(data.totalSeconds, 5 * data.activeSessionCount);
  assert.equal(data.counterResetAt, reset.counterResetAt);
  assert.equal(data.counterVersion, reset.counterVersion);
  assert.equal(data.studentCount, 3);
});
