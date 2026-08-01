// Load .dev.vars (KEY=VALUE lines) into process.env for any var not already set,
// so `node src/index.js` works without exporting env by hand. CLI env wins.
// Imported first (as a side effect) by engine.js and index.js so the values are
// present before any module reads process.env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
try {
  const txt = fs.readFileSync(path.join(dir, '..', '.dev.vars'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  /* no .dev.vars; rely on real env + defaults */
}
