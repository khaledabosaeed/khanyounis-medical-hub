import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

process.env.MANUS_PROJECT_ID = 'khanyonis-admin-auth-test';
process.env.MANUS_JWT_SECRET = 'test-only-admin-auth-signing-key';

const security = await import('../server/security.js');
const { createCsrfRouter, requirePublicCsrf, requireSessionCsrf } = await import('../server/auth/csrf.js');
const { bootstrapOwnerAccount } = await import('../server/auth/admin.js');
const { createAdminRouter } = await import('../server/routes/admin.js');

function makeAdminPool(passwordHash, email = 'owner@example.test') {
  const state = { attempts: [], sessions: new Map(), calls: [] };
  const account = {
    id: '31', openId: 'local:test-owner', email, fullName: 'مالك المنصة', passwordHash, role: 'owner',
  };
  state.account = account;
  const pool = {
    state,
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.calls.push({ sql: normalized, params });
      if (normalized.startsWith('DELETE FROM admin_login_attempts')) {
        if (normalized.includes('email_normalized = ?')) {
          state.attempts = state.attempts.filter((item) => item.email !== params[0] || item.sourceHash !== params[1]);
        }
        return [{ affectedRows: 0 }, []];
      }
      if (normalized.startsWith('SELECT COUNT(*) AS attemptCount')) {
        const count = state.attempts.filter((item) => item.email === params[0] && item.sourceHash === params[1]).length;
        return [[{ attemptCount: count }], []];
      }
      if (normalized.startsWith('SELECT id, open_id AS openId')) {
        return [params[0] === account.email ? [account] : [], []];
      }
      if (normalized.startsWith('INSERT INTO admin_login_attempts')) {
        state.attempts.push({ email: params[0], sourceHash: params[1] });
        return [{ affectedRows: 1, insertId: state.attempts.length }, []];
      }
      if (normalized.startsWith('UPDATE admins SET last_login_at')) return [{ affectedRows: 1 }, []];
      if (normalized.startsWith('INSERT INTO admin_auth_sessions')) {
        const row = {
          id: account.id, openId: account.openId, email: account.email, fullName: account.fullName,
          role: account.role, tokenHash: params[0], csrfToken: params[2],
        };
        state.sessions.set(params[0], row);
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.includes('FROM admin_auth_sessions AS auth')) {
        return [state.sessions.has(params[0]) ? [state.sessions.get(params[0])] : [], []];
      }
      if (normalized.startsWith('DELETE FROM admin_auth_sessions')) {
        state.sessions.delete(params[0]);
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    },
  };
  return pool;
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

async function getPublicCsrf(origin) {
  const response = await fetch(`${origin}/api/csrf`);
  assert.equal(response.status, 200);
  const { csrfToken } = await response.json();
  const cookieHeader = response.headers.get('set-cookie') || '';
  const cookie = cookieHeader.split(';')[0];
  assert.ok(cookie.startsWith(`${security.CSRF_COOKIE}=`));
  return { csrfToken, cookie };
}

function postHeaders(csrf) {
  return {
    cookie: csrf.cookie,
    'content-type': 'application/json',
    'x-csrf-token': csrf.csrfToken,
  };
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test('owner bootstrap stores only a bcrypt hash and never overwrites an initialized password', async () => {
  const priorEmail = process.env.KHANYOUNIS_ADMIN_EMAIL;
  const priorPassword = process.env.ADMIN_INITIAL_PASSWORD;
  process.env.KHANYOUNIS_ADMIN_EMAIL = ' Owner@Example.Test ';
  const initialPassword = 'Safe-Owner-Test-Password-47!';
  process.env.ADMIN_INITIAL_PASSWORD = initialPassword;
  let owner = null;
  const calls = [];
  const connection = {
    async query(sql) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: [] });
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
      return [[], []];
    },
    async execute(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith('SELECT id, password_hash AS passwordHash')) {
        return [owner ? [{ id: owner.id, passwordHash: owner.passwordHash, emailNormalized: owner.emailNormalized, role: 'owner' }] : [], []];
      }
      if (normalized.startsWith('INSERT INTO admins')) {
        owner = { id: '31', openId: params[0], email: params[1], emailNormalized: params[2], fullName: params[3], passwordHash: params[4] };
        return [{ insertId: 31, affectedRows: 1 }, []];
      }
      if (normalized.startsWith('UPDATE admins')) {
        owner.passwordHash = params[0];
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    },
    release() {},
  };
  const pool = { async getConnection() { return connection; } };

  try {
    const seeded = await bootstrapOwnerAccount(pool);
    assert.deepEqual(seeded, { created: true, reusedAccount: false });
    assert.equal(owner.emailNormalized, 'owner@example.test');
    assert.match(owner.openId, /^local:/);
    assert.notEqual(owner.passwordHash, initialPassword);
    assert.equal(await security.verifyPassword(initialPassword, owner.passwordHash), true);
    assert.equal(process.env.ADMIN_INITIAL_PASSWORD, undefined);
    assert.ok(calls.every((call) => !call.params.includes(initialPassword)), 'the password must never reach SQL parameters');

    const savedHash = owner.passwordHash;
    process.env.ADMIN_INITIAL_PASSWORD = 'Another-Safe-Test-Password-48!';
    const secondRun = await bootstrapOwnerAccount(pool);
    assert.deepEqual(secondRun, { created: false, reason: 'owner_already_initialized' });
    assert.equal(owner.passwordHash, savedHash);
    assert.equal(process.env.ADMIN_INITIAL_PASSWORD, undefined);

    process.env.KHANYOUNIS_ADMIN_EMAIL = 'different-owner@example.test';
    process.env.ADMIN_INITIAL_PASSWORD = 'Another-Safe-Test-Password-48!';
    await assert.rejects(bootstrapOwnerAccount(pool), { code: 'OWNER_ALREADY_CONFIGURED' });
    assert.equal(owner.passwordHash, savedHash);

    process.env.KHANYOUNIS_ADMIN_EMAIL = 'owner@example.test';
    owner.passwordHash = null;
    const existingOpenId = owner.openId;
    await assert.rejects(bootstrapOwnerAccount(pool), { code: 'OWNER_INITIAL_PASSWORD_MISSING' });
    process.env.ADMIN_INITIAL_PASSWORD = initialPassword;
    assert.deepEqual(await bootstrapOwnerAccount(pool), { created: true, reusedAccount: true });
    assert.equal(owner.openId, existingOpenId);
    assert.equal(await security.verifyPassword(initialPassword, owner.passwordHash), true);
  } finally {
    restoreEnvironment('KHANYOUNIS_ADMIN_EMAIL', priorEmail);
    restoreEnvironment('ADMIN_INITIAL_PASSWORD', priorPassword);
  }
});

