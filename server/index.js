import express from 'express';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db/pool.js';
import { migrateDatabase } from './db/migrate.js';
import { bootstrapOwnerAccount } from './auth/admin.js';
import { createHealthRouter } from './health.js';
import { createCsrfRouter, requirePublicCsrf, requireSessionCsrf } from './auth/csrf.js';
import { createStudentRouter } from './routes/student.js';
import { createAdminRouter } from './routes/admin.js';
import { createStaticMiddleware } from './static.js';

const app = express();
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicRoot = resolve(process.env.STATIC_DIR || resolve(root, 'public'));
const port = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '32kb', strict: true }));

app.use('/api', createCsrfRouter());
app.use('/api', createHealthRouter());
app.use('/api/student', createStudentRouter({ pool, requirePublicCsrf, requireSessionCsrf }));
app.use('/api/admin', createAdminRouter({ pool, requirePublicCsrf, requireSessionCsrf }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.', code: 'API_NOT_FOUND' }));

app.use(createStaticMiddleware(publicRoot));
app.get(['/', '/login/khan-younis', '/student', '/admin', '/admin/login'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(resolve(publicRoot, 'index.html'));
});
app.use((_req, res) => res.status(404).type('text/plain').send('Page not found.'));

app.use((error, req, res, _next) => {
  if (res.headersSent) return;
  const status = Number(error?.status) || 500;
  const safeStatus = status >= 400 && status < 500 ? status : 500;
  if (safeStatus >= 500) {
    console.error('Request failed:', { path: req.path, name: error?.name || 'Error', code: error?.code || 'INTERNAL' });
  }
  const message = safeStatus === 500 ? 'Something went wrong. Please try again.' : String(error.message || 'Request failed.');
  return res.status(safeStatus).json({ error: message, code: error.code || (safeStatus === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR') });
});

async function start() {
  await migrateDatabase(pool);
  await bootstrapOwnerAccount(pool);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Khanyonis Medical Hub is listening on 0.0.0.0:${port}`);
  });
  const stop = () => server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

start().catch(async (error) => {
  console.error('Application startup failed:', {
    name: error?.name || 'Error',
    code: error?.code || 'STARTUP_FAILED',
    message: error?.message || 'Unknown startup error',
  });
  try { await pool.end(); } catch {}
  process.exit(1);
});
