import {
  clearCookie,
  hashOpaqueToken,
  hashPassword,
  getCookie,
  ADMIN_COOKIE,
  normalizeEmail,
  randomToken,
} from '../security.js';

const OWNER_BOOTSTRAP_LOCK = 'khanyonis-admin-owner-bootstrap-v1';

function bootstrapError(code) {
  return Object.assign(new Error('Administrator initialization could not be completed'), { code });
}

export async function bootstrapOwnerAccount(pool) {
  let connection;
  let locked = false;
  try {
    const email = normalizeEmail(process.env.KHANYOUNIS_ADMIN_EMAIL);
    if (!email) throw bootstrapError('OWNER_EMAIL_MISSING');

    connection = await pool.getConnection();
    const [lockRows] = await connection.query('SELECT GET_LOCK(?, 20) AS acquired', [OWNER_BOOTSTRAP_LOCK]);
    locked = Number(lockRows[0]?.acquired) === 1;
    if (!locked) throw bootstrapError('OWNER_BOOTSTRAP_LOCK_FAILED');

    const [rows] = await connection.execute(`
      SELECT id, password_hash AS passwordHash,
             email_normalized AS emailNormalized, admin_role AS role
      FROM admins
      WHERE email_normalized = ?
         OR (admin_role = 'owner' AND password_hash IS NOT NULL)
      ORDER BY id
    `, [email]);
    const initializedOwners = rows.filter((row) => row.role === 'owner' && row.passwordHash);
    if (initializedOwners.length > 1 || initializedOwners.some((row) => row.emailNormalized !== email)) {
      throw bootstrapError('OWNER_ALREADY_CONFIGURED');
    }
    const existing = rows.find((row) => row.emailNormalized === email);
    if (existing?.passwordHash) {
      if (existing.role !== 'owner') throw bootstrapError('OWNER_ROLE_MISMATCH');
      return { created: false, reason: 'owner_already_initialized' };
    }

    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || '';
    if (!initialPassword) throw bootstrapError('OWNER_INITIAL_PASSWORD_MISSING');
    if (Array.from(initialPassword).length < 12 || Buffer.byteLength(initialPassword, 'utf8') > 72) {
      throw bootstrapError('OWNER_INITIAL_PASSWORD_INVALID');
    }

    const passwordHash = await hashPassword(initialPassword);
    if (existing) {
      const [result] = await connection.execute(`
        UPDATE admins
        SET password_hash = ?, admin_role = 'owner', is_active = TRUE
        WHERE id = ? AND password_hash IS NULL
      `, [passwordHash, existing.id]);
      if (result.affectedRows !== 1) throw bootstrapError('OWNER_INITIALIZATION_NOT_SAVED');
      return { created: true, reusedAccount: true };
    }

    const [result] = await connection.execute(`
      INSERT INTO admins (
        open_id, email, email_normalized, full_name, password_hash,
        admin_role, is_active, created_at, last_login_at
      )
      VALUES (?, ?, ?, ?, ?, 'owner', TRUE, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    `, [`local:${randomToken(24)}`, email, email, 'Medical Hub Owner', passwordHash]);
    if (result.affectedRows !== 1) throw bootstrapError('OWNER_INITIALIZATION_NOT_SAVED');
    return { created: true, reusedAccount: false };
  } finally {
    // Erase only this process's temporary copy. The platform secret is withdrawn
    // separately, after the persisted account has been verified successfully.
    delete process.env.ADMIN_INITIAL_PASSWORD;
    if (connection) {
      if (locked) {
        try { await connection.query('SELECT RELEASE_LOCK(?)', [OWNER_BOOTSTRAP_LOCK]); } catch {}
      }
      connection.release();
    }
  }
}

export const ADMIN_ROLES = Object.freeze(['owner', 'viewer']);

export function requireAdmin(pool) {
  return async function adminAuthentication(req, res, next) {
    const token = getCookie(req, ADMIN_COOKIE);
    if (!token) return res.status(401).json({ error: 'Please sign in as an administrator to continue.', code: 'ADMIN_LOGIN_REQUIRED' });

    try {
      const tokenHash = hashOpaqueToken(token);
      const [rows] = await pool.execute(`
        SELECT admin.id, admin.open_id AS openId, admin.email,
               admin.full_name AS fullName, admin.admin_role AS role,
               auth.token_hash AS tokenHash,
               auth.csrf_token AS csrfToken
        FROM admin_auth_sessions AS auth
        JOIN admins AS admin ON admin.id = auth.admin_id
        WHERE auth.token_hash = ?
          AND auth.expires_at > UTC_TIMESTAMP(3)
          AND admin.is_active = TRUE AND admin.admin_role IN ('owner', 'viewer')
        LIMIT 1
      `, [tokenHash]);
      if (!rows.length || !ADMIN_ROLES.includes(rows[0].role)) {
        clearCookie(res, ADMIN_COOKIE);
        return res.status(401).json({ error: 'Your administrator session has ended. Please sign in again.', code: 'ADMIN_SESSION_EXPIRED' });
      }
      req.admin = rows[0];
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
