import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mutableAssets = ['app.js', 'hub-app.css', 'assets/khanyonis-login.css'];

export function buildPublicSite({ source = resolve(root, 'public'), output = resolve(root, 'dist/public') } = {}) {
  for (const required of ['index.html', 'manus-routes.json', ...mutableAssets]) {
    if (!existsSync(resolve(source, required))) throw new Error(`Missing required public file: ${required}`);
  }

  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  cpSync(source, output, { recursive: true });

  let html = readFileSync(resolve(source, 'index.html'), 'utf8');
  const assets = {};
  for (const relative of mutableAssets) {
    const content = readFileSync(resolve(source, relative));
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const extension = extname(relative);
    const versioned = `${relative.slice(0, -extension.length)}.${hash}${extension}`;
    const originalReference = `"/${relative}"`;
    if (!html.includes(originalReference)) throw new Error(`Missing HTML asset reference: ${relative}`);
    writeFileSync(resolve(output, versioned), content);
    html = html.replaceAll(originalReference, `"/${versioned}"`);
    assets[relative] = versioned;
  }
  writeFileSync(resolve(output, 'index.html'), html);
  return assets;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPublicSite();
  console.log(`Built versioned frontend assets in ${resolve(root, 'dist/public')}`);
}
