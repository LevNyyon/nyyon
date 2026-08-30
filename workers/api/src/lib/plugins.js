// Plugins — trade capabilities between nyyon-lite systems.
//
// The contract is docs/plugin-format.md (v2); this file is its executor:
// validate → bind gateways → activate data → hand code to the applier.
//
// WHERE THE BOUNDARY ACTUALLY IS
// v1 tried to confine plugins by regex-scanning their source at import. An
// adversarial review dismantled that: SQL built at runtime, gateways never
// declared, imports written without a space after the keyword. Source text
// cannot constrain what code does with a handle it holds.
//
// So enforcement moved to lib/plugin-runtime.js. A v2 plugin tool receives a
// CAPABILITY OBJECT, never `env`: a D1 proxy that TOKENIZES every statement at
// query time and allows only the exact tables the manifest declared, a gateway
// function closed over the declared slugs AND their declared modes, and a
// namespaced logger.
// Nothing in this file is load-bearing for security any more — the checks here
// are an honest LINT: they catch mistakes early and give a clear import-time
// error instead of a confusing runtime one.
//
// The one thing that IS load-bearing here: what the manifest is allowed to
// activate as DATA (tables, workflows, knowledge), because that runs with host
// authority at import time. Those rules are strict.
//
// Statuses: imported → bound → materialized → active | blocked | removed.
// Every transition logs to the activity bus.

import { logEvent, writeKnowledge } from './db.js';
import { now } from './util.js';
import { RESERVED_GATEWAYS, bundledGatewaySlug, tableNamespace } from './plugin-runtime.js';

// v2 is the capability contract. v1 manifests are accepted ONLY when they carry
// no code at all (knowledge/workflow packs) — a v1 tool expected raw `env` and
// there is no safe way to run it.
const FORMAT_VERSIONS = [1, 2];
const CODE_FORMAT_VERSION = 2;
const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{1,60}$/;
const SLUG_RE = /^[a-z][a-z0-9-]{1,60}$/;
// The view kinds the host knows how to render. A surface is a DESCRIPTION,
// so the renderer is the only thing that ever executes.
const SURFACE_VIEWS = new Set(['list', 'form', 'markdown']);

