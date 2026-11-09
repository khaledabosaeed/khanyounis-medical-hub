import { hashOpaqueToken, getCookie, setCookie, STUDENT_COOKIE } from '../security.js';

// Student sign-ins last 400 days (the longest cookie lifetime browsers allow)
// and slide forward at most once a day while the student uses the hub, so an
// active student is never signed out by expiry.
export const STUDENT_SESSION_SECONDS = 400 * 24 * 60 * 60;
const RENEW_AFTER_SECONDS = 24 * 60 * 60;

export function requireStudent(pool) {
  return async function studentAuthentication(req, res, next) {
    const token = getCookie(req, STUDENT_COOKIE);
    if (!token) return res.status(401).json({ error: 'Please sign in to continue.', code: 'STUDENT_LOGIN_REQUIRED' });

    try {
      const tokenHash = hashOpaqueToken(token);
      const [rows] = await pool.execute(`
        SELECT
          auth.token_hash AS tokenHash,
          auth.csrf_token AS csrfToken,
          auth.current_study_session_id AS currentStudySessionId,
          student.id AS id,
          student.full_name AS fullName,
          student.email AS email,
          student.phone AS phone,
          (auth.expires_at < DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)) AS needsRenewal
        FROM student_auth_sessions AS auth
        JOIN students AS student ON student.id = auth.student_id
        WHERE auth.token_hash = ? AND auth.expires_at > UTC_TIMESTAMP(3)
        LIMIT 1
      `, [STUDENT_SESSION_SECONDS - RENEW_AFTER_SECONDS, tokenHash]);

      if (!rows.length) {
        return res.status(401).json({ error: 'Your sign-in session has ended. Please sign in again.', code: 'STUDENT_SESSION_EXPIRED' });
      }
      const { needsRenewal, ...student } = rows[0];
      if (needsRenewal === true) {
        await pool.execute(
          'UPDATE student_auth_sessions SET expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND) WHERE token_hash = ?',
          [STUDENT_SESSION_SECONDS, tokenHash],
        );
        setCookie(res, STUDENT_COOKIE, token, { maxAge: STUDENT_SESSION_SECONDS * 1000 });
      }
      req.student = student;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
