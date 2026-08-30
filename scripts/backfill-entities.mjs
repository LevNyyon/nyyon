#!/usr/bin/env node
// One-off repair for signal rows stored before the feed parser decoded numeric
// HTML entities by value.
//
// The parser is fixed, so new signals are clean; this is only for rows already
// in the table. Titles appear in the Hot Takes topic cards, the digest and the
// first-run proposals, so a visible "&#039;" is worth one pass to remove
// rather than waiting for the feed to roll over.
//
//   node scripts/backfill-entities.mjs            # show what would change
//   node scripts/backfill-entities.mjs --write    # emit the SQL
//   node scripts/backfill-entities.mjs --write | (cd workers/api && npx wrangler d1 execute nyyon --local --file /dev/stdin)
//
// Reads through wrangler so it needs no DB credentials of its own, and decodes
// with the SAME helper the parser uses — a second implementation here would be
// a second thing to get wrong.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const { decodeNumericEntities } = await import(
  pathToFileURL(join(repo, 'workers', 'api', 'src', 'lib', 'util.js')).href
);

const write = process.argv.includes('--write');
const remote = process.argv.includes('--remote');

// Mirrors the parser's ordering: named refs, then numeric by value, then &amp;
// last so a double-escaped &amp;#039; is not collapsed into an apostrophe.
function repair(s) {
  if (!s) return s;
  const t = String(s)
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return decodeNumericEntities(t).replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function d1(sql) {
  const out = execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'nyyon', remote ? '--remote' : '--local', '--json', '--command', sql,
  ], { cwd: join(repo, 'workers', 'api'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const m = out.match(/\[\s*\{[\s\S]*\]\s*$/);   // wrangler prints a banner first
  return m ? JSON.parse(m[0])[0].results : [];
}

const rows = d1(
  `SELECT id, title, summary FROM plugin_editorial_osint_signals WHERE title LIKE '%&#%' OR summary LIKE '%&#%'`,
);

const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const updates = [];
for (const r of rows) {
  const title = repair(r.title);
  const summary = repair(r.summary);
  if (title === r.title && summary === r.summary) continue;
  updates.push(`UPDATE plugin_editorial_osint_signals SET title = ${q(title)}, summary = ${q(summary)} WHERE id = ${q(r.id)};`);
  if (!write) console.error(`  ${JSON.stringify(r.title)}\n→ ${JSON.stringify(title)}\n`);
}

if (write) process.stdout.write(updates.join('\n') + '\n');
console.error(`${rows.length} row(s) matched, ${updates.length} need repair${write ? ' (SQL on stdout)' : ' — re-run with --write to emit SQL'}`);
