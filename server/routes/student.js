import { Router } from 'express';
import { inTransaction } from '../db/transaction.js';
import { requireStudent } from '../auth/student.js';
import { normalizeEmail, hashPassword, verifyPassword, randomToken, hashOpaqueToken, setCookie, clearCookie, STUDENT_COOKIE } from '../security.js';
import { STUDENT_SESSION_SECONDS } from '../auth/student.js';
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+?[0-9 ()-]{7,32}$/;

function publicStudent(student) {
  return { id: String(student.id), fullName: student.fullName, email: student.email, phone: student.phone };
}

function invalidInput(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}

function validateRegistration(body = {}) {
  const fullName = String(body.fullName || '').trim();
  const email = normalizeEmail(body.email);
  const phone = String(body.phone || '').trim();
  const password = typeof body.password === 'string' ? body.password : '';
  if (fullName.length < 2 || fullName.length > 160) throw invalidInput('Enter your full name.');
  if (!emailPattern.test(email) || email.length > 254) throw invalidInput('Enter a valid email address.');
  if (!phonePattern.test(phone)) throw invalidInput('Enter a valid phone number.');
  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (passwordBytes < 8 || passwordBytes > 72) throw invalidInput('Use a password between 8 and 72 bytes.');
  return { fullName, email, phone, password };
}

// Links a new sign-in to the student's study session. If the student already
// has an active study session (for example after their sign-in was lost or
// they signed in on another device), that session is resumed instead of a
// second one being started. The student row is locked so two simultaneous
// logins cannot both create a session.
async function attachStudyAndAuthSession(connection, studentId, tokenHash, csrfToken) {
  await connection.execute('SELECT id FROM students WHERE id = ? FOR UPDATE', [studentId]);
  const [activeRows] = await connection.execute(`
    SELECT id FROM study_sessions
    WHERE student_id = ? AND status = 'active'
    ORDER BY started_at DESC
    LIMIT 1
  `, [studentId]);
  let studySessionId = activeRows[0]?.id == null ? null : String(activeRows[0].id);
  const resumed = studySessionId !== null;
  if (!resumed) {
    const [sessionResult] = await connection.execute(`
      INSERT INTO study_sessions (student_id, started_at, status, created_at)
      VALUES (?, UTC_TIMESTAMP(3), 'active', UTC_TIMESTAMP(3))
    `, [studentId]);
    studySessionId = String(sessionResult.insertId);
  }
  await connection.execute(`
    INSERT INTO student_auth_sessions
      (token_hash, student_id, current_study_session_id, csrf_token, created_at, expires_at)
    VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND))
  `, [tokenHash, studentId, studySessionId, csrfToken, STUDENT_SESSION_SECONDS]);
  const [rows] = await connection.execute(`
    SELECT id, DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS startedAt,
           status, duration_seconds AS durationSeconds
    FROM study_sessions WHERE id = ? AND student_id = ? LIMIT 1
  `, [studySessionId, studentId]);
  return { ...rows[0], id: String(rows[0]?.id ?? studySessionId), resumed };
}

async function beginStudentSession(pool, studentId) {
  const token = randomToken();
  const csrfToken = randomToken();
  const tokenHash = hashOpaqueToken(token);
  const studySession = await inTransaction(pool, (connection) =>
    attachStudyAndAuthSession(connection, studentId, tokenHash, csrfToken));
  return { token, csrfToken, studySession };
}

function setStudentCookie(res, token) {
  // Always persistent: the sign-in survives closing the browser, and the
  // server extends it while the student keeps using the hub.
  setCookie(res, STUDENT_COOKIE, token, { maxAge: STUDENT_SESSION_SECONDS * 1000 });
}

