import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

process.env.MANUS_PROJECT_ID = 'khanyonis-test-project';
process.env.MANUS_JWT_SECRET = 'test-only-signing-key-not-used-outside-test';

const security = await import('../server/security.js');
const { durationSeconds, toIsoUtc } = await import('../server/time.js');
const { createStudentRouter } = await import('../server/routes/student.js');
const { createAdminRouter } = await import('../server/routes/admin.js');
const { parseAllowedOrigin } = await import('../server/auth/manus-oauth.js');

const passThrough = (_req, _res, next) => next();

test('security primitives, UTC duration helpers, and role boundaries behave safely', async (t) => {
  assert.equal(security.normalizeEmail('  Student@Example.ORG '), 'student@example.org');
  assert.equal(parseAllowedOrigin({ body: { origin: 'https://studyhub-wtr2hg8x.manus.space' } }), 'https://studyhub-wtr2hg8x.manus.space');
  assert.equal(parseAllowedOrigin({ body: { origin: 'https://attacker.example' } }), null);
  assert.equal(parseAllowedOrigin({ body: { origin: 'http://attacker.example' } }), null);

  const csrf = security.createCsrfToken();
  assert.equal(security.verifyCsrfToken(csrf), true);
  assert.equal(security.verifyCsrfToken(`${csrf}x`), false);

  const hash = await security.hashPassword('Test-password-123');
  assert.notEqual(hash, 'Test-password-123');
  assert.match(hash, /^\$2[aby]\$12\$/);
  assert.equal(await security.verifyPassword('Test-password-123', hash), true);
  assert.equal(await security.verifyPassword('wrong-password', hash), false);

  const now = Math.floor(Date.now() / 1000);
  const validJwt = security.signPlatformJwt({ appId: process.env.MANUS_PROJECT_ID, openId: 'owner-test', exp: now + 120 });
  assert.equal(security.verifyPlatformJwt(validJwt)?.openId, 'owner-test');
  const [jwtHeader, jwtPayload, jwtSignature] = validJwt.split('.');
  const alteredSignature = `${jwtSignature[0] === 'A' ? 'B' : 'A'}${jwtSignature.slice(1)}`;
  assert.equal(security.verifyPlatformJwt(`${jwtHeader}.${jwtPayload}.${alteredSignature}`), null);
  assert.equal(security.verifyPlatformJwt(security.signPlatformJwt({ appId: 'another-project', openId: 'owner-test', exp: now + 120 })), null);
  assert.equal(security.verifyPlatformJwt(security.signPlatformJwt({ appId: process.env.MANUS_PROJECT_ID, openId: 'owner-test', exp: now - 1 })), null);

  assert.equal(durationSeconds('2026-10-07T00:00:00.100Z', '2026-10-07T00:00:02.900Z'), 2);
  assert.equal(durationSeconds('invalid', '2026-10-07T00:00:02.900Z'), 0);
  assert.equal(toIsoUtc('2026-10-07 10:20:30.123456'), '2026-10-07T10:20:30.123Z');

  let queryCount = 0;
  const pool = {
    async execute() { queryCount += 1; return [[], []]; },
    async query() { queryCount += 1; return [[], []]; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/student', createStudentRouter({ pool, requirePublicCsrf: passThrough, requireSessionCsrf: passThrough }));
  app.use('/api/admin', createAdminRouter({ pool, requirePublicCsrf: passThrough, requireSessionCsrf: passThrough }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const studentMissing = await fetch(`${origin}/api/student/me`);
  assert.equal(studentMissing.status, 401);
  assert.equal(queryCount, 0, 'missing student cookie must not query private data');

  const studentUnknown = await fetch(`${origin}/api/student/me`, {
    headers: { cookie: `${security.STUDENT_COOKIE}=unknown-token` },
  });
  assert.equal(studentUnknown.status, 401);
  assert.equal(queryCount, 1, 'an unknown student token must be rejected after lookup');

  const adminMissing = await fetch(`${origin}/api/admin/overview`);
  assert.equal(adminMissing.status, 401);
  const unregisteredAdminToken = security.randomToken();
  const adminUnregistered = await fetch(`${origin}/api/admin/overview`, {
    headers: { cookie: `${security.ADMIN_COOKIE}=${unregisteredAdminToken}` },
  });
  assert.equal(adminUnregistered.status, 401);
  assert.equal(queryCount, 2, 'an unknown admin token must not grant access');
});
