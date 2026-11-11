import { Router } from 'express';
import { ADMIN_ROLES, requireAdmin } from '../auth/admin.js';
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
import { HUB_TIME_ZONE, hubDay, sessionSecondsSql, timerStartedAt } from '../time.js';

const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const ADMIN_MAX_LOGIN_ATTEMPTS = 5;
const SUB_ADMIN_MIN_PASSWORD_LENGTH = 12;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+?[0-9 ()-]{7,32}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
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

function publicSessionRow(row) {
  const { storedSeconds, segmentStartedAt, ...session } = row;
  return {
    ...session, id: String(row.id), studentId: String(row.studentId),
    durationSeconds: Number(row.durationSeconds || 0),
    timerStartedAt: timerStartedAt({ status: row.status, startedAt: row.startedAt, segmentStartedAt, durationSeconds: storedSeconds }),
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
      return res.status(403).json({ error: 'Only the platform owner can do this. Sub-admins have view-only access.', code: 'OWNER_REQUIRED' });
    }
    return next();
  };

  router.post('/login', requirePublicCsrf, async (req, res, next) => {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || email.length > 254 || !password || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Enter a valid email address and password.', code: 'INVALID_CREDENTIALS' });
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
        return res.status(429).json({ error: 'Too many sign-in attempts. Wait a few minutes and try again.', code: 'ADMIN_LOGIN_RATE_LIMITED' });
      }

      const [adminRows] = await pool.execute(`
        SELECT id, open_id AS openId, email, full_name AS fullName,
               password_hash AS passwordHash, admin_role AS role
        FROM admins
        WHERE email_normalized = ? AND is_active = TRUE AND admin_role IN ('owner', 'viewer')
        LIMIT 1
      `, [email]);
      const admin = adminRows[0] || null;
      const comparisonHash = admin?.passwordHash || await getDummyPasswordHash();
      const passwordMatches = await verifyPassword(password, comparisonHash);
      if (!admin || !ADMIN_ROLES.includes(admin.role) || !admin.passwordHash || !passwordMatches) {
        await pool.execute(`
          INSERT INTO admin_login_attempts (email_normalized, source_hash, attempted_at)
          VALUES (?, ?, UTC_TIMESTAMP(3))
        `, [email, sourceHash]);
        return res.status(401).json({ error: 'The email or password is incorrect.', code: 'ADMIN_CREDENTIALS_INVALID' });
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

  router.get('/study-counter/archive', requireAdminAuth, async (_req, res, next) => {
    try { return res.json({ archive: await listStudyCounterArchive(pool) }); }
    catch (error) { return next(error); }
  });

  router.post('/study-counter/reset', requireAdminAuth, requireOwnerAuth, requireSessionCsrf, async (req, res, next) => {
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Confirm that you want to start a new counting period.', code: 'COUNTER_RESET_CONFIRMATION_REQUIRED' });
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
               COALESCE(SUM(CASE WHEN session.id IS NULL THEN 0 ELSE ${sessionSecondsSql()} END), 0) AS totalSeconds
        FROM students AS student
        LEFT JOIN study_sessions AS session ON session.student_id = student.id AND session.archived_at IS NULL
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
               DATE_FORMAT(session.segment_started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS segmentStartedAt,
               session.status, session.duration_seconds AS storedSeconds,
               ${sessionSecondsSql()} AS durationSeconds
        FROM study_sessions AS session
        JOIN students AS student ON student.id = session.student_id
        WHERE (? = 'all' OR session.status = ?)
          AND session.archived_at IS NULL
          AND (? = '' OR session.student_id = NULLIF(?, '')::bigint)
        ORDER BY (session.status = 'active') DESC, session.started_at DESC
        LIMIT 1000
      `, [status, status, studentId, studentId]);
      return res.json({ sessions: rows.map(publicSessionRow) });
    } catch (error) { return next(error); }
  });

  router.post('/sessions/:id/close', requireAdminAuth, requireOwnerAuth, requireSessionCsrf, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid session id.', code: 'INVALID_SESSION_ID' });
    try {
      const closed = await inTransaction(pool, async (connection) => {
        const [result] = await connection.execute(`
          UPDATE study_sessions
          SET ended_at = UTC_TIMESTAMP(3),
              duration_seconds = ${sessionSecondsSql('')},
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

  // ---- Daily activity archive (read-only; sub-admins may view it) ----
  // Every study day, archived or not, grouped by calendar day in the hub's
  // time zone, plus the counter periods ("months") with their totals.
  router.get('/archive/days', requireAdminAuth, async (_req, res, next) => {
    try {
      const [rows] = await pool.execute(`
        SELECT to_char(session.started_at AT TIME ZONE ?, 'YYYY-MM-DD') AS day,
               COUNT(*) AS sessionCount,
               COUNT(DISTINCT session.student_id) AS studentCount,
               COALESCE(SUM(${sessionSecondsSql()}), 0) AS totalSeconds
        FROM study_sessions AS session
        GROUP BY 1
        ORDER BY 1 ASC
        LIMIT 5000
      `, [HUB_TIME_ZONE]);
      const [archived, counter] = await Promise.all([listStudyCounterArchive(pool), getStudyCounterOverview(pool)]);
      const days = rows.map((row) => ({
        day: row.day,
        sessionCount: Number(row.sessionCount || 0),
        studentCount: Number(row.studentCount || 0),
        totalSeconds: Number(row.totalSeconds || 0),
      }));
      const today = hubDay(new Date());
      const firstDay = days[0]?.day || today;
      const current = {
        id: 'current', current: true,
        periodStartedAt: counter.counterResetAt, periodEndedAt: null,
        startDay: counter.counterResetAt ? hubDay(counter.counterResetAt) : firstDay,
        endDay: today,
        sessionCount: counter.completedSessionCount + counter.activeSessionCount,
        totalSeconds: counter.totalSeconds,
      };
      const periods = [current, ...archived.map((period) => ({ ...period, current: false }))];
      // The first period has no start: it begins with the first study day.
      for (const period of periods) {
        if (!period.startDay) period.startDay = period.firstDay || firstDay;
        if (period.startDay > period.endDay) period.startDay = period.endDay;
      }
      return res.json({ timeZone: HUB_TIME_ZONE, today, firstDay: firstDay < today ? firstDay : today, days, periods });
    } catch (error) { return next(error); }
  });

  router.get('/archive/days/:day', requireAdminAuth, async (req, res, next) => {
    const day = String(req.params.day || '');
    if (!datePattern.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
      return res.status(400).json({ error: 'Choose a valid day (YYYY-MM-DD).', code: 'INVALID_DAY' });
    }
    try {
      const [rows] = await pool.execute(`
        SELECT session.id, session.student_id AS studentId,
               student.full_name AS studentName, student.email,
               DATE_FORMAT(session.started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS startedAt,
               DATE_FORMAT(session.ended_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS endedAt,
               DATE_FORMAT(session.segment_started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS segmentStartedAt,
               session.status, session.duration_seconds AS storedSeconds,
               ${sessionSecondsSql()} AS durationSeconds
        FROM study_sessions AS session
        JOIN students AS student ON student.id = session.student_id
        WHERE to_char(session.started_at AT TIME ZONE ?, 'YYYY-MM-DD') = ?
        ORDER BY session.started_at ASC
        LIMIT 2000
      `, [HUB_TIME_ZONE, day]);
      return res.json({ day, timeZone: HUB_TIME_ZONE, sessions: rows.map(publicSessionRow) });
    } catch (error) { return next(error); }
  });

  // ---- Student account management (owner only) ----
  router.patch('/students/:id', requireAdminAuth, requireOwnerAuth, requireSessionCsrf, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid student id.', code: 'INVALID_STUDENT_ID' });
    const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : '';
    const email = normalizeEmail(req.body?.email);
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (fullName.length < 2 || fullName.length > 160) return res.status(400).json({ error: 'Enter the student\'s full name.', code: 'INVALID_NAME' });
    if (!emailPattern.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.', code: 'INVALID_EMAIL' });
    if (!phonePattern.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number.', code: 'INVALID_PHONE' });
    const passwordBytes = Buffer.byteLength(password, 'utf8');
    if (password && (passwordBytes < 8 || passwordBytes > 72)) {
      return res.status(400).json({ error: 'Use a password between 8 and 72 bytes, or leave it empty to keep the current one.', code: 'INVALID_PASSWORD' });
    }
    try {
      const passwordHash = password ? await hashPassword(password) : null;
      const updated = await inTransaction(pool, async (connection) => {
        const [result] = await connection.execute(`
          UPDATE students
          SET full_name = ?, email = ?, email_normalized = ?, phone = ?, updated_at = UTC_TIMESTAMP(3)
          WHERE id = ?
        `, [fullName, email, email, phone, req.params.id]);
        if (!result.affectedRows) return false;
        if (passwordHash) {
          await connection.execute('UPDATE students SET password_hash = ? WHERE id = ?', [passwordHash, req.params.id]);
          // A new password signs the student out everywhere. Their study
          // session stays active and is resumed when they sign in again.
          await connection.execute('DELETE FROM student_auth_sessions WHERE student_id = ?', [req.params.id]);
        }
        return true;
      });
      if (!updated) return res.status(404).json({ error: 'Student not found.', code: 'STUDENT_NOT_FOUND' });
      return res.json({
        student: { id: req.params.id, fullName, email, phone },
        passwordChanged: Boolean(passwordHash),
      });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Another student already uses this email.', code: 'EMAIL_EXISTS' });
      }
      return next(error);
    }
  });

  router.delete('/students/:id', requireAdminAuth, requireOwnerAuth, requireSessionCsrf, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid student id.', code: 'INVALID_STUDENT_ID' });
    try {
      // Study sessions, sign-ins and messages are removed with the student (ON DELETE CASCADE).
      const [result] = await pool.execute('DELETE FROM students WHERE id = ?', [req.params.id]);
      if (!result.affectedRows) return res.status(404).json({ error: 'Student not found.', code: 'STUDENT_NOT_FOUND' });
      return res.json({ ok: true, id: req.params.id });
    } catch (error) { return next(error); }
  });

  router.get('/sub-admins', requireAdminAuth, requireOwnerAuth, async (_req, res, next) => {
    try {
      const [rows] = await pool.query(`
        SELECT id, full_name AS fullName, email,
               DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
               DATE_FORMAT(last_login_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS lastLoginAt
        FROM admins
        WHERE admin_role = 'viewer'
        ORDER BY created_at DESC
        LIMIT 200
      `);
      return res.json({ subAdmins: rows.map((row) => ({ ...row, id: String(row.id), role: 'viewer' })) });
    } catch (error) { return next(error); }
  });

  router.post('/sub-admins', requireAdminAuth, requireOwnerAuth, requireSessionCsrf, async (req, res, next) => {
    const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : '';
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (fullName.length < 2 || fullName.length > 160) {
      return res.status(400).json({ error: 'Enter the sub-admin\'s full name.', code: 'INVALID_NAME' });
    }
    if (!emailPattern.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Enter a valid email address.', code: 'INVALID_EMAIL' });
    }
    if (Array.from(password).length < SUB_ADMIN_MIN_PASSWORD_LENGTH || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({
        error: `Use a password of at least ${SUB_ADMIN_MIN_PASSWORD_LENGTH} characters (72 bytes maximum).`,
        code: 'INVALID_PASSWORD',
      });
    }
    try {
      const passwordHash = await hashPassword(password);
      const [result] = await pool.execute(`
        INSERT INTO admins (
          open_id, email, email_normalized, full_name, password_hash,
          admin_role, is_active, created_at, last_login_at, created_by_admin_id
        )
        VALUES (?, ?, ?, ?, ?, 'viewer', TRUE, UTC_TIMESTAMP(3), NULL, ?)
      `, [`local:${randomToken(24)}`, email, email, fullName, passwordHash, req.admin.id]);
      return res.status(201).json({
        subAdmin: { id: String(result.insertId), fullName, email, role: 'viewer', lastLoginAt: null },
      });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'An administrator with this email already exists.', code: 'ADMIN_EMAIL_EXISTS' });
      }
      return next(error);
    }
  });

  router.delete('/sub-admins/:id', requireAdminAuth, requireOwnerAuth, requireSessionCsrf, async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid sub-admin id.', code: 'INVALID_ADMIN_ID' });
    try {
      // Only viewer accounts can be removed; their sign-in sessions cascade away,
      // so a removed sub-admin is signed out on their next request.
      const [result] = await pool.execute(
        "DELETE FROM admins WHERE id = ? AND admin_role = 'viewer'",
        [req.params.id],
      );
      if (!result.affectedRows) return res.status(404).json({ error: 'Sub-admin not found.', code: 'SUB_ADMIN_NOT_FOUND' });
      return res.json({ ok: true, id: req.params.id });
    } catch (error) { return next(error); }
  });

  return router;
}