// Anything that brings another module into a plugin's scope. v2 code imports
// NOTHING — it is handed everything it may use — so the rule is simply "none",
// which is far harder to slip past than an allowlist of shapes.
const IMPORTY = [
  [/(^|\n)\s*import\s*[{*'"a-zA-Z_$]/, 'import declaration'],
  [/(^|\n)\s*export\s+(\*|{[^}]*})\s*from\b/, 're-export from another module'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/\brequire\s*\(/, 'require'],
];
// Lint only — the runtime is what actually stops these. Kept because they are
// reliable signals of a plugin written against the old contract.
const LINT = [
  [/\beval\s*\(/, 'eval'],
  [/new\s+Function/, 'new Function'],
  [/\bprocess\./, 'process'],
];

const arr = (v) => (Array.isArray(v) ? v : []);

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// NOTE: this is a CHECKSUM, not a signature. It proves the manifest was not
// mangled in transit; it proves nothing about who wrote it, because the sender
// computes it with no key. Trusting a plugin is trusting its author.
export const manifestPayload = (m) => JSON.stringify({ requires: m.requires || {}, provides: m.provides || {} });

// ─── validation (import-time lint + the strict data rules) ───────

// Comments are prose; scanning them produced false positives on English text
// like "update contacts". Strip them before looking for code shapes.
const stripComments = (code) => String(code || '')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

function checkCode(code, { kind, toolName, pluginName, declaredGateways }) {
  const errors = [];
  const src = stripComments(code);

  for (const [re, label] of IMPORTY) {
    // A bundled gateway is the service boundary and still imports nothing:
    // it is handed a projected env by the generated wrapper.
    if (re.test(src)) errors.push(`${kind} ${toolName}: ${label} — v2 plugin code imports nothing; everything it may use is passed in`);
  }
  for (const [re, label] of LINT) {
    if (re.test(src)) errors.push(`${kind} ${toolName}: ${label} is not allowed`);
  }

  if (kind === 'tool') {
    if (!/export\s+const\s+def\s*=/.test(src)) errors.push(`tool ${toolName}: missing "export const def"`);
    if (!/export\s+async\s+function\s+run\s*\(/.test(src)) errors.push(`tool ${toolName}: missing "export async function run("`);
    // v2 tools take the capability object. A tool still reaching for env.DB or
    // a bare callGateway was written against v1 and will fail at runtime.
    if (/\benv\s*\.\s*DB\b/.test(src)) errors.push(`tool ${toolName}: uses env.DB — v2 tools use api.db (run(api, input))`);
    if (/\bcallGateway\s*\(/.test(src)) errors.push(`tool ${toolName}: uses callGateway — v2 tools use api.gateway(slug, mode, input)`);
  }
  if (kind === 'gateway' && !/export\s+const\s+gateway\s*=/.test(src)) {
    errors.push(`gateway ${toolName}: missing "export const gateway"`);
  }

  // Lint: literal gateway slugs must have been declared. The runtime enforces
  // this for real (including slugs built at runtime, which this cannot see).
  if (kind === 'tool' && declaredGateways) {
    for (const m of src.matchAll(/\bapi\s*\.\s*gateway\s*\(\s*['"`]([a-z0-9-]+)['"`]/gi)) {
      const slug = m[1].toLowerCase();
      if (!declaredGateways.has(slug)) {
        errors.push(`tool ${toolName}: calls gateway "${slug}" which requires.gateways does not declare`);
      }
    }
  }

  // Lint: literal table names outside the namespace. Runtime is authoritative.
  const ns = tableNamespace(pluginName);
  for (const m of src.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([a-z_][a-z0-9_]*)/gi)) {
    const t = m[1].toLowerCase();
    if (!t.startsWith(ns) && !['select', 'values'].includes(t)) {
      errors.push(`${kind} ${toolName}: references table "${t}" outside ${ns}*`);
    }
  }
  return errors;
}

// DDL runs with HOST authority at import time, so this one is a real gate, not
// a lint. The v1 version anchored only the prefix, which let
// `CREATE TABLE IF NOT EXISTS plugin_x_c AS SELECT * FROM gateway_config`
// copy the credential table into the plugin's namespace. Match the WHOLE
// statement instead, and require a column list.
function checkDdl(ddl, pluginName) {
  const ns = tableNamespace(pluginName);
  const errors = [];
  const creates = [];
  const raw = String(ddl || '');
  // Split on semicolons that are not inside a string literal.
  const stmts = raw.split(/;(?=(?:[^']*'[^']*')*[^']*$)/).map((s) => s.trim()).filter(Boolean);
  const TABLE_RE = new RegExp(`^CREATE TABLE IF NOT EXISTS ${ns}[a-z0-9_]* \\(.*\\)$`, 'i');
  const INDEX_RE = new RegExp(`^CREATE INDEX IF NOT EXISTS idx_${ns}[a-z0-9_]* ON ${ns}[a-z0-9_]* \\(.*\\)$`, 'i');
  for (const s of stmts) {
    const n = s.replace(/\s+/g, ' ').trim();
    if (/\bAS\b\s*(WITH|SELECT|\()/i.test(n)) {
      errors.push(`ddl: CREATE ... AS SELECT is refused (it can copy host tables): ${n.slice(0, 90)}`);
      continue;
    }
    if (/\b(TEMP|TEMPORARY)\b/i.test(n) || /\bmain\s*\./i.test(n)) {
      errors.push(`ddl: temp tables and schema-qualified names are refused: ${n.slice(0, 90)}`);
      continue;
    }
    if (!TABLE_RE.test(n) && !INDEX_RE.test(n)) {
      errors.push(`ddl: refused — only "CREATE TABLE IF NOT EXISTS ${ns}… ( … )" and "CREATE INDEX IF NOT EXISTS idx_${ns}… ON ${ns}… ( … )": ${n.slice(0, 90)}`);
      continue;
    }
    const made = n.match(new RegExp(`^CREATE TABLE IF NOT EXISTS (${ns}[a-z0-9_]*)`, 'i'));
    if (made) creates.push(made[1].toLowerCase());
  }
  return { errors, stmts, creates };
}

export async function validateManifest(env, m) {
  const errors = [];
  if (!m || !FORMAT_VERSIONS.includes(m.nyyon_plugin)) errors.push(`nyyon_plugin must be one of ${FORMAT_VERSIONS.join(', ')}`);
  if (!NAME_RE.test(m?.name || '')) errors.push('name: kebab-case slug required');
  if (!m?.title || !m?.version) errors.push('title + version required');
  if (errors.length) return { ok: false, errors };

  const p = m.provides || {};
  const tools = arr(p.tools);
  const gateways = arr(p.gateways);
  const workflows = arr(p.workflows);
  const knowledge = arr(p.knowledge);
  const declaredGateways = new Set(arr(m.requires?.gateways).map((g) => g?.slug).filter(Boolean));

  if (!tools.length && !workflows.length && !knowledge.length && !arr(p.surfaces).length) errors.push('provides: empty plugin');

  // v1 is data-only. A v1 tool was written for raw `env` and cannot be run
  // under the capability contract, so refuse it with a migration pointer.
  if (m.nyyon_plugin < CODE_FORMAT_VERSION && (tools.length || gateways.length)) {
    errors.push('nyyon_plugin 1 carries code: v1 tools expected raw env and are no longer runnable. Re-author as v2 (run(api, input) using api.db / api.gateway) — see docs/plugin-format.md.');
  }

  if (m.sha256) {
    const got = await sha256Hex(manifestPayload(m));
    if (got !== m.sha256) errors.push('checksum mismatch — the manifest was altered in transit');
  }

  for (const t of tools) {
    if (!TOOL_RE.test(t?.name || '')) errors.push(`tool name invalid: ${t?.name}`);
    if (t?.def?.name !== t?.name) errors.push(`tool ${t?.name}: def.name mismatch`);
    errors.push(...checkCode(t?.code, { kind: 'tool', toolName: t?.name, pluginName: m.name, declaredGateways }));
  }
  for (const g of gateways) {
    if (!SLUG_RE.test(g?.slug || '')) errors.push(`gateway slug invalid: ${g?.slug}`);
    if (g?.slug && RESERVED_GATEWAYS.has(g.slug)) errors.push(`gateway ${g.slug}: reserved — a plugin may never provide it`);
    if (!arr(g?.modes).length) errors.push(`gateway ${g?.slug}: must declare its modes`);
    errors.push(...checkCode(g?.code, { kind: 'gateway', toolName: g?.slug, pluginName: m.name }));
  }
  // requires.tables[].name is THE ACCESS GRANT: the runtime allows exactly these
  // names. Validating only the DDL left the name unchecked, so
  //   { name: 'gateway_config', ddl: 'CREATE TABLE IF NOT EXISTS plugin_x_t (…)' }
  // passed every check and handed the plugin the host credential table. The
  // name must live in the namespace AND be a table this plugin's own DDL creates.
  {
    const ns = tableNamespace(m.name);
    const created = new Set();
    for (const tb of arr(m.requires?.tables)) {
      const r = checkDdl(tb?.ddl, m.name);
      errors.push(...r.errors);
      for (const c of r.creates) created.add(c);
    }
    for (const tb of arr(m.requires?.tables)) {
      const nm = String(tb?.name || '').toLowerCase();
      if (!nm) { errors.push('requires.tables: every entry needs a name'); continue; }
      if (!nm.startsWith(ns)) errors.push(`requires.tables: "${nm}" is outside this plugin's namespace (${ns}*)`);
      else if (!created.has(nm)) errors.push(`requires.tables: "${nm}" is not created by this plugin's own DDL`);
    }
  }

  // Surfaces: a module IS its page, so a plugin that cannot ship one cannot be
  // a module. It ships a DESCRIPTION, not code — the host renders it in its own
  // look. That is what makes a module exchangeable between users: nobody
  // installing a stranger's module should be injecting their React into their
  // own app with their own session, and a stranger's TSX that fails to compile
  // would break the RECEIVER's build. Declarative also means a surface is data,
  // so it activates at import with no applier and no rebuild.
  {
    const toolNames = new Set(tools.map((t) => t?.name).filter(Boolean));
    for (const sf of arr(p.surfaces)) {
      if (!SLUG_RE.test(sf?.slug || '')) { errors.push(`surface slug invalid: ${sf?.slug}`); continue; }
      if (!sf?.title) errors.push(`surface ${sf.slug}: needs a title`);
      // Two forms. `page_code` is the REAL page — TSX, byte-identical, same UX
      // as a native module page, materialized into the SPA by the applier.
      // `tabs` is the declarative form for small plugins. Exactly one of them.
      const hasPage = typeof sf?.page_code === 'string' && sf.page_code.trim().length > 0;
      const tabs = arr(sf?.tabs);
      if (hasPage && tabs.length) { errors.push(`surface ${sf.slug}: page_code and tabs are exclusive — pick one form`); continue; }
      if (hasPage) {
        if (sf.page_code.length > 500_000) errors.push(`surface ${sf.slug}: page_code over 500KB`);
        continue;
      }
      if (!tabs.length) errors.push(`surface ${sf.slug}: needs tabs or page_code`);
      for (const tab of tabs) {
        if (!tab?.key || !tab?.title) { errors.push(`surface ${sf.slug}: every tab needs a key and a title`); continue; }
        const view = tab.view || {};
        if (!SURFACE_VIEWS.has(view.kind)) {
          errors.push(`surface ${sf.slug}/${tab.key}: view.kind must be one of ${[...SURFACE_VIEWS].join(', ')}`);
          continue;
        }
        // A surface may only drive THIS plugin's own tools — it must not become
        // a remote control for the host pool.
        if (view.kind !== 'markdown') {
          if (!view.tool) errors.push(`surface ${sf.slug}/${tab.key}: ${view.kind} needs a tool`);
          else if (!toolNames.has(view.tool)) {
            errors.push(`surface ${sf.slug}/${tab.key}: tool "${view.tool}" is not one this plugin provides`);
          }
        }
        for (const a of arr(view.actions)) {
          if (a?.tool && !toolNames.has(a.tool)) {
            errors.push(`surface ${sf.slug}/${tab.key}: action tool "${a.tool}" is not one this plugin provides`);
          }
        }
      }
    }
  }

  // Gateway requirements: no reserved slugs, no binding to another plugin's
  // bundled gateway, and a requirement that asserts no modes binds to anything.
  for (const g of arr(m.requires?.gateways)) {
    if (!SLUG_RE.test(g?.slug || '')) { errors.push(`requires.gateways: invalid slug ${g?.slug}`); continue; }
    if (RESERVED_GATEWAYS.has(g.slug)) errors.push(`requires.gateways: "${g.slug}" is reserved and can never be bound by a plugin`);
    if (g.slug.startsWith('plugin__') || g.slug.startsWith('plugin-')) errors.push(`requires.gateways: "${g.slug}" — a plugin may not bind another plugin's bundled gateway`);
    if (!arr(g.modes).length) errors.push(`requires.gateways: "${g.slug}" must list the modes it uses`);
  }

  // Host collisions: a plugin may not shadow an existing pool tool.
  try {
    const { visibleToolDefs } = await import('../tools/index.js');
    const names = new Set((await visibleToolDefs(env)).map((d) => d.name));
    for (const t of tools) if (names.has(t.name)) errors.push(`tool ${t.name}: name collides with the host pool`);
  } catch (e) {
    // Fail CLOSED: without the pool we cannot rule out shadowing a host tool.
    errors.push(`tool pool unavailable, cannot check name collisions: ${String(e?.message || e)}`);
  }

  // A plugin may only overwrite workflow slugs it created itself, and its
  // knowledge lives in the plugin's own namespace, like tables and gateways do.
  for (const w of workflows) {
    if (!SLUG_RE.test(w?.slug || '')) errors.push(`workflow slug invalid: ${w?.slug}`);
  }
  try {
    for (const w of workflows) {
      const row = await env.DB.prepare('SELECT created_by FROM workflows WHERE slug = ?').bind(w?.slug).first();
      if (row && row.created_by !== `plugin:${m.name}`) errors.push(`workflow ${w?.slug}: slug collides with a host workflow`);
    }
  } catch { /* db unavailable — the workflow upsert will surface it */ }
  for (const k of knowledge) {
    if (!String(k?.slug || '').startsWith(`plugin-${m.name}`)) {
      errors.push(`knowledge ${k?.slug}: must live in the plugin namespace (slug starting "plugin-${m.name}")`);
    }
  }

  // Workflow steps must exist post-install (host pool + this plugin's tools).
  try {
    const { visibleToolDefs } = await import('../tools/index.js');
    const names = new Set((await visibleToolDefs(env)).map((d) => d.name));
    for (const t of tools) names.add(t.name);
    for (const w of workflows) {
      for (const st of arr(w.steps)) {
        const stepName = typeof st === 'string' ? st : st?.tool;
        if (stepName && !names.has(stepName)) errors.push(`workflow ${w.slug}: step "${stepName}" exists in neither the host pool nor this plugin`);
      }
    }
  } catch { /* already reported above */ }

  return { ok: !errors.length, errors };
}

// ─── gateway binding ─────────────────────────────────────────────

export async function bindGateways(env, m) {
  const { listGateways } = await import('../gateways/index.js');
  const host = Object.fromEntries(listGateways().map((g) => [g.slug, new Set(arr(g.modes))]));
  const bundled = Object.fromEntries(arr(m.provides?.gateways).map((g) => [g.slug, g]));
  const binding = {};
  const errors = [];
  for (const req of arr(m.requires?.gateways)) {
    const modes = arr(req.modes);
    if (RESERVED_GATEWAYS.has(req.slug)) { errors.push(`gateway ${req.slug}: reserved, never bindable by a plugin`); continue; }
    const have = host[req.slug];
    if (have && modes.every((mode) => have.has(mode))) { binding[req.slug] = { via: 'host', target: req.slug, modes }; continue; }
    const bun = bundled[req.slug];
    if (bun) {
      // A bundle only satisfies the requirement if it offers every mode.
      const offers = new Set(arr(bun.modes));
      const short = modes.filter((mode) => !offers.has(mode));
      if (short.length) { errors.push(`gateway ${req.slug}: the bundled replacement lacks modes [${short}]`); continue; }
      binding[req.slug] = { via: 'bundled', target: bundledGatewaySlug(m.name, req.slug), modes };
      continue;
    }
    const missing = have ? modes.filter((mode) => !have.has(mode)) : modes;
    errors.push(`gateway ${req.slug}: host ${have ? `lacks modes [${missing}]` : 'does not have it'} and the plugin bundles no replacement`);
  }
  return { ok: !errors.length, binding, errors };
}

// ─── the import pipeline ─────────────────────────────────────────

export async function importPlugin(env, manifest, { actor = 'operator' } = {}) {
  const name = manifest?.name;
  // Refuse an unusable name BEFORE any write: the name becomes a directory path
  // for the applier, so "../.." must never reach a stored row.
  if (!NAME_RE.test(name || '')) {
    return { ok: false, status: 'blocked', errors: ['name: kebab-case slug required (a plugin name becomes a directory path)'] };
  }

  const existing = await env.DB.prepare('SELECT status FROM plugins WHERE name = ?').bind(name).first().catch(() => null);
  const live = existing && ['active', 'materialized'].includes(existing.status);

  const save = (status, extra = {}) => env.DB.prepare(
    `INSERT INTO plugins (name, version, title, status, manifest_json, binding_json, report_json, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET version = excluded.version, title = excluded.title, status = excluded.status,
       manifest_json = excluded.manifest_json, binding_json = excluded.binding_json,
       report_json = excluded.report_json, updated_at = excluded.updated_at`,
  ).bind(name, manifest?.version || '0', manifest?.title || name, status,
    JSON.stringify(manifest), JSON.stringify(extra.binding || {}), JSON.stringify(extra.report || {}),
    now(), now()).run();

  // A failed re-import must NOT overwrite a working installation's row — that
  // replaced a live plugin's manifest with the rejected one.
  const reject = async (step, errs) => {
    if (live) {
      await logEvent(env, { kind: 'plugin_blocked', actor, payload: { name, step, errors: errs.slice(0, 10), kept_installed: true } });
      return { ok: false, status: 'blocked', errors: errs, note: `the installed ${existing.status} plugin "${name}" was left untouched` };
    }
    await save('blocked', { report: { step, errors: errs } });
    await logEvent(env, { kind: 'plugin_blocked', actor, payload: { name, step, errors: errs.slice(0, 10) } });
    return { ok: false, status: 'blocked', errors: errs };
  };

  const v = await validateManifest(env, manifest);
  if (!v.ok) return reject('validate', v.errors);

  const b = await bindGateways(env, manifest);
  if (!b.ok) return reject('bind', b.errors);

  // The PREVIOUS manifest, read before anything overwrites it — reading it
  // after save() compared the new manifest with itself, so workflow retirement
  // below was dead code.
  let prevManifest = null;
  if (existing) {
    const prevRow = await env.DB.prepare('SELECT manifest_json FROM plugins WHERE name = ?').bind(name).first().catch(() => null);
    try { prevManifest = JSON.parse(prevRow?.manifest_json || 'null'); } catch { prevManifest = null; }
  }

  // Record the attempt BEFORE mutating anything, so a throw mid-way leaves a
  // row explaining the partial state instead of orphan tables with no record.
  // A LIVE plugin's row is not overwritten until activation succeeds, so a
  // failed upgrade cannot destroy the manifest of a working installation.
  if (!live) await save('imported', { binding: b.binding, report: { step: 'activating' } });

  const warnings = [];
  try {
    for (const tb of arr(manifest.requires?.tables)) {
      const { errors: ddlErrors, stmts } = checkDdl(tb.ddl, name);
      if (ddlErrors.length) throw new Error(ddlErrors[0]);
      for (const stmt of stmts) await env.DB.prepare(stmt).run();
    }
    for (const w of arr(manifest.provides?.workflows)) {
      // An operator's deliberate disable survives a re-import.
      await env.DB.prepare(
        `INSERT INTO workflows (slug, name, description, trigger, steps, source, status, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'plugin', 'active', ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET name = excluded.name, description = excluded.description,
           steps = excluded.steps, updated_at = excluded.updated_at,
           status = CASE WHEN workflows.status = 'disabled' THEN 'disabled' ELSE 'active' END`,
      ).bind(w.slug, w.name || w.slug, w.goal || w.description || null,
        JSON.stringify({ kind: 'manual' }), JSON.stringify(arr(w.steps)), now(), now(), `plugin:${name}`).run();
    }
    // Workflow slugs this plugin used to provide and no longer does are retired.
    if (prevManifest) {
      const prevSlugs = new Set(arr(prevManifest?.provides?.workflows).map((w) => w.slug));
      const nextSlugs = new Set(arr(manifest.provides?.workflows).map((w) => w.slug));
      for (const slug of prevSlugs) {
        if (!nextSlugs.has(slug)) {
          await env.DB.prepare("UPDATE workflows SET status = 'disabled', updated_at = ? WHERE slug = ? AND created_by = ?")
            .bind(now(), slug, `plugin:${name}`).run().catch(() => {});
        }
      }
    }
    for (const k of arr(manifest.provides?.knowledge)) {
      try {
        await writeKnowledge(env, { slug: k.slug, title: k.title || k.slug, body: k.body || '', scope: 'global', module: null, parent_slug: 'knowledge-root' });
      } catch (e) {
        warnings.push(`knowledge ${k.slug}: ${String(e?.message || e)}`);
      }
    }
  } catch (e) {
    const err = `activation failed: ${String(e?.message || e)}`;
    await save('blocked', { binding: b.binding, report: { step: 'activate', errors: [err], partial: true } });
    await logEvent(env, { kind: 'plugin_blocked', actor, payload: { name, step: 'activate', error: err } });
    return { ok: false, status: 'blocked', errors: [err] };
  }

  // Knowledge-only plugins whose every write failed have delivered nothing.
  const onlyKnowledge = !arr(manifest.provides?.tools).length && !arr(manifest.provides?.workflows).length;
  if (onlyKnowledge && warnings.length === arr(manifest.provides?.knowledge).length && warnings.length) {
    await save('blocked', { binding: b.binding, report: { step: 'activate', errors: warnings } });
    await logEvent(env, { kind: 'plugin_blocked', actor, payload: { name, step: 'activate', errors: warnings.slice(0, 10) } });
    return { ok: false, status: 'blocked', errors: warnings };
  }

  const hasCode = arr(manifest.provides?.tools).length || arr(manifest.provides?.gateways).length;
  await save(hasCode ? 'bound' : 'active', {
    binding: b.binding,
    report: { step: hasCode ? 'awaiting-applier' : 'done', ...(warnings.length ? { warnings } : {}) },
  });
  await logEvent(env, { kind: 'plugin_imported', actor, payload: { name, version: manifest.version, binding: b.binding, needs_materialization: !!hasCode, warnings } });
  return { ok: true, status: hasCode ? 'bound' : 'active', binding: b.binding, warnings };
}

// ─── materialization (consumed by the applier) ───────────────────

const pluginDir = (name) => `workers/api/src/plugins/${name}`;

// Only gateways the binding actually chose are materialized: a bundle the host
// superseded is dead code, and registering it would let another plugin bind it.
const bundledInUse = (manifest, binding) =>
  arr(manifest.provides?.gateways).filter((g) => binding?.[g.slug]?.via === 'bundled');

export function filesFor(manifest, binding) {
  const files = [];
  if (!NAME_RE.test(manifest?.name || '')) return files; // never build a path from a bad name
  for (const t of arr(manifest.provides?.tools)) {
    if (!TOOL_RE.test(t?.name || '')) continue;
    // Source is materialized VERBATIM — no rewriting. The gateway binding is
    // resolved at runtime by the capability object, so there is nothing to
    // patch and no call form that can be missed.
    files.push({ path: `${pluginDir(manifest.name)}/tool-${t.name}.mjs`, content: String(t.code || '') });
  }
  for (const g of bundledInUse(manifest, binding)) {
    files.push({ path: `${pluginDir(manifest.name)}/gateway-${g.slug}.mjs`, content: String(g.code || '') });
  }
  // Page surfaces are code too — they materialize into the SPA, verbatim,
  // exactly like tool code materializes into the worker.
  for (const sf of arr(manifest.provides?.surfaces)) {
    if (!SLUG_RE.test(sf?.slug || '')) continue;
    if (typeof sf?.page_code === 'string' && sf.page_code.trim()) {
      files.push({ path: `web/src/plugins/${manifest.name}/${sf.slug}.tsx`, content: String(sf.page_code) });
    }
  }
  return files;
}

// plugins/index.js is GENERATED, fully, from the set of installed plugins —
// deterministic, never reading the previous file. It is also the injection
// point for the capability boundary: every plugin run() is wrapped so it
// receives pluginApi(...) instead of env.
export function generateIndex(rows) {
  const head = [
    '// GENERATED by the Plugins module — do not edit by hand.',
    '// Aggregates every installed plugin into the tool pool and gateway registry.',
    '// Each plugin runs against a capability object (lib/plugin-runtime.js): a',
    '// namespace-scoped DB, a gateway function closed over its own binding, and',
    '// a namespaced logger. Plugin code never receives env.',
  ];
  const imports = [];
  const toolRefs = [];
  const gwRefs = [];
  const seenTool = new Set();
  const seenGw = new Set();
  let i = 0;
  const bindings = {};
  const tables = {};

  for (const row of rows) {
    let m;
    try { m = JSON.parse(row.manifest_json); } catch { continue; }
    if (!NAME_RE.test(m?.name || '')) continue;
    let binding = {};
    try { binding = JSON.parse(row.binding_json || '{}'); } catch { /* none */ }
    // Bindings stored before modes were enforced carry only {via, target}.
    // Backfill from the manifest the operator actually approved, so tightening
    // the rule does not silently break an already-installed plugin (its calls
    // would fail with "declared for mode(s) [none]"). No DB migration, no
    // operator action — the manifest is the record of what was agreed.
    const declaredModes = Object.fromEntries(
      arr(m.requires?.gateways).map((g) => [g?.slug, arr(g?.modes)]),
    );
    bindings[m.name] = Object.fromEntries(
      Object.entries(binding).map(([slug, b]) => [
        slug,
        { ...b, modes: arr(b?.modes).length ? b.modes : (declaredModes[slug] || []) },
      ]),
    );
    // The EXACT tables this plugin declared. Access is decided by membership in
    // this set, never by a name prefix: `plugin_a_` is a prefix of
    // `plugin_a_b_`, so prefix matching let plugin "a" read plugin "a-b"'s data.
    // Re-filter to the namespace even though validateManifest already did:
    // this map IS the runtime grant, and a row could predate that check.
    const ns = tableNamespace(m.name);
    tables[m.name] = arr(m.requires?.tables)
      .map((t) => String(t?.name || '').toLowerCase())
      .filter((t) => t && t.startsWith(ns));

    for (const t of arr(m.provides?.tools)) {
      if (!TOOL_RE.test(t?.name || '') || seenTool.has(t.name)) continue;
      seenTool.add(t.name);
      const v = `p${i++}`;
      imports.push(`import * as ${v} from './${m.name}/tool-${t.name}.mjs';`);
      toolRefs.push(
        `  ${JSON.stringify(t.name)}: { def: ${v}.def, run: (env, input, ctx) => `
        + `${v}.run(pluginApi(env, ${JSON.stringify(m.name)}, BINDINGS[${JSON.stringify(m.name)}], TABLES[${JSON.stringify(m.name)}]), input, ctx) },`,
      );
    }
    for (const g of arr(m.provides?.gateways).filter((gg) => binding?.[gg.slug]?.via === 'bundled')) {
      const key = bundledGatewaySlug(m.name, g.slug);
      if (seenGw.has(key)) continue;
      seenGw.add(key);
      const v = `p${i++}`;
      imports.push(`import * as ${v} from './${m.name}/gateway-${g.slug}.mjs';`);
      gwRefs.push(
        `  ${JSON.stringify(key)}: { ...${v}.gateway, slug: ${JSON.stringify(key)}, `
        + `modes: wrapGatewayModes(${v}.gateway.modes, ${JSON.stringify(m.name)}, TABLES[${JSON.stringify(m.name)}]) },`,
      );
    }
  }

  const lines = [
    ...head,
    '',
    "import { pluginApi, wrapGatewayModes } from '../lib/plugin-runtime.js';",
    ...imports,
    '',
    `const BINDINGS = ${JSON.stringify(bindings, null, 2)};`,
    `const TABLES = ${JSON.stringify(tables, null, 2)};`,
    '',
    'export const pluginTools = {',
    ...toolRefs,
    '};',
    '',
    'export const pluginGateways = {',
    ...gwRefs,
    '};',
    '',
  ];
  return lines.join('\n');
}

// web/src/plugins/index.ts is the SPA-side twin of the worker aggregator:
// GENERATED, fully, from the installed set. Lazy imports keep an installed
// page out of the main bundle until it is opened.
export function generateWebIndex(rows) {
  const head = [
    '// GENERATED by the Plugins module — do not edit by hand.',
    "// Maps 'plugin:<name>:<slug>' nav keys to installed plugins' pages.",
    "import { lazy } from 'react';",
    'export const PLUGIN_PAGES: Record<string, ReturnType<typeof lazy>> = {',
  ];
  const lines = [];
  for (const row of rows) {
    let m;
    try { m = JSON.parse(row.manifest_json); } catch { continue; }
    if (!NAME_RE.test(m?.name || '')) continue;
    for (const sf of arr(m.provides?.surfaces)) {
      if (!SLUG_RE.test(sf?.slug || '')) continue;
      if (typeof sf?.page_code === 'string' && sf.page_code.trim()) {
        lines.push(`  ${JSON.stringify(`${m.name}:${sf.slug}`)}: lazy(() => import(${JSON.stringify(`./${m.name}/${sf.slug}`)})),`);
      }
    }
  }
  return [...head, ...lines, '};', ''].join('\n');
}

export async function pendingMaterializations(env) {
  const pending = (await env.DB.prepare("SELECT * FROM plugins WHERE status = 'bound'").all()).results || [];
  const installed = (await env.DB.prepare("SELECT * FROM plugins WHERE status IN ('bound','materialized','active')").all()).results || [];
  const removedRows = (await env.DB.prepare("SELECT name, report_json FROM plugins WHERE status = 'removed'").all()).results || [];
  // A removal already cleaned by the applier must drop off the work list, or
  // the applier deletes nothing, restarts the app, and does it again forever.
  const remove = removedRows.filter((r) => {
    try { return JSON.parse(r.report_json || '{}')?.step !== 'cleaned'; } catch { return true; }
  }).map((r) => r.name).filter((n) => NAME_RE.test(n || ''));

  const shape = (r) => ({ name: r.name, files: filesFor(JSON.parse(r.manifest_json), JSON.parse(r.binding_json || '{}')) });
  return {
    pending: pending.map(shape),
    // Everything installed, for the applier's reconcile pass: a source sync or
    // disk mishap that loses a materialized file gets healed on the next tick.
    installed: installed.map(shape),
    // Materialized-but-unverified plugins the applier should re-verify.
    verify: installed.filter((r) => r.status === 'materialized').map((r) => r.name),
    index_file: { path: 'workers/api/src/plugins/index.js', content: generateIndex(installed) },
    web_index_file: { path: 'web/src/plugins/index.ts', content: generateWebIndex(installed) },
    remove,
  };
}

// Status transitions are guarded in SQL: a blocked plugin must not be walked
// forward to materialized/active by an applier that reports on the wrong name.
export async function markMaterialized(env, name, { ok, error = null } = {}) {
  const r = await env.DB.prepare(
    "UPDATE plugins SET status = ?, report_json = ?, updated_at = ? WHERE name = ? AND status = 'bound'",
  ).bind(ok ? 'materialized' : 'blocked', JSON.stringify({ step: 'materialize', error }), now(), name).run();
  const changed = r?.meta?.changes ?? r?.changes ?? 0;
  if (!changed) return { ok: false, error: `plugin "${name}" is not awaiting materialization` };
  await logEvent(env, { kind: ok ? 'plugin_materialized' : 'plugin_blocked', actor: 'applier', payload: { name, error } });
  return { ok: true };
}

// The applier calls this after deleting a removed plugin's files, so the
// removal drops off the work list instead of repeating every tick.
export async function markCleaned(env, name) {
  const r = await env.DB.prepare(
    "UPDATE plugins SET report_json = ?, updated_at = ? WHERE name = ? AND status = 'removed'",
  ).bind(JSON.stringify({ step: 'cleaned' }), now(), name).run();
  const changed = r?.meta?.changes ?? r?.changes ?? 0;
  if (changed) await logEvent(env, { kind: 'plugin_cleaned', actor: 'applier', payload: { name } });
  return { ok: !!changed };
}

// Post-restart/deploy verification: the plugin's tools must be in the live pool.
export async function verifyPlugin(env, name) {
  const row = await env.DB.prepare('SELECT * FROM plugins WHERE name = ?').bind(name).first();
  if (!row) return { ok: false, error: 'unknown plugin' };
  if (!['materialized', 'active'].includes(row.status)) {
    return { ok: false, error: `plugin is ${row.status} — only materialized plugins verify` };
  }
  let m = {};
  try { m = JSON.parse(row.manifest_json); } catch { return { ok: false, error: 'stored manifest is unreadable' }; }
  const { visibleToolDefs } = await import('../tools/index.js');
  const names = new Set((await visibleToolDefs(env)).map((d) => d.name));
  const missing = arr(m.provides?.tools).map((t) => t.name).filter((n) => !names.has(n));
  if (missing.length) return { ok: false, error: `tools not live yet: ${missing.join(', ')}` };
  await env.DB.prepare("UPDATE plugins SET status = 'active', updated_at = ? WHERE name = ? AND status IN ('materialized','active')").bind(now(), name).run();
  await logEvent(env, { kind: 'plugin_active', actor: 'system', payload: { name } });
  return { ok: true };
}

export async function listPlugins(env) {
  const rows = (await env.DB.prepare('SELECT name, version, title, status, binding_json, report_json, installed_at, updated_at FROM plugins ORDER BY installed_at DESC').all()).results || [];
  return rows.map((r) => {
    let binding = {}; let report = {};
    try { binding = JSON.parse(r.binding_json || '{}'); } catch { /* keep empty */ }
    try { report = JSON.parse(r.report_json || '{}'); } catch { /* keep empty */ }
    return { ...r, binding, report, binding_json: undefined, report_json: undefined };
  });
}

// The plugin registry: every installed plugin's full component map — the
// paths its code lives at, the gateways it binds or bundles, its workflows,
// tools, knowledge docs, tables and surfaces. This IS the Registry, scoped to
// plugins and owned by the Plugins module.
export async function pluginRegistry(env) {
  const rows = (await env.DB.prepare(
    'SELECT name, version, title, status, manifest_json, binding_json, installed_at, updated_at FROM plugins ORDER BY installed_at DESC',
  ).all()).results || [];
  return rows.map((r) => {
    try {
      let m = {}; let binding = {};
      try { m = JSON.parse(r.manifest_json) || {}; } catch { /* keep empty */ }
      try { binding = JSON.parse(r.binding_json || '{}') || {}; } catch { /* keep empty */ }
      const p = m.provides || {};
      const dir = pluginDir(r.name);
      return {
        name: r.name, title: r.title, version: r.version, status: r.status,
        format: m.nyyon_plugin || null,
        origin: m.origin || null,
        installed_at: r.installed_at, updated_at: r.updated_at,
        path: dir,
        tools: arr(p.tools).map((t) => ({
          name: t?.name, path: `${dir}/tool-${t?.name}.mjs`, description: t?.def?.description || '',
        })),
        gateways: arr(p.gateways).map((g) => ({
          slug: g?.slug,
          installed_as: bundledGatewaySlug(r.name, g?.slug),
          in_use: binding?.[g?.slug]?.via === 'bundled',
          path: `${dir}/gateway-${g?.slug}.mjs`, service: g?.service || '',
        })),
        gateway_bindings: Object.entries(binding).map(([slug, b]) => ({ slug, via: b?.via, target: b?.target })),
        requires_gateways: arr(m.requires?.gateways).map((g) => ({ slug: g?.slug, modes: arr(g?.modes) })),
        workflows: arr(p.workflows).map((w) => ({
          slug: w?.slug, name: w?.name || w?.slug,
          steps: arr(w?.steps).map((st) => (typeof st === 'string' ? st : st?.tool)).filter(Boolean),
        })),
        knowledge: arr(p.knowledge).map((k) => ({ slug: k?.slug, title: k?.title || k?.slug })),
        tables: arr(m.requires?.tables).map((t) => t?.name),
        // v2 plugins ship no UI surfaces; the field is present so the registry
        // shape is complete and future surface support renders here for free.
        surfaces: arr(p.surfaces).map((sf) => ({ slug: sf?.slug, title: sf?.title, tabs: arr(sf?.tabs).length })),
      };
    } catch (e) {
      // One unreadable row must not 500 the whole registry.
      return { name: r.name, status: r.status, error: String(e?.message || e) };
    }
  });
}

// Every active plugin's surfaces, for the sidebar and the renderer. Only
// `active` plugins appear: a surface whose tools are not yet live would render
// a page whose every button fails.
export async function pluginSurfaces(env) {
  const rows = (await env.DB.prepare(
    "SELECT name, title, manifest_json FROM plugins WHERE status = 'active' ORDER BY name",
  ).all()).results || [];
  const out = [];
  for (const r of rows) {
    let m = {};
    try { m = JSON.parse(r.manifest_json) || {}; } catch { continue; }
    for (const sf of arr(m.provides?.surfaces)) {
      if (!sf?.slug) continue;
      out.push({
        plugin: r.name,
        plugin_title: r.title,
        slug: `${r.name}:${sf.slug}`,
        title: sf.title || sf.slug,
        // 'page' = a real materialized page in the bundle; 'tabs' = declarative.
        kind: (typeof sf.page_code === 'string' && sf.page_code.trim()) ? 'page' : 'tabs',
        tabs: arr(sf.tabs).map((t) => ({ key: t.key, title: t.title, view: t.view || {} })),
      });
    }
  }
  return out;
}

// Run ONE tool belonging to ONE plugin, for that plugin's own surface. Scoped
// deliberately: the surface renderer must not become a way to call the host
// pool from the browser, so a tool that this plugin does not provide is
// refused even though the caller is the signed-in operator.
export async function invokePluginTool(env, pluginName, toolName, input) {
  const row = await env.DB.prepare('SELECT status, manifest_json FROM plugins WHERE name = ?').bind(pluginName).first();
  if (!row) return { ok: false, error: 'unknown plugin' };
  if (row.status !== 'active') return { ok: false, error: `plugin is ${row.status}, not active` };
  let m = {};
  try { m = JSON.parse(row.manifest_json) || {}; } catch { return { ok: false, error: 'stored manifest unreadable' }; }
  const owns = arr(m.provides?.tools).some((t) => t?.name === toolName);
  if (!owns) return { ok: false, error: `"${toolName}" is not a tool this plugin provides` };
  const { runTool } = await import('../tools/index.js');
  try {
    const result = await runTool(env, toolName, input || {});
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function exportPlugin(env, name) {
  const row = await env.DB.prepare('SELECT * FROM plugins WHERE name = ?').bind(name).first();
  if (!row) throw new Error(`unknown plugin: ${name}`);
  const manifest = JSON.parse(row.manifest_json);
  manifest.sha256 = await sha256Hex(manifestPayload(manifest));
  manifest.origin = { ...(manifest.origin || {}), re_exported_at: now() };
  await logEvent(env, { kind: 'plugin_exported', actor: 'operator', payload: { name } });
  return manifest;
}

export async function removePlugin(env, name) {
  const row = await env.DB.prepare('SELECT * FROM plugins WHERE name = ?').bind(name).first();
  if (!row) throw new Error(`unknown plugin: ${name}`);
  let m = {};
  try { m = JSON.parse(row.manifest_json) || {}; } catch { /* keep empty */ }
  for (const w of arr(m.provides?.workflows)) {
    await env.DB.prepare("UPDATE workflows SET status = 'disabled', updated_at = ? WHERE slug = ? AND created_by = ?")
      .bind(now(), w.slug, `plugin:${name}`).run().catch(() => {});
  }
  await env.DB.prepare("UPDATE plugins SET status = 'removed', report_json = '{}', updated_at = ? WHERE name = ?").bind(now(), name).run();
  await logEvent(env, { kind: 'plugin_removed', actor: 'operator', payload: { name } });
  return { ok: true, note: 'code files are cleaned by the applier on its next pass; tables are kept (data is the operator\'s)' };
}
