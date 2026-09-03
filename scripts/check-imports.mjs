// Hard gate: every static import in the worker resolves to a file that exists
// and exports every named symbol imported. Run before any commit that deletes.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
const ROOT = new URL('../workers/api/src/', import.meta.url).pathname;
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (!/generated|plugins$/.test(n)) walk(p); } else if (/\.(m?js)$/.test(n)) files.push(p); } })(ROOT);
let bad = 0;
const exportsOf = (p) => { const s = readFileSync(p, 'utf8'); const names = new Set();
  for (const m of s.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of s.matchAll(/export\s*\{([^}]+)\}/g)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) names.add(n); }
  if (/export\s+default/.test(s)) names.add('default'); return names; };
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(f), m[3]);
    if (!existsSync(target)) { console.log(`MISSING FILE  ${f.replace(ROOT,'')} → ${m[3]}`); bad++; continue; }
    const ex = exportsOf(target);
    for (const part of (m[2] || '').replace(/\/\/[^\n]*/g, '').split(',')) { const n = part.trim().split(/\s+as\s+/)[0]; if (n && !ex.has(n)) { console.log(`MISSING EXPORT ${f.replace(ROOT,'')} imports {${n}} from ${m[3]}`); bad++; } }
  }
  for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    if (!existsSync(resolve(dirname(f), m[1]))) { console.log(`MISSING DYNAMIC ${f.replace(ROOT,'')} → ${m[1]}`); bad++; }
  }
}
console.log(bad ? `✗ ${bad} problems` : `✓ imports clean (${files.length} files)`);
process.exit(bad ? 1 : 0);
