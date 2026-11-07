import { Router } from 'express';
import { createCsrfToken, getCookie, CSRF_COOKIE, setCookie, verifyCsrfToken } from '../security.js';

export function requirePublicCsrf(req, res, next) {
  const cookieToken = getCookie(req, CSRF_COOKIE);
  const headerToken = req.get('x-csrf-token') || '';
  if (!cookieToken || cookieToken !== headerToken || !verifyCsrfToken(cookieToken)) {
    return res.status(403).json({ error: 'Your security token expired. Refresh the page and try again.', code: 'CSRF_INVALID' });
  }
  return next();
}

export function requireSessionCsrf(req, res, next) {
  const expected = req.student?.csrfToken || req.admin?.csrfToken || req.adminClaims?.csrf;
  const supplied = req.get('x-csrf-token') || '';
  if (expected && supplied !== expected) {
    return res.status(403).json({ error: 'Your security token expired. Refresh the page and try again.', code: 'CSRF_INVALID' });
  }
  return expected ? next() : requirePublicCsrf(req, res, next);
}

export function createCsrfRouter() {
  const router = Router();
  router.get('/csrf', (req, res) => {
    const existing = getCookie(req, CSRF_COOKIE);
    const token = existing && verifyCsrfToken(existing) ? existing : createCsrfToken();
    if (token !== existing) setCookie(res, CSRF_COOKIE, token, { maxAge: 2 * 60 * 60 * 1000 });
    return res.json({ csrfToken: token });
  });
  return router;
}