test('owner can sign in, retain an eight-hour secure session, and sign out with session CSRF', async (t) => {
  const password = 'Safe-Owner-Test-Password-47!';
  const passwordHash = await security.hashPassword(password);
  const pool = makeAdminPool(passwordHash);
  const origin = await startApp(pool, t);

  const csrf = await getPublicCsrf(origin);
  const login = await fetch(`${origin}/api/admin/login`, {
    method: 'POST', headers: postHeaders(csrf),
    body: JSON.stringify({ email: ' OWNER@EXAMPLE.TEST ', password }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.deepEqual(loginBody.admin, {
    id: '31', email: 'owner@example.test', fullName: 'مالك المنصة', role: 'owner',
  });
  assert.equal('passwordHash' in loginBody.admin, false);
  assert.ok(loginBody.csrfToken);
  assert.equal(pool.state.sessions.size, 1);

  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, new RegExp(`^${security.ADMIN_COOKIE}=`));
  assert.match(setCookie, /Max-Age=28800/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=None/i);
  const adminCookie = setCookie.split(';')[0];

  const me = await fetch(`${origin}/api/admin/me`, { headers: { cookie: adminCookie } });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.deepEqual(meBody.admin, loginBody.admin);
  assert.equal(meBody.csrfToken, loginBody.csrfToken);

  const invalidLogout = await fetch(`${origin}/api/admin/logout`, {
    method: 'POST', headers: { cookie: adminCookie },
  });
  assert.equal(invalidLogout.status, 403);
  assert.equal(pool.state.sessions.size, 1);

  const logout = await fetch(`${origin}/api/admin/logout`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': loginBody.csrfToken },
    body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });
  assert.equal(pool.state.sessions.size, 0);

  const afterLogout = await fetch(`${origin}/api/admin/me`, { headers: { cookie: adminCookie } });
  assert.equal(afterLogout.status, 401);
});

test('admin login requires CSRF and returns a generic error with rate limiting after five failures', async (t) => {
  const passwordHash = await security.hashPassword('Safe-Owner-Test-Password-47!');
  const pool = makeAdminPool(passwordHash);
  const origin = await startApp(pool, t);

  const missingCsrf = await fetch(`${origin}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'wrong-password' }),
  });
  assert.equal(missingCsrf.status, 403);

  const csrf = await getPublicCsrf(origin);
  const wrongPassword = 'Wrong-Owner-Password-000!';
  const first = await fetch(`${origin}/api/admin/login`, {
    method: 'POST', headers: postHeaders(csrf),
    body: JSON.stringify({ email: 'owner@example.test', password: wrongPassword }),
  });
  assert.equal(first.status, 401);
  const firstBody = await first.json();

  const unknownEmail = await fetch(`${origin}/api/admin/login`, {
    method: 'POST', headers: postHeaders(csrf),
    body: JSON.stringify({ email: 'not-an-owner@example.test', password: wrongPassword }),
  });
  assert.equal(unknownEmail.status, 401);
  assert.deepEqual(await unknownEmail.json(), firstBody);

  for (let index = 0; index < 4; index += 1) {
    const response = await fetch(`${origin}/api/admin/login`, {
      method: 'POST', headers: postHeaders(csrf),
      body: JSON.stringify({ email: 'owner@example.test', password: wrongPassword }),
    });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(`${origin}/api/admin/login`, {
    method: 'POST', headers: postHeaders(csrf),
    body: JSON.stringify({ email: 'owner@example.test', password: wrongPassword }),
  });
  assert.equal(limited.status, 429);
  assert.equal(pool.state.attempts.filter((item) => item.email === 'owner@example.test').length, 5);
  assert.ok(pool.state.calls.every((call) => !call.params.includes(wrongPassword)), 'passwords must never be stored or passed to SQL');
});

test('non-owner accounts cannot log in or retain administrator sessions', async (t) => {
  const password = 'Safe-Owner-Test-Password-47!';
  const pool = makeAdminPool(await security.hashPassword(password));
  pool.state.account.role = 'admin';
  const origin = await startApp(pool, t);
  const csrf = await getPublicCsrf(origin);
  const response = await fetch(`${origin}/api/admin/login`, {
    method: 'POST', headers: postHeaders(csrf),
    body: JSON.stringify({ email: 'owner@example.test', password }),
  });
  assert.equal(response.status, 401);
  assert.equal(pool.state.sessions.size, 0);

  const token = security.randomToken();
  const tokenHash = security.hashOpaqueToken(token);
  pool.state.sessions.set(tokenHash, { ...pool.state.account, tokenHash, csrfToken: 'test-csrf' });
  const me = await fetch(`${origin}/api/admin/me`, {
    headers: { cookie: `${security.ADMIN_COOKIE}=${token}` },
  });
  assert.equal(me.status, 401);
});
