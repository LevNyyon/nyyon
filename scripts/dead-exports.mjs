// Every exported function/const in the worker with ZERO references outside
// its own file (worker src, excluding generated + pack copies; packs are
// sealed and cannot import host libs). Names are matched as identifiers.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = new URL('../workers/api/src/', import.meta.url).pathname;
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (!/generated|plugins$/.test(n)) walk(p); } else if (/\.m?js$/.test(n)) files.push(p); } })(ROOT);
const src = Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]));
const dead = [];
for (const f of files) {
  for (const m of src[f].matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1]; const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
    const used = files.some((g) => g !== f && re.test(src[g]));
    if (!used) dead.push(`${f.replace(ROOT, '')}: ${name}`);
  }
}
console.log(dead.join('\n')); console.log(`— ${dead.length} unreferenced exports`);
