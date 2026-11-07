import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceFiles = [
  'server/index.js', 'server/security.js', 'server/time.js', 'server/static.js', 'server/admin-counter.js',
  'server/db/pool.js', 'server/db/migrate.js', 'server/db/transaction.js',
  'server/auth/student.js', 'server/auth/admin.js', 'server/auth/csrf.js', 'server/auth/manus-oauth.js',
  'server/routes/student.js', 'server/routes/admin.js', 'server/health.js',
  'scripts/build.js', 'scripts/migrate.js', 'public/app.js',
];

for (const relative of sourceFiles) {
  const absolute = resolve(root, relative);
  if (!existsSync(absolute)) throw new Error(`Missing source file: ${relative}`);
  const result = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${relative}: ${result.stderr || result.stdout}`);
}

const manifest = JSON.parse(readFileSync(resolve(root, 'public/manus-routes.json'), 'utf8'));
if (!Array.isArray(manifest.routes) || manifest.routes.some((route) => !route.path.startsWith('/'))) {
  throw new Error('manus-routes.json must declare only absolute page paths.');
}
for (const localPath of ['/assets/khanyonis-login.css', '/app.js', '/hub-app.css']) {
  if (!existsSync(resolve(root, 'public', localPath.slice(1)))) throw new Error(`Missing browser asset: ${localPath}`);
}
console.log(`Checked ${sourceFiles.length} JavaScript files and ${manifest.routes.length} page routes.`);
