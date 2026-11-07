import { hashOpaqueToken, getCookie, STUDENT_COOKIE } from '../security.js';

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
          student.phone AS phone
        FROM student_auth_sessions AS auth
        JOIN students AS student ON student.id = auth.student_id
        WHERE auth.token_hash = ? AND auth.expires_at > UTC_TIMESTAMP(3)
        LIMIT 1
      `, [tokenHash]);

      if (!rows.length) {
        return res.status(401).json({ error: 'Your sign-in session has ended. Please sign in again.', code: 'STUDENT_SESSION_EXPIRED' });
      }
      req.student = rows[0];
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
