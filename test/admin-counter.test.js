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

// Study time of a session up to `at`: finished stretches plus the running one.
function liveSeconds(session, at) {
  if (session.status !== 'active') return session.duration;
  return session.duration + Math.max(0, Math.floor((at - (session.segment ?? session.start)) / 1000));
}

function periodSeconds(state) {
  return state.sessions.filter(s => !s.archivedAt)
    .reduce((sum, s) => sum + Math.max(0, liveSeconds(s, state.now) - (s.prev || 0)), 0);
}

function makePool() {
  const state = { now, resetAt: null, version: 0, owner: null, calls: [], events: [], failRead: false,
    sessions: structuredClone(fixtures).map(s => ({ ...s, duration: s.status === 'active' ? 0 : s.duration, prev: 0 })), archive: [] };
  const activeCount = () => state.sessions.filter(s => s.status === 'active').length;
  let snapshot;
  const connection = {
    async beginTransaction() {
      snapshot = { resetAt: state.resetAt, version: state.version, owner: state.owner, sessions: structuredClone(state.sessions), archive: structuredClone(state.archive) };
      state.events.push('begin');
    },
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.calls.push({ sql: normalized, params });
      if (normalized === 'SELECT id FROM admin_study_counter WHERE id = 1 FOR UPDATE') return [[{ id: 1 }], []];
      if (normalized.startsWith('SELECT reset_at AS resetAt, reset_version AS counterVersion, CURRENT_TIMESTAMP(3) AS resetNow')) {
        return [[{ resetAt: state.resetAt === null ? null : new Date(state.resetAt), counterVersion: state.version, resetNow: new Date(state.now) }], []];
      }
      if (normalized.startsWith("SELECT COALESCE(SUM(CASE WHEN session.status = 'completed'")) {
        assert.match(normalized, /WHERE session.archived_at IS NULL/);
        assert.match(normalized, /- session.previous_period_seconds/);
        const completed = state.sessions.filter(s => s.status === 'completed' && !s.archivedAt);
        return [[{ completedCount: completed.length, totalSeconds: periodSeconds(state) }], []];
      }
      if (normalized.startsWith('UPDATE study_sessions AS session SET previous_period_seconds')) {
        assert.match(normalized, /WHERE session.status = 'active' AND session.archived_at IS NULL/);
        state.sessions.filter(s => s.status === 'active' && !s.archivedAt).forEach(s => { s.prev = liveSeconds(s, state.now); });
        return [{ affectedRows: activeCount() }, []];
      }
      if (normalized.startsWith('INSERT INTO admin_study_counter_archive')) {
        state.archive.push({ id: String(state.archive.length + 1), periodStartedAt: params[0], periodEndedAt: params[1], completed: params[2], seconds: params[3] });
        return [{ affectedRows: 1, insertId: String(state.archive.length) }, []];
      }
      if (normalized.startsWith('UPDATE study_sessions SET archived_at')) {
        assert.match(normalized, /WHERE status = 'completed' AND archived_at IS NULL/);
        const targets = state.sessions.filter(s => s.status === 'completed' && !s.archivedAt);
        targets.forEach(s => { s.archivedAt = params[0]; s.periodId = params[1]; });
        return [{ affectedRows: targets.length }, []];
      }
      if (normalized.startsWith('UPDATE admin_study_counter')) {
        state.resetAt = state.now; state.version += 1; state.owner = params[1];
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
      assert.match(sql, /LEFT JOIN study_sessions AS session ON session.archived_at IS NULL/);
      assert.match(sql, /COALESCE\(session.segment_started_at, session.started_at\)/);
      assert.match(sql, /- session.previous_period_seconds/);
      const live = state.sessions.filter(s => !s.archivedAt);
      return [[{ activeCount: activeCount(), completedCount: live.filter(s => s.status === 'completed').length, totalSeconds: periodSeconds(state),
        resetAt: state.resetAt === null ? null : new Date(state.resetAt), counterVersion: state.version }], []];
    },
  };
}

test('counter reset zeros the administrative total and moves completed sessions to the archive without deleting anything', async () => {
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
  assert.equal(reset.archivedSessionCount, 2);
  assert.equal(pool.state.archive.length, 1);
  assert.equal(pool.state.archive[0].completed, 2);
  assert.equal(pool.state.archive[0].seconds, before.totalSeconds, 'the closed period keeps exactly what the counter showed');
  assert.equal(reset.archivedSessionSeconds, before.totalSeconds);
  for (const session of pool.state.sessions) {
    const original = originalSessions.find(item => item.id === session.id);
    assert.equal(session.duration, original.status === 'active' ? 0 : original.duration, 'durations never change');
    assert.equal(session.status, original.status, 'active sessions keep running');
    assert.equal(Boolean(session.archivedAt), session.status === 'completed', 'only completed sessions are archived');
    if (session.archivedAt) assert.equal(session.periodId, '1');
  }
  assert.equal(pool.state.sessions.length, originalSessions.length, 'nothing is deleted');
  assert.ok(pool.state.calls.every(call => !/DELETE|UPDATE students/i.test(call.sql)));

  assert.equal((await getStudyCounterOverview(pool)).totalSeconds, 0, 'a fresh request uses the saved baseline');
  pool.state.now += 30000;
  const later = await getStudyCounterOverview(pool);
  assert.equal(later.totalSeconds, 30 * before.activeSessionCount);
  assert.equal(later.activeSessionCount, before.activeSessionCount);
  assert.equal(later.completedSessionCount, 0, 'completed sessions moved to the archive leave the counter');
  await resetStudyCounter(pool, '8');
  assert.equal((await getStudyCounterOverview(pool)).totalSeconds, 0);
  assert.equal(pool.state.version, 2);
});

test('sessions crossing the period boundary include only their time after the reset, even when completed', async () => {
  const pool = makePool();
  pool.state.resetAt = Date.parse('2026-10-19T10:00:00.000Z');
  pool.state.version = 1;
  // State after a reset at 10:00: session 1 ended before it and was archived;
  // sessions 2 and 3 were running and had 1 hour counted by the old period.
  pool.state.sessions[0].archivedAt = pool.state.resetAt;
  pool.state.sessions[1].prev = 3600;
  pool.state.sessions[2].prev = 3600;
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
  assert.ok(pool.state.sessions.every(session => !session.archivedAt), 'archiving rolls back with the reset');
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
