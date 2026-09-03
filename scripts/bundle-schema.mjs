#!/usr/bin/env node
// Ship the database's FINAL SHAPE, not its history.
//
// A worker deployed straight from a repo has to build its own database, and
// replaying schema.sql plus 75 historical migrations is both enormous (251KB)
// and slow — most of it is churn that cancels itself out. So: replay the whole
// history HERE, once, at build time, then dump the tables and indexes that
// actually exist at the end. Same result, a fraction of the statements.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'workers', 'api', 'src', 'generated');
mkdirSync(OUT, { recursive: true });

const tmp = join(REPO, '.schema-build.sqlite');
rmSync(tmp, { force: true });
const db = new DatabaseSync(tmp);

const apply = (sql, label) => {
  // One pass, real tokenizer rules: statements end at a top-level ';' that is
  // not inside a string, a -- line comment, or a /* */ block comment. The
  // previous per-line comment stripper guessed at quote parity and silently
  // dropped most of the SEED statements — multi-line doc bodies with dashes
  // inside them are exactly what it got wrong.
  const stmts = [];
  let buf = '', i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {                     // string literal, '' escapes
      buf += ch; i++;
      while (i < n) {
        buf += sql[i];
        if (sql[i] === "'") { if (sql[i + 1] === "'") { buf += "'"; i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (ch === '/' && sql[i + 1] === '*') { i += 2; while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++; i += 2; continue; }
    if (ch === ';') { stmts.push(buf); buf = ''; i++; continue; }
    buf += ch; i++;
  }
  if (buf.trim()) stmts.push(buf);
  for (const raw of stmts) {
    const st = raw.trim();
    if (!st) continue;
    try { db.exec(st); } catch (e) {
      const m = String(e?.message || e);
      // A migration whose dependency was removed from the schema years ago is
      // expected to fail here; it contributes nothing to the final state.
      if (!/already exists|duplicate column|no such table|no such column/i.test(m)) {
        console.warn(`  (${label}: ${m.slice(0, 90)})`);
      }
    }
  }
};

apply(readFileSync(join(REPO, 'db', 'schema.sql'), 'utf8'), 'schema.sql');
for (const f of readdirSync(join(REPO, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
  apply(readFileSync(join(REPO, 'db', 'migrations', f), 'utf8'), f);
}

// The end state: every table and index that survived, as CREATE IF NOT EXISTS.
// The host seed must carry the HOST plus exactly the packs this build
// bundles — nothing else. The migration replay contains every pack that ever
// lived in the repo, and shipping it whole gave fresh installs knowledge
// docs and tables from plugins they do not have. Namespaces are matched by
// plain string prefix, never SQL LIKE ('_' is a wildcard there — a cleanup
// using LIKE 'plugin\_%' without ESCAPE once matched the host's own
// 'plugins' registry table and dropped it).
const bundledPacks = readdirSync(join(REPO, 'plugins'), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name);
const keepTable = (name) => {
  if (!name.startsWith('plugin_')) return true;   // host table ('plugins' itself does not match)
  return bundledPacks.some((n) => name.startsWith(`plugin_${n.replace(/-/g, '_')}_`));
};
const keepDocSlug = (slug) => {
  if (!String(slug).startsWith('plugin-')) return true;
  return bundledPacks.some((n) => String(slug).startsWith(`plugin-${n}-`));
};

const rows = db.prepare(
  `SELECT type, name, tbl_name, sql FROM sqlite_master
   WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
   ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
).all().filter((r) => keepTable(r.tbl_name || r.name));

// The SHAPE is not the install. Migrations also SEED — the knowledge tree,
// Nyo's shipped voice documents, the registry, default workflows. A database
// built from DDL alone boots an install with one self-seeded doc and a
// planner whose persona cannot even import (its parent tree node does not
// exist). So: dump every row the replayed reference holds, as one
// INSERT OR IGNORE per line (D1's exec() parses per line; OR IGNORE keeps
// re-runs and half-built databases safe).
// Newlines inside seed values cannot be literal (D1's exec parses one
// statement per line) and cannot be `|| char(10) ||` chains (a long doc body
// builds an expression tree past SQLite's depth-100 cap — real D1 rejects it
// even though node:sqlite happily runs it). So values carry a sentinel and
// each table gets ONE flat replace() per text column afterwards.
const NL = '{{~nyyon-nl~}}';
const lit = (v) =>
  v === null ? 'NULL'
  : typeof v === 'number' ? String(v)
  : typeof v === 'bigint' ? String(v)
  : `'${String(v).replace(/'/g, "''").replace(/\r/g, '').replace(/\n/g, NL)}'`;
const seedLines = [];
let seedRows = 0;
// Identity and session state are NEVER seeded. The row that says who owns an
// install is per-install by definition, and capturing it shipped the
// developer's own account in the bundle: a fresh install booted already
// "owned" by someone else, sat at a sign-in it could not pass, and showed a
// signed-out shell. Data that belongs to a person does not travel with code.
const NEVER_SEED = new Set(['install_state', 'sessions', 'users', 'gateway_config', 'setup_tokens']);

for (const t of rows.filter((r) => r.type === 'table')) {
  if (NEVER_SEED.has(t.name)) continue;
  let data = db.prepare(`SELECT * FROM "${t.name}"`).all();
  if (t.name === 'knowledge_docs') data = data.filter((r) => keepDocSlug(r.slug));
  if (!data.length) continue;
  // A table that references ITSELF (the knowledge tree: parent_slug → slug)
  // must be emitted parents-first, or the FK check kills the child inserts —
  // which is exactly how 4 knowledge docs vanished from fresh installs.
  const selfFk = db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all()
    .find((fk) => String(fk.table).toLowerCase() === t.name.toLowerCase());
  if (selfFk) {
    const from = selfFk.from, to = selfFk.to;
    const emitted = new Set();
    const ordered = [];
    let pool = [...data];
    while (pool.length) {
      const ready = pool.filter((r) => r[from] == null || emitted.has(r[from]));
      if (!ready.length) { ordered.push(...pool); break; }   // cycle or missing parent: emit rest as-is
      for (const r of ready) { ordered.push(r); emitted.add(r[to]); }
      pool = pool.filter((r) => !ready.includes(r));
    }
    data = ordered;
  }
  const cols = Object.keys(data[0]);
  const sentinelCols = new Set();
  for (const r of data) {
    seedLines.push(`INSERT OR IGNORE INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => lit(r[c])).join(', ')});`);
    for (const c of cols) if (typeof r[c] === 'string' && r[c].includes('\n')) sentinelCols.add(c);
    seedRows++;
  }
  for (const c of sentinelCols) {
    seedLines.push(`UPDATE "${t.name}" SET "${c}" = replace("${c}", '${NL}', char(10)) WHERE "${c}" LIKE '%${NL}%';`);
  }
}
db.close();
rmSync(tmp, { force: true });

const out = [
  '-- GENERATED by scripts/bundle-schema.mjs — do not edit.',
  '-- The database\'s final shape AND seed rows, replayed from schema + every migration.',
  // D1's exec() parses ONE STATEMENT PER LINE, so each CREATE is flattened.
  ...rows.map((r) => String(r.sql)
    .replace(/^CREATE (TABLE|INDEX|UNIQUE INDEX|VIEW|TRIGGER)\s+(?!IF NOT EXISTS)/i, (m, kind) => `CREATE ${kind} IF NOT EXISTS `)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() + ';'),
].join('\n');
// A .js module, not a .sql text import: bundler rules for text modules are a
// silent failure mode (the import resolves at build time and throws at
// runtime, which looks exactly like "the database was already fine").
const withSeeds = out + '\n' + seedLines.join('\n') + '\n';
writeFileSync(join(OUT, 'schema.sql'), withSeeds);
writeFileSync(join(OUT, 'schema-sql.js'),
  `// GENERATED by scripts/bundle-schema.mjs — do not edit.\nexport default ${JSON.stringify(withSeeds)};\n`);
console.log(`bundled: ${rows.filter((r) => r.type === 'table').length} tables, ${rows.filter((r) => r.type === 'index').length} indexes, ${seedRows} seed rows, ${(withSeeds.length / 1024).toFixed(0)}KB`);
