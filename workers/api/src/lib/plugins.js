// Plugins — trade capabilities between nyyon-lite systems.
//
// The contract is docs/plugin-format.md (v1); this file is its executor:
// validate → bind gateways → activate data → hand code to the applier. The
// whole point is MINIMAL reasoning: code is installed verbatim; the single
// permitted modification is which gateway a callGateway line targets, and
// that rewrite is a mechanical string substitution recorded in the binding.
//
// A Worker cannot load new code at runtime, so tools/bundled gateways are
// materialized by an applier (self-hosted: the bundled sidecar writes files
// and restarts; cloud: a GitHub commit + CI). Everything that is data —
// workflows, knowledge, tables — activates instantly at import.
//
// Statuses: imported → bound → materialized → active | blocked | removed.
// Every transition logs to the activity bus.

import { logEvent, writeKnowledge } from './db.js';
import { now } from './util.js';

const FORMAT_VERSION = 1;
const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const TOOL_RE = /^[a-z][a-z0-9_]{1,60}$/;
// The ONLY imports plugin tool code may carry (gateway code: db line only).
const ALLOWED_IMPORTS = [
  /^import\s*{[^}]+}\s*from\s*'\.\.\/\.\.\/gateways\/index\.js';?$/,
  /^import\s*{[^}]+}\s*from\s*'\.\.\/\.\.\/lib\/db\.js';?$/,
];
const FORBIDDEN = [
  [/\beval\s*\(/, 'eval'], [/new\s+Function/, 'new Function'],
  [/\bimport\s*\(/, 'dynamic import'], [/\brequire\s*\(/, 'require'],
  [/\bprocess\./, 'process'],
];

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const manifestPayload = (m) => JSON.stringify({ requires: m.requires || {}, provides: m.provides || {} });

// ─── validation (pure + host-aware, no mutations) ────────────────

function checkCode(code, { kind, toolName, pluginName }) {
  const errors = [];
  const lines = String(code || '').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('import ')) {
      const ok = kind === 'gateway'
        ? ALLOWED_IMPORTS[1].test(t)
        : ALLOWED_IMPORTS.some((re) => re.test(t));
      if (!ok) errors.push(`${kind} ${toolName}: forbidden import: ${t.slice(0, 80)}`);
    }
  }
  for (const [re, label] of FORBIDDEN) {
    if (re.test(code)) errors.push(`${kind} ${toolName}: forbidden construct: ${label}`);
  }
  if (kind === 'tool' && /\bfetch\s*\(/.test(code)) {
    errors.push(`tool ${toolName}: raw fetch() — tools reach the world through gateways only`);
  }
  if (kind === 'tool') {
    if (!/export\s+const\s+def\s*=/.test(code)) errors.push(`tool ${toolName}: missing "export const def"`);
    if (!/export\s+async\s+function\s+run\s*\(/.test(code)) errors.push(`tool ${toolName}: missing "export async function run("`);
  }
  if (kind === 'gateway' && !/export\s+const\s+gateway\s*=/.test(code)) {
    errors.push(`gateway ${toolName}: missing "export const gateway"`);
  }
  // D1 namespace: any obvious table literal outside the plugin's namespace.
  const tables = [...String(code).matchAll(/\b(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_][a-z0-9_]*)/gi)].map((m2) => m2[1].toLowerCase());
  for (const t of new Set(tables)) {
    if (!t.startsWith(`plugin_${pluginName.replace(/-/g, '_')}_`) && !['sqlite_master'].includes(t)) {
      errors.push(`${kind} ${toolName}: touches table "${t}" outside the plugin namespace plugin_${pluginName.replace(/-/g, '_')}_*`);
    }
  }
  return errors;
}

function checkDdl(ddl, pluginName) {
  const ns = `plugin_${pluginName.replace(/-/g, '_')}_`;
  const errors = [];
  const stmts = String(ddl || '').split(';').map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) {
    const ok = new RegExp(`^CREATE (TABLE|INDEX) IF NOT EXISTS (idx_)?${ns}`, 'i').test(s.replace(/\s+/g, ' '));
    if (!ok) errors.push(`ddl: refused statement (only CREATE TABLE/INDEX IF NOT EXISTS ${ns}* allowed): ${s.slice(0, 90)}`);
  }
  return { errors, stmts };
}

export async function validateManifest(env, m) {
  const errors = [];
  if (!m || m.nyyon_plugin !== FORMAT_VERSION) errors.push(`nyyon_plugin must be ${FORMAT_VERSION}`);
  if (!NAME_RE.test(m?.name || '')) errors.push('name: kebab-case slug required');
  if (!m?.title || !m?.version) errors.push('title + version required');
  if (errors.length) return { ok: false, errors };

  const p = m.provides || {};
  const tools = p.tools || [];
  const gateways = p.gateways || [];
  if (!tools.length && !(p.workflows || []).length && !(p.knowledge || []).length) {
    errors.push('provides: empty plugin');
  }
  if (m.sha256) {
    const got = await sha256Hex(manifestPayload(m));
    if (got !== m.sha256) errors.push('sha256 mismatch — manifest was altered in transit');
  }

  for (const t of tools) {
    if (!TOOL_RE.test(t?.name || '')) errors.push(`tool name invalid: ${t?.name}`);
    if (t?.def?.name !== t?.name) errors.push(`tool ${t?.name}: def.name mismatch`);
    errors.push(...checkCode(t?.code || '', { kind: 'tool', toolName: t?.name, pluginName: m.name }));
  }
  for (const g of gateways) {
    if (!NAME_RE.test(g?.slug || '')) errors.push(`gateway slug invalid: ${g?.slug}`);
    errors.push(...checkCode(g?.code || '', { kind: 'gateway', toolName: g?.slug, pluginName: m.name }));
  }
  for (const tb of (m.requires?.tables || [])) errors.push(...checkDdl(tb?.ddl, m.name).errors);

  // Host collisions: a plugin may not shadow an existing pool tool.
  try {
    const { visibleToolDefs } = await import('../tools/index.js');
    const names = new Set((await visibleToolDefs(env)).map((d) => d.name));
    for (const t of tools) if (names.has(t.name)) errors.push(`tool ${t.name}: name collides with the host pool`);
  } catch { /* pool unavailable — collision check skipped, applier will surface it */ }

  // Workflow steps must exist post-install (host pool + this plugin's tools).
  try {
    const { visibleToolDefs } = await import('../tools/index.js');
    const names = new Set((await visibleToolDefs(env)).map((d) => d.name));
    for (const t of tools) names.add(t.name);
    for (const w of (p.workflows || [])) {
      for (const st of (w.steps || [])) {
        const stepName = typeof st === 'string' ? st : st?.tool;
        if (stepName && !names.has(stepName)) errors.push(`workflow ${w.slug}: step "${stepName}" exists in neither the host pool nor this plugin`);
      }
    }
  } catch { /* same fallback */ }

  return { ok: !errors.length, errors };
}

// ─── gateway binding (mechanical) ────────────────────────────────

export async function bindGateways(env, m) {
  const { listGateways } = await import('../gateways/index.js');
  const host = Object.fromEntries(listGateways().map((g) => [g.slug, new Set(g.modes)]));
  const bundled = Object.fromEntries((m.provides?.gateways || []).map((g) => [g.slug, g]));
  const binding = {};
  const errors = [];
  for (const req of (m.requires?.gateways || [])) {
    const have = host[req.slug];
    const modesOk = have && (req.modes || []).every((mode) => have.has(mode));
    if (modesOk) { binding[req.slug] = { via: 'host', target: req.slug }; continue; }
    if (bundled[req.slug]) { binding[req.slug] = { via: 'bundled', target: `plugin-${m.name}-${req.slug}` }; continue; }
    const missing = have ? (req.modes || []).filter((mode) => !have.has(mode)) : req.modes;
    errors.push(`gateway ${req.slug}: host ${have ? `lacks modes [${missing}]` : 'does not have it'} and the plugin bundles no replacement`);
  }
  return { ok: !errors.length, binding, errors };
}

// The one permitted code modification: retarget callGateway at bundled slugs.
export function applyBinding(code, binding) {
  let out = String(code);
  for (const [slug, b] of Object.entries(binding)) {
    if (b.via !== 'bundled') continue;
    out = out.replaceAll(`callGateway(env, '${slug}'`, `callGateway(env, '${b.target}'`)
             .replaceAll(`callGateway(env, "${slug}"`, `callGateway(env, "${b.target}"`);
  }
  return out;
}

// ─── the import pipeline ─────────────────────────────────────────

export async function importPlugin(env, manifest, { actor = 'operator' } = {}) {
  const name = manifest?.name || 'unknown';
  const save = (status, extra = {}) => env.DB.prepare(
    `INSERT INTO plugins (name, version, title, status, manifest_json, binding_json, report_json, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET version = excluded.version, title = excluded.title, status = excluded.status,
       manifest_json = excluded.manifest_json, binding_json = excluded.binding_json,
       report_json = excluded.report_json, updated_at = excluded.updated_at`,
  ).bind(name, manifest?.version || '0', manifest?.title || name, status,
    JSON.stringify(manifest), JSON.stringify(extra.binding || {}), JSON.stringify(extra.report || {}),
    now(), now()).run();

  const v = await validateManifest(env, manifest);
  if (!v.ok) {
    await save('blocked', { report: { step: 'validate', errors: v.errors } });
    await logEvent(env, { kind: 'plugin_blocked', actor, payload: { name, errors: v.errors.slice(0, 10) } });
    return { ok: false, status: 'blocked', errors: v.errors };
  }

  const b = await bindGateways(env, manifest);
  if (!b.ok) {
    await save('blocked', { binding: b.binding, report: { step: 'bind', errors: b.errors } });
    await logEvent(env, { kind: 'plugin_blocked', actor, payload: { name, errors: b.errors } });
    return { ok: false, status: 'blocked', errors: b.errors };
  }

  // Data activates now: tables, workflows, knowledge.
  for (const tb of (manifest.requires?.tables || [])) {
    for (const stmt of checkDdl(tb.ddl, name).stmts) await env.DB.prepare(stmt).run();
  }
  for (const w of (manifest.provides?.workflows || [])) {
    await env.DB.prepare(
      `INSERT INTO workflows (slug, name, description, trigger, steps, source, status, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'plugin', 'active', ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, description = excluded.description,
         steps = excluded.steps, status = 'active', updated_at = excluded.updated_at`,
    ).bind(w.slug, w.name || w.slug, w.goal || w.description || null,
      JSON.stringify({ kind: 'manual' }), JSON.stringify(w.steps || []), now(), now(), `plugin:${name}`).run();
  }
  for (const k of (manifest.provides?.knowledge || [])) {
    await writeKnowledge(env, { slug: k.slug, title: k.title || k.slug, body: k.body || '', scope: 'global', module: null, parent_slug: 'knowledge-root' }).catch(() => {});
  }

  const hasCode = (manifest.provides?.tools || []).length || (manifest.provides?.gateways || []).length;
  await save(hasCode ? 'bound' : 'active', { binding: b.binding, report: { step: hasCode ? 'awaiting-applier' : 'done' } });
  await logEvent(env, { kind: 'plugin_imported', actor, payload: { name, version: manifest.version, binding: b.binding, needs_materialization: !!hasCode } });
  return { ok: true, status: hasCode ? 'bound' : 'active', binding: b.binding };
}

// ─── materialization (consumed by the applier) ───────────────────

const pluginDir = (name) => `workers/api/src/plugins/${name}`;

export function filesFor(manifest, binding) {
  const files = [];
  for (const t of (manifest.provides?.tools || [])) {
    files.push({ path: `${pluginDir(manifest.name)}/tool-${t.name}.mjs`, content: applyBinding(t.code, binding) });
  }
  for (const g of (manifest.provides?.gateways || [])) {
    files.push({ path: `${pluginDir(manifest.name)}/gateway-${g.slug}.mjs`, content: g.code });
  }
  return files;
}

// plugins/index.js is GENERATED, fully, from the set of installed plugins —
// deterministic, no reading of the previous file, so the applier is idempotent.
export function generateIndex(rows) {
  const lines = [
    '// GENERATED by the Plugins module — do not edit by hand.',
    '// Aggregates every installed plugin into the tool pool and gateway registry.',
  ];
  const toolRefs = [];
  const gwRefs = [];
  let i = 0;
  for (const row of rows) {
    const m = JSON.parse(row.manifest_json);
    for (const t of (m.provides?.tools || [])) {
      const v = `p${i++}`;
      lines.push(`import * as ${v} from './${m.name}/tool-${t.name}.mjs';`);
      toolRefs.push(`  [${v}.def.name]: { def: ${v}.def, run: ${v}.run },`);
    }
    for (const g of (m.provides?.gateways || [])) {
      const v = `p${i++}`;
      lines.push(`import * as ${v} from './${m.name}/gateway-${g.slug}.mjs';`);
      gwRefs.push(`  'plugin-${m.name}-${g.slug}': { ...${v}.gateway, slug: 'plugin-${m.name}-${g.slug}' },`);
    }
  }
  lines.push('', 'export const pluginTools = {', ...toolRefs, '};', '', 'export const pluginGateways = {', ...gwRefs, '};', '');
  return lines.join('\n');
}

export async function pendingMaterializations(env) {
  const pending = (await env.DB.prepare("SELECT * FROM plugins WHERE status = 'bound'").all()).results || [];
  const installed = (await env.DB.prepare("SELECT * FROM plugins WHERE status IN ('bound','materialized','active')").all()).results || [];
  return {
    pending: pending.map((r) => ({ name: r.name, files: filesFor(JSON.parse(r.manifest_json), JSON.parse(r.binding_json || '{}')) })),
    index_file: { path: 'workers/api/src/plugins/index.js', content: generateIndex(installed) },
    remove: ((await env.DB.prepare("SELECT name FROM plugins WHERE status = 'removed'").all()).results || []).map((r) => r.name),
  };
}

export async function markMaterialized(env, name, { ok, error = null } = {}) {
  await env.DB.prepare('UPDATE plugins SET status = ?, report_json = ?, updated_at = ? WHERE name = ?')
    .bind(ok ? 'materialized' : 'blocked', JSON.stringify({ step: 'materialize', error }), now(), name).run();
  await logEvent(env, { kind: ok ? 'plugin_materialized' : 'plugin_blocked', actor: 'applier', payload: { name, error } });
  return { ok };
}

// Post-restart/deploy verification: the plugin's tools must be in the live pool.
export async function verifyPlugin(env, name) {
  const row = await env.DB.prepare('SELECT * FROM plugins WHERE name = ?').bind(name).first();
  if (!row) return { ok: false, error: 'unknown plugin' };
  const m = JSON.parse(row.manifest_json);
  const { visibleToolDefs } = await import('../tools/index.js');
  const names = new Set((await visibleToolDefs(env)).map((d) => d.name));
  const missing = (m.provides?.tools || []).map((t) => t.name).filter((n) => !names.has(n));
  if (missing.length) return { ok: false, error: `tools not live yet: ${missing.join(', ')}` };
  await env.DB.prepare("UPDATE plugins SET status = 'active', updated_at = ? WHERE name = ?").bind(now(), name).run();
  await logEvent(env, { kind: 'plugin_active', actor: 'system', payload: { name } });
  return { ok: true };
}

export async function listPlugins(env) {
  const rows = (await env.DB.prepare('SELECT name, version, title, status, binding_json, report_json, installed_at, updated_at FROM plugins ORDER BY installed_at DESC').all()).results || [];
  return rows.map((r) => ({ ...r, binding: JSON.parse(r.binding_json || '{}'), report: JSON.parse(r.report_json || '{}'), binding_json: undefined, report_json: undefined }));
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
  const m = JSON.parse(row.manifest_json);
  for (const w of (m.provides?.workflows || [])) {
    await env.DB.prepare("UPDATE workflows SET status = 'disabled', updated_at = ? WHERE slug = ?").bind(now(), w.slug).run();
  }
  await env.DB.prepare("UPDATE plugins SET status = 'removed', updated_at = ? WHERE name = ?").bind(now(), name).run();
  await logEvent(env, { kind: 'plugin_removed', actor: 'operator', payload: { name } });
  return { ok: true, note: 'code files are cleaned by the applier on its next pass; tables are kept (data is the operator\'s)' };
}