export function createStudentRouter({ pool, requirePublicCsrf, requireSessionCsrf }) {
  const router = Router();
  const requireStudentAuth = requireStudent(pool);

  router.post('/register', requirePublicCsrf, async (req, res, next) => {
    try {
      const registration = validateRegistration(req.body);
      const passwordHash = await hashPassword(registration.password);
      const token = randomToken();
      const csrfToken = randomToken();
      const tokenHash = hashOpaqueToken(token);
      const created = await inTransaction(pool, async (connection) => {
        const [insert] = await connection.execute(`
          INSERT INTO students (full_name, email, email_normalized, phone, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
        `, [registration.fullName, registration.email, registration.email, registration.phone, passwordHash]);
        const student = { id: String(insert.insertId), ...registration };
        const studySession = await attachStudyAndAuthSession(connection, student.id, tokenHash, csrfToken);
        return { student, studySession };
      });
      setStudentCookie(res, token);
      return res.status(201).json({ student: publicStudent(created.student), studySession: created.studySession, csrfToken });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'An account with this email already exists. Please log in instead.', code: 'EMAIL_EXISTS' });
      }
      return next(error);
    }
  });

  router.post('/login', requirePublicCsrf, async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!emailPattern.test(email) || !password) {
        return res.status(400).json({ error: 'Enter your email and password.', code: 'VALIDATION_ERROR' });
      }
      const [rows] = await pool.execute(`
        SELECT id, full_name AS fullName, email, phone, password_hash AS passwordHash
        FROM students WHERE email_normalized = ? LIMIT 1
      `, [email]);
      if (!rows.length || !(await verifyPassword(password, rows[0].passwordHash))) {
        return res.status(401).json({ error: 'Email or password is incorrect.', code: 'LOGIN_INVALID' });
      }
      const student = rows[0];
      const login = await beginStudentSession(pool, student.id);
      setStudentCookie(res, login.token);
      return res.json({
        student: publicStudent(student), studySession: login.studySession,
        resumedSession: login.studySession.resumed, csrfToken: login.csrfToken,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', requireStudentAuth, async (req, res, next) => {
    try {
      const [sessionRows] = await pool.execute(`
        SELECT id, DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS startedAt,
               DATE_FORMAT(ended_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS endedAt,
               status, duration_seconds AS durationSeconds
        FROM study_sessions
        WHERE student_id = ? AND status = 'active'
        ORDER BY started_at DESC
      `, [req.student.id]);
      const [totals] = await pool.execute(`
        SELECT COALESCE(SUM(CASE
          WHEN status = 'completed' THEN duration_seconds
          ELSE TIMESTAMPDIFF(SECOND, started_at, UTC_TIMESTAMP(3))
        END), 0) AS totalSeconds
        FROM study_sessions WHERE student_id = ?
      `, [req.student.id]);
      const [unread] = await pool.execute(
        "SELECT COUNT(*) AS unreadCount FROM messages WHERE student_id = ? AND sender_role = 'admin' AND read_at IS NULL",
        [req.student.id],
      );
      const activeSessions = sessionRows.map((row) => ({
        id: String(row.id), startedAt: row.startedAt, endedAt: row.endedAt,
        status: row.status, durationSeconds: Number(row.durationSeconds || 0),
      }));
      const currentId = req.student.currentStudySessionId == null ? null : String(req.student.currentStudySessionId);
      const currentSession = activeSessions.find((session) => session.id === currentId) || activeSessions[0] || null;
      return res.json({
        student: publicStudent(req.student), currentSession, activeSessions,
        totalSeconds: Number(totals[0]?.totalSeconds || 0),
        unreadMessages: Number(unread[0]?.unreadCount || 0), csrfToken: req.student.csrfToken,
      });
    } catch (error) { return next(error); }
  });

  router.get('/session-status', requireStudentAuth, async (req, res, next) => {
    try {
      let studySessionStatus = null;
      if (req.student.currentStudySessionId != null) {
        const [rows] = await pool.execute(`
          SELECT status
          FROM study_sessions
          WHERE id = ? AND student_id = ?
          LIMIT 1
        `, [req.student.currentStudySessionId, req.student.id]);
        studySessionStatus = rows[0]?.status || null;
      }
      if (studySessionStatus !== 'active') {
        await pool.execute('DELETE FROM student_auth_sessions WHERE token_hash = ?', [req.student.tokenHash]);
        clearCookie(res, STUDENT_COOKIE);
        return res.status(401).json({
          error: 'Your study session has ended. Please sign in again.',
          code: 'STUDENT_STUDY_SESSION_CLOSED',
        });
      }
      return res.json({ active: true });
    } catch (error) { return next(error); }
  });

  router.get('/sessions', requireStudentAuth, async (req, res, next) => {
    try {
      const [rows] = await pool.execute(`
        SELECT id, DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS startedAt,
               DATE_FORMAT(ended_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS endedAt,
               status, duration_seconds AS durationSeconds
        FROM study_sessions WHERE student_id = ? ORDER BY started_at DESC LIMIT 250
      `, [req.student.id]);
      return res.json({ sessions: rows.map((row) => ({ ...row, id: String(row.id), durationSeconds: Number(row.durationSeconds || 0) })) });
    } catch (error) { return next(error); }
  });

  router.post('/logout', requireStudentAuth, requireSessionCsrf, async (req, res, next) => {
    try {
      await inTransaction(pool, async (connection) => {
        if (req.student.currentStudySessionId != null) {
          await connection.execute(`
            UPDATE study_sessions
            SET ended_at = UTC_TIMESTAMP(3),
                duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, started_at, UTC_TIMESTAMP(3))),
                status = 'completed'
            WHERE id = ? AND student_id = ? AND status = 'active'
          `, [req.student.currentStudySessionId, req.student.id]);
          // Other devices attached to the same study session are signed out too.
          await connection.execute(
            'DELETE FROM student_auth_sessions WHERE current_study_session_id = ? AND student_id = ?',
            [req.student.currentStudySessionId, req.student.id],
          );
        }
        await connection.execute('DELETE FROM student_auth_sessions WHERE token_hash = ?', [req.student.tokenHash]);
      });
      clearCookie(res, STUDENT_COOKIE);
      return res.json({ ok: true });
    } catch (error) { return next(error); }
  });

  router.post('/messages', requireStudentAuth, requireSessionCsrf, async (req, res, next) => {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body || body.length > 4000) {
      return res.status(400).json({ error: 'Message must contain 1 to 4000 characters.', code: 'INVALID_MESSAGE' });
    }
    try {
      const [result] = await pool.execute(`
        INSERT INTO messages (student_id, body, created_at, read_at, sender_role, created_by_admin_open_id)
        VALUES (?, ?, UTC_TIMESTAMP(3), NULL, 'student', NULL)
      `, [req.student.id, body]);
      return res.status(201).json({ ok: true, messageId: String(result.insertId) });
    } catch (error) {
      if (error?.code === 'ER_NO_REFERENCED_ROW_2') return res.status(404).json({ error: 'Student not found.', code: 'STUDENT_NOT_FOUND' });
      return next(error);
    }
  });

  // Messages are marked read explicitly (opening a notification, focusing the
  // reply box, or replying) so polling the conversation keeps unread ones visible.
  router.post('/messages/read', requireStudentAuth, requireSessionCsrf, async (req, res, next) => {
    try {
      const [result] = await pool.execute("UPDATE messages SET read_at = COALESCE(read_at, UTC_TIMESTAMP(3)) WHERE student_id = ? AND sender_role = 'admin' AND read_at IS NULL", [req.student.id]);
      return res.json({ ok: true, updatedCount: Number(result.affectedRows || 0) });
    } catch (error) { return next(error); }
  });

  router.get('/messages', requireStudentAuth, async (req, res, next) => {
    try {
      const [rows] = await pool.execute(`
        SELECT id, body,
               DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
               DATE_FORMAT(read_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS readAt,
               sender_role AS senderRole
        FROM messages WHERE student_id = ? ORDER BY created_at DESC LIMIT 100
      `, [req.student.id]);
      return res.json({ messages: rows.map((row) => ({
        ...row, id: String(row.id), createdByAdmin: row.senderRole === 'admin',
      })) });
    } catch (error) { return next(error); }
  });

  return router;
}
