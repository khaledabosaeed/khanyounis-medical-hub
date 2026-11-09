import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import express from 'express';

process.env.MANUS_PROJECT_ID = 'khanyonis-messaging-test';
process.env.MANUS_JWT_SECRET = 'test-only-messaging-signing-key';

const security = await import('../server/security.js');
const { createStudentRouter } = await import('../server/routes/student.js');
const { createAdminRouter } = await import('../server/routes/admin.js');
const passThrough = (_req, _res, next) => next();

function makeMessagingPool() {
  const calls = [];
  const studentToken = randomBytes(32).toString('hex');
  const tokenHash = security.hashOpaqueToken(studentToken);
  const adminToken = randomBytes(32).toString('hex');
  const adminTokenHash = security.hashOpaqueToken(adminToken);
  const messages = [
    {
      id: 41, studentId: '7', studentName: 'Test Student', email: 'student@example.test',
      body: 'A note from the hub', senderRole: 'admin',
      createdAt: '2026-10-10T10:00:00.000Z', readAt: '2026-10-10T10:00:01.000Z',
    },
    {
      id: 42, studentId: '7', studentName: 'Test Student', email: 'student@example.test',
      body: 'A reply from the student', senderRole: 'student',
      createdAt: '2026-10-10T10:01:00.000Z', readAt: null,
    },
  ];
  const pool = {
    calls,
    studentToken,
    adminToken,
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (normalized.includes('FROM student_auth_sessions AS auth')) {
        return [[{
          tokenHash, csrfToken: 'test-csrf', currentStudySessionId: '9', id: '7',
          fullName: 'Test Student', email: 'student@example.test', phone: '0000000000',
        }], []];
      }
      if (normalized.includes('FROM admin_auth_sessions AS auth')) {
        return [params[0] === adminTokenHash ? [{
          id: '1', openId: 'owner-test', email: 'owner@example.test', fullName: 'Owner',
          role: 'owner', tokenHash: adminTokenHash, csrfToken: 'test-admin-csrf',
        }] : [], []];
      }
      if (normalized.startsWith('INSERT INTO messages')) {
        return [{ insertId: 100 + calls.filter((call) => call.sql.startsWith('INSERT INTO messages')).length, affectedRows: 1 }, []];
      }
      if (normalized.startsWith('UPDATE messages')) return [{ affectedRows: 1 }, []];
      if (normalized.startsWith('SELECT') && normalized.includes('FROM messages')) return [messages, []];
      return [[], []];
    },
  };
  return pool;
}

async function startTestApp(pool, t) {
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

test('students and admins can exchange messages with ownership and read states preserved', async (t) => {
  const pool = makeMessagingPool();
  const origin = await startTestApp(pool, t);
  const studentCookie = `${security.STUDENT_COOKIE}=${pool.studentToken}`;
  const adminCookie = `${security.ADMIN_COOKIE}=${pool.adminToken}`;

  const studentSend = await fetch(`${origin}/api/student/messages`, {
    method: 'POST',
    headers: { cookie: studentCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ body: '  Please reply when available.  ' }),
  });
  assert.equal(studentSend.status, 201);
  assert.equal((await studentSend.json()).ok, true);
  const studentInsert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO messages'));
  assert.match(studentInsert.sql, /'student', NULL/);
  assert.equal(studentInsert.params[0], '7');
  assert.equal(studentInsert.params[1], 'Please reply when available.');

  const studentRead = await fetch(`${origin}/api/student/messages`, {
    headers: { cookie: studentCookie },
  });
  assert.equal(studentRead.status, 200);
  const studentMessages = (await studentRead.json()).messages;
  assert.ok(studentMessages.some((message) => message.senderRole === 'admin' && message.createdByAdmin));
  assert.ok(studentMessages.some((message) => message.senderRole === 'student' && !message.createdByAdmin));
  assert.ok(!pool.calls.some((call) => call.sql.startsWith('UPDATE messages')), 'loading the conversation must not mark messages as read');

  const studentMarkRead = await fetch(`${origin}/api/student/messages/read`, {
    method: 'POST', headers: { cookie: studentCookie, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(studentMarkRead.status, 200);
  const studentReadQuery = pool.calls.find((call) => call.sql.startsWith('UPDATE messages') && call.sql.includes("sender_role = 'admin'"));
  assert.ok(studentReadQuery, 'student reads must only mark incoming admin messages as read');
  assert.equal(studentReadQuery.params[0], '7');

  const adminRead = await fetch(`${origin}/api/admin/messages/read`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ studentId: '7' }),
  });
  assert.equal(adminRead.status, 200);
  const adminReadQuery = pool.calls.find((call) => call.sql.startsWith('UPDATE messages') && call.sql.includes("sender_role = 'student'"));
  assert.ok(adminReadQuery, 'admin reads must only mark incoming student messages as read');
  assert.deepEqual(adminReadQuery.params, ['7']);

  const adminSend = await fetch(`${origin}/api/admin/messages`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ studentId: '7', body: 'We received your message.' }),
  });
  assert.equal(adminSend.status, 201);
  const adminInsert = pool.calls.filter((call) => call.sql.startsWith('INSERT INTO messages')).at(-1);
  assert.match(adminInsert.sql, /'admin', \?/);
  assert.equal(adminInsert.params[0], '7');
  assert.equal(adminInsert.params[1], 'We received your message.');
  assert.equal(adminInsert.params[2], 'owner-test');

  const oversize = await fetch(`${origin}/api/student/messages`, {
    method: 'POST',
    headers: { cookie: studentCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'x'.repeat(4001) }),
  });
  assert.equal(oversize.status, 400);
});
