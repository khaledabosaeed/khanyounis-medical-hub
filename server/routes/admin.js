import { Router } from 'express';
import { requireAdmin } from '../auth/admin.js';
import {
  ADMIN_COOKIE,
  clearCookie,
  createCsrfToken,
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  randomToken,
  setCookie,
  verifyPassword,
} from '../security.js';
import { inTransaction } from '../db/transaction.js';
import { getStudyCounterOverview, listStudyCounterArchive, resetStudyCounter } from '../admin-counter.js';

const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const ADMIN_MAX_LOGIN_ATTEMPTS = 5;
let dummyPasswordHashPromise;

function validId(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
}

function adminProfile(admin) {
  return {
    id: String(admin.id),
    email: admin.email,
    fullName: admin.fullName,
    role: admin.role,
  };
}

function getDummyPasswordHash() {
  if (!dummyPasswordHashPromise) dummyPasswordHashPromise = hashPassword(randomToken(48));
  return dummyPasswordHashPromise;
}

export function createAdminRouter({ pool, requirePublicCsrf, requireSessionCsrf }) {
  const router = Router();
  const requireAdminAuth = requireAdmin(pool);
  const requireOwnerAuth = (req, res, next) => {
    if (req.admin?.role !== 'owner') {
      return res.status(403).json({ error: 'هذه العملية متاحة لمالك المنصة فقط.', code: 'OWNER_REQUIRED' });
    }
    return next();
  };

  router.post('/login', requirePublicCsrf, async (req, res, next) => {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || email.length > 254 || !password || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'أدخل البريد الإلكتروني وكلمة المرور بصورة صحيحة.', code: 'INVALID_CREDENTIALS' });
    }

    const sourceHash = hashOpaqueToken(String(req.ip || req.socket?.remoteAddress || 'unknown'));
    try {
      await pool.execute(`
        DELETE FROM admin_login_attempts
        WHERE attempted_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY)
      `);
      const [attemptRows] = await pool.execute(`
        SELECT COUNT(*) AS attemptCount
        FROM admin_login_attempts
        WHERE email_normalized = ?
          AND source_hash = ?
          AND attempted_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 15 MINUTE)
      `, [email, sourceHash]);
      if (Number(attemptRows[0]?.attemptCount || 0) >= ADMIN_MAX_LOGIN_ATTEMPTS) {
        return res.status(429).json({ error: 'تعذر تسجيل الدخول الآن. انتظر قليلًا ثم حاول مجددًا.', code: 'ADMIN_LOGIN_RATE_LIMITED' });
      }

      const [adminRows] = await pool.execute(`
        SELECT id, open_id AS openId, email, full_name AS fullName,
               password_hash AS passwordHash, admin_role AS role
        FROM admins
        WHERE email_normalized = ? AND is_active = TRUE AND admin_role = 'owner'
        LIMIT 1
      `, [email]);
      const admin = adminRows[0] || null;
      const comparisonHash = admin?.passwordHash || await getDummyPasswordHash();
      const passwordMatches = await verifyPassword(password, comparisonHash);
      if (!admin || admin.role !== 'owner' || !admin.passwordHash || !passwordMatches) {
        await pool.execute(`
          INSERT INTO admin_login_attempts (email_normalized, source_hash, attempted_at)
          VALUES (?, ?, UTC_TIMESTAMP(3))
        `, [email, sourceHash]);
        return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.', code: 'ADMIN_CREDENTIALS_INVALID' });
      }

      await pool.execute(
        'DELETE FROM admin_login_attempts WHERE email_normalized = ? AND source_hash = ?',
        [email, sourceHash],
      );
      await pool.execute('UPDATE admins SET last_login_at = UTC_TIMESTAMP(3) WHERE id = ?', [admin.id]);

      const sessionToken = randomToken();
      const csrfToken = createCsrfToken();
      await pool.execute(`
        INSERT INTO admin_auth_sessions (token_hash, admin_id, csrf_token, created_at, expires_at)
        VALUES (?, ?, ?, UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 8 HOUR))
      `, [hashOpaqueToken(sessionToken), admin.id, csrfToken]);
      setCookie(res, ADMIN_COOKIE, sessionToken, { maxAge: ADMIN_SESSION_MS });
      return res.json({ admin: adminProfile(admin), csrfToken });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', requireAdminAuth, (req, res) => {
    return res.json({ admin: adminProfile(req.admin), csrfToken: req.admin.csrfToken });
  });

  router.post('/logout', requireAdminAuth, requireSessionCsrf, async (req, res, next) => {
    try {
      await pool.execute(
        'DELETE FROM admin_auth_sessions WHERE token_hash = ? AND admin_id = ?',
        [req.admin.tokenHash, req.admin.id],
      );
      clearCookie(res, ADMIN_COOKIE);
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/overview', requireAdminAuth, async (req, res, next) => {
    try {
      const [[students]] = await pool.query('SELECT COUNT(*) AS studentCount FROM students');
      const counter = await getStudyCounterOverview(pool);
      const result = {
        studentCount: Number(students.studentCount || 0),
        ...counter,
      };
      if (req.admin.role === 'owner') {
        const [[messages]] = await pool.query('SELECT COUNT(*) AS messageCount FROM messages');
        result.messageCount = Number(messages.messageCount || 0);
      }
      return res.json(result);
    } catch (error) { return next(error); }
  });

  router.get('/study-counter/archive', requireAdminAuth, requireOwnerAuth, async (_req, res, next) => {
    try { return res.json({ archive: await listStudyCounterArchive(pool) }); }
    catch (error) { return next(error); }
  });

  router.post('/study-counter/reset', requireAdminAuth, requireOwnerAuth, requireSessionCsrf, async (req, res, next) => {
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'يلزم تأكيد بدء فترة احتساب جديدة.', code: 'COUNTER_RESET_CONFIRMATION_REQUIRED' });
    }
    try { return res.json(await resetStudyCounter(pool, req.admin.id)); }
    catch (error) { return next(error); }
  });

  router.get('/students', requireAdminAuth, async (req, res, next) => {
    try {
      const search = String(req.query.search || '').trim().slice(0, 120);
      const like = `%${search}%`;
      const [rows] = await pool.execute(`
        SELECT student.id, student.full_name AS fullName, student.email, student.phone,
               DATE_FORMAT(student.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
               COUNT(DISTINCT session.id) AS sessionCount,
               COALESCE(SUM(CASE WHEN session.status = 'completed' THEN session.duration_seconds
                                 WHEN session.status = 'active' THEN TIMESTAMPDIFF(SECOND, session.started_at, UTC_TIMESTAMP(3))
                                 ELSE 0 END), 0) AS totalSeconds
        FROM students AS student
        LEFT JOIN study_sessions AS session ON session.student_id = student.id
        WHERE (? = '' OR student.full_name LIKE ? OR student.email_normalized LIKE ? OR student.phone LIKE ?)
        GROUP BY student.id, student.full_name, student.email, student.phone, student.created_at
        ORDER BY student.full_name ASC LIMIT 500
      `, [search, like, like, like]);
      return res.json({ students: rows.map((row) => ({
        ...row, id: String(row.id), sessionCount: Number(row.sessionCount || 0), totalSeconds: Number(row.totalSeconds || 0),
      })) });
    } catch (error) { return next(error); }
  });

  router.get('/sessions', requireAdminAuth, async (req, res, next) => {
    try {
      const status = String(req.query.status || 'all');
      const studentId = req.query.studentId == null ? '' : String(req.query.studentId);
      if (!['all', 'active', 'completed'].includes(status)) {
        return res.status(400).json({ error: 'Choose active, completed, or all sessions.', code: 'INVALID_STATUS' });
      }
      if (studentId && !validId(studentId)) return res.status(400).json({ error: 'Invalid student id.', code: 'INVALID_STUDENT_ID' });
      const [rows] = await pool.execute(`
        SELECT session.id, session.student_id AS studentId,
               student.full_name AS studentName, student.email, student.phone,
               DATE_FORMAT(session.started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS startedAt,
               DATE_FORMAT(session.ended_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS endedAt,
               session.status,
               CASE WHEN session.status = 'active' THEN TIMESTAMPDIFF(SECOND, session.started_at, UTC_TIMESTAMP(3))
                    ELSE session.duration_seconds END AS durationSeconds
        FROM study_sessions AS session
        JOIN students AS student ON student.id = session.student_id
        WHERE (? = 'all' OR session.status = ?)
          AND (? = '' OR session.student_id = ?)
        ORDER BY (session.status = 'active') DESC, session.started_at DESC
        LIMIT 1000
      `, [status, status, studentId, studentId]);
      return res.json({ sessions: rows.map((row) => ({
        ...row, id: String(row.id), studentId: String(row.studentId), durationSeconds: Number(row.durationSeconds || 0),
      })) });
    } catch (error) { return next(error); }
  });

  router.post('/sessions/:id/close', requireAdminAuth, requireSessionCsrf, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid session id.', code: 'INVALID_SESSION_ID' });
    try {
      const closed = await inTransaction(pool, async (connection) => {
        const [result] = await connection.execute(`
          UPDATE study_sessions
          SET ended_at = UTC_TIMESTAMP(3),
              duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, started_at, UTC_TIMESTAMP(3))),
              status = 'completed'
          WHERE id = ? AND status = 'active'
        `, [req.params.id]);
        if (!result.affectedRows) return false;
        await connection.execute(
          'DELETE FROM student_auth_sessions WHERE current_study_session_id = ?',
          [req.params.id],
        );
        return true;
      });
      if (!closed) return res.status(404).json({ error: 'Active session not found.', code: 'ACTIVE_SESSION_NOT_FOUND' });
      return res.json({ ok: true, sessionId: req.params.id });
    } catch (error) { return next(error); }
  });

  router.get('/messages', requireAdminAuth, requireOwnerAuth, async (_req, res, next) => {
    try {
      const [rows] = await pool.query(`
        SELECT message.id, message.student_id AS studentId,
               student.full_name AS studentName, student.email,
               message.body,
               message.sender_role AS senderRole,
               DATE_FORMAT(message.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
               DATE_FORMAT(message.read_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS readAt,
               message.created_by_admin_open_id AS createdByAdmin
        FROM messages AS message
        JOIN students AS student ON student.id = message.student_id
        ORDER BY message.created_at DESC LIMIT 500
      `);
      return res.json({ messages: rows.map((row) => ({
        ...row, id: String(row.id), studentId: String(row.studentId), createdByAdmin: row.senderRole === 'admin',
      })) });
    } catch (error) { return next(error); }
  });

  router.post('/messages/read', requireAdminAuth, requireOwnerAuth, requireSessionCsrf, async (req, res, next) => {
    const studentId = String(req.body?.studentId || '');
    if (!validId(studentId)) return res.status(400).json({ error: 'Choose a valid student.', code: 'INVALID_STUDENT_ID' });
    try {
      const [result] = await pool.execute(`
        UPDATE messages
        SET read_at = COALESCE(read_at, UTC_TIMESTAMP(3))
        WHERE student_id = ? AND sender_role = 'student' AND read_at IS NULL
      `, [studentId]);
      return res.json({ ok: true, updatedCount: Number(result.affectedRows || 0) });
    } catch (error) { return next(error); }
  });

  router.post('/messages', requireAdminAuth, requireOwnerAuth, requireSessionCsrf, async (req, res, next) => {
    const studentId = String(req.body?.studentId || '');
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!validId(studentId)) return res.status(400).json({ error: 'Choose a valid student.', code: 'INVALID_STUDENT_ID' });
    if (!body || body.length > 4000) return res.status(400).json({ error: 'Message must contain 1 to 4000 characters.', code: 'INVALID_MESSAGE' });
    try {
      const [result] = await pool.execute(`
        INSERT INTO messages (student_id, body, created_at, read_at, sender_role, created_by_admin_open_id)
        VALUES (?, ?, UTC_TIMESTAMP(3), NULL, 'admin', ?)
      `, [studentId, body, req.admin.openId]);
      return res.status(201).json({ ok: true, messageId: String(result.insertId) });
    } catch (error) {
      if (error?.code === 'ER_NO_REFERENCED_ROW_2') return res.status(404).json({ error: 'Student not found.', code: 'STUDENT_NOT_FOUND' });
      return next(error);
    }
  });

  return router;
}
