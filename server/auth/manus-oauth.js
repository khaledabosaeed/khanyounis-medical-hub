import { createCsrfToken, getCookie, ADMIN_COOKIE, normalizeEmail, randomToken, setCookie, clearCookie, signPlatformJwt } from '../security.js';

const OAUTH_STATE_COOKIE = 'khanyonis_admin_oauth_state';
const OAUTH_CALLBACK_PATH = '/auth/manus/callback';
const ADMIN_HOME = '/admin';
const MANAGED_APP_ORIGINS = new Set([
  'https://8328-i4cwm7flmdwlqmzbt5wd6-a4ba896a.us1.manus.computer',
  'https://studyhub-wtr2hg8x.manus.space',
]);

function decodeState(value) {
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')); } catch { return null; }
}

function oauthEndpoint(base, method) {
  return `${String(base).replace(/\/+$/, '')}/webdev.v1.WebDevAuthPublicService/${method}`;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok || !data || data.error) throw new Error('Manus OAuth request failed');
  return data;
}

export function parseAllowedOrigin(req) {
  const supplied = req.body?.origin;
  if (typeof supplied !== 'string') return null;
  try {
    const url = new URL(supplied);
    if (url.origin !== supplied || url.username || url.password) return null;
    const configuredOrigins = String(process.env.PUBLIC_APP_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
    const allowedOrigins = new Set([...MANAGED_APP_ORIGINS, ...configuredOrigins]);
    if (!process.env.MANUS_PROJECT_ID) {
      allowedOrigins.add('http://localhost:3000');
      allowedOrigins.add('http://127.0.0.1:3000');
    }
    if (!allowedOrigins.has(url.origin)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function registerManusOAuthRoutes(app, pool, requireCsrf) {
  app.post('/api/admin/oauth/start', requireCsrf, async (req, res, next) => {
    try {
      if (!process.env.MANUS_PROJECT_ID || !process.env.MANUS_OAUTH_PORTAL_URL) {
        return res.status(503).json({ error: 'Manus administrator sign-in is not configured.', code: 'OAUTH_NOT_CONFIGURED' });
      }
      const origin = parseAllowedOrigin(req);
      if (!origin) return res.status(400).json({ error: 'The sign-in origin could not be verified.', code: 'OAUTH_ORIGIN_INVALID' });

      const redirectUri = new URL(OAUTH_CALLBACK_PATH, origin).toString();
      const nonce = randomToken();
      const state = Buffer.from(JSON.stringify({ redirectUri, nonce })).toString('base64');
      setCookie(res, OAUTH_STATE_COOKIE, JSON.stringify({ redirectUri, nonce }), {
        path: OAUTH_CALLBACK_PATH,
        maxAge: 10 * 60 * 1000,
      });

      const portalUrl = `${String(process.env.MANUS_OAUTH_PORTAL_URL).replace(/\/+$/, '')}/app-auth`;
      const authUrl = new URL(portalUrl);
      authUrl.searchParams.set('appId', process.env.MANUS_PROJECT_ID);
      authUrl.searchParams.set('redirectUri', redirectUri);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('responseType', 'code');
      return res.json({ authorizationUrl: authUrl.toString() });
    } catch (error) {
      return next(error);
    }
  });

  app.get(OAUTH_CALLBACK_PATH, async (req, res) => {
    const cookieValue = getCookie(req, OAUTH_STATE_COOKIE);
    clearCookie(res, OAUTH_STATE_COOKIE, { path: OAUTH_CALLBACK_PATH });
    if (req.query.error || !req.query.code || typeof req.query.state !== 'string') {
      return res.redirect(303, `${ADMIN_HOME}/login?error=oauth-denied`);
    }

    let cookieState;
    try { cookieState = JSON.parse(cookieValue); } catch { cookieState = null; }
    const state = decodeState(req.query.state);
    if (!cookieState || !state || !cookieState.nonce || cookieState.nonce !== state.nonce || cookieState.redirectUri !== state.redirectUri) {
      return res.redirect(303, `${ADMIN_HOME}/login?error=oauth-state`);
    }

    try {
      if (!process.env.MANUS_OAUTH_API_URL || !process.env.MANUS_PROJECT_ID || !process.env.MANUS_JWT_SECRET) {
        return res.redirect(303, `${ADMIN_HOME}/login?error=oauth-unavailable`);
      }
      const tokenData = await postJson(oauthEndpoint(process.env.MANUS_OAUTH_API_URL, 'ExchangeToken'), {
        clientId: process.env.MANUS_PROJECT_ID,
        grantType: 'authorization_code',
        code: String(req.query.code),
        redirectUri: state.redirectUri,
      });
      if (typeof tokenData.accessToken !== 'string' || !tokenData.accessToken) {
        return res.redirect(303, `${ADMIN_HOME}/login?error=oauth-token`);
      }

      const identity = await postJson(oauthEndpoint(process.env.MANUS_OAUTH_API_URL, 'GetUserInfo'), {
        accessToken: tokenData.accessToken,
      });
      const email = normalizeEmail(identity.email);
      const allowedEmail = normalizeEmail(process.env.KHANYOUNIS_ADMIN_EMAIL);
      const openId = typeof identity.openId === 'string' ? identity.openId : '';
      if (!allowedEmail || !email || email !== allowedEmail || !openId) {
        return res.redirect(303, `${ADMIN_HOME}/login?error=not-authorized`);
      }

      const [existing] = await pool.execute(
        'SELECT id, open_id AS openId FROM admins WHERE email_normalized = ? LIMIT 1',
        [email],
      );
      if (existing.length && existing[0].openId !== openId) {
        return res.redirect(303, `${ADMIN_HOME}/login?error=admin-account-mismatch`);
      }
      if (!existing.length) {
        await pool.execute(
          'INSERT INTO admins (open_id, email, email_normalized, full_name, created_at, last_login_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))',
          [openId, String(identity.email).trim(), email, String(identity.name || 'Hub Administrator').slice(0, 160)],
        );
      } else {
        await pool.execute(
          'UPDATE admins SET email = ?, full_name = ?, last_login_at = UTC_TIMESTAMP(3) WHERE open_id = ?',
          [String(identity.email).trim(), String(identity.name || 'Hub Administrator').slice(0, 160), openId],
        );
      }

      const issuedAt = Math.floor(Date.now() / 1000);
      const expiresIn = 8 * 60 * 60;
      const sessionToken = signPlatformJwt({
        appId: process.env.MANUS_PROJECT_ID,
        openId,
        email,
        csrf: createCsrfToken(),
        iat: issuedAt,
        exp: issuedAt + expiresIn,
      });
      setCookie(res, ADMIN_COOKIE, sessionToken, { maxAge: expiresIn * 1000 });
      return res.redirect(303, ADMIN_HOME);
    } catch (error) {
      // Never log OAuth codes, access tokens, identity payloads, or the administrator email.
      console.error('Manus administrator OAuth callback failed:', error?.name || 'Error');
      return res.redirect(303, `${ADMIN_HOME}/login?error=oauth-failed`);
    }
  });
}
