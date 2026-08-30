// The plugin capability boundary — where plugin permissions are ACTUALLY enforced.
//
// WHY THIS FILE EXISTS
// v1 tried to confine plugins by regex-scanning their source before install:
// "no raw fetch", "only plugin_<name>_* tables", "only these imports". An
// adversarial review took that apart in minutes. Every one of these passed the
// source scan and then did whatever it liked at runtime:
//
//   env.DB.prepare('SELECT * FROM ' + 'gateway_config')      // built at runtime
//   env.DB.prepare(input.q)                                  // SQL not in the source at all
//   callGateway(env, 'whatsapp', 'send', …)                  // a gateway never declared
//
// A regex cannot constrain a handle whose queries are assembled at runtime.
// So the boundary moved to where the real values exist: the call itself.
//
// A plugin tool no longer receives `env`. It receives the object built here:
//
//   api.db        — prepare() only, and every statement is parsed AT QUERY TIME
//                   and refused unless every table it touches is plugin_<name>_*
//   api.gateway   — closed over THIS plugin's binding; a slug it did not declare
//                   is not reachable, whatever the source text says
//   api.log       — the activity bus, stamped with the plugin as actor
//
// Nothing else. No credentials, no raw D1 handle, no env. That matters beyond
// the three methods: host libs read secrets off `env`, so a plugin that imports
// one anyway gets a lib with nothing to read.
//
// This is a real boundary, not a promise — but state its limits honestly: it
// confines DATA REACH, not CPU or memory, and a plugin still runs in-process.
// Installing a plugin is still a decision to trust its author.

import { logEvent } from './db.js';

// Gateways a plugin may never bind, whatever it declares. `github` is the cloud
// materializer's repo-write path (a straight line from "install a plugin" to
// "arbitrary code on main"); `deploy` ships the public site.
export const RESERVED_GATEWAYS = new Set(['github', 'deploy']);

export const tableNamespace = (pluginName) => `plugin_${String(pluginName).replace(/-/g, '_')}_`;

// SQL constructs a plugin has no business using. Checked on the normalized
// statement, so casing and whitespace games do not help.
const SQL_BANNED = [
  [/\battach\b/, 'ATTACH'],
  [/\bdetach\b/, 'DETACH'],
  [/\bpragma\b/, 'PRAGMA'],
  [/\bsqlite_(master|schema|temp_master)\b/, 'sqlite internals'],
  [/\bvacuum\b/, 'VACUUM'],
];

// Strip comments and collapse whitespace so the scan sees the real statement.
function normalizeSql(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every table identifier the statement references. Handles bare, "quoted",
// [bracketed] and `backticked` names — all four are valid SQLite.
function tablesIn(normalized) {
  const re = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:"([^"]+)"|\[([^\]]+)\]|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/gi;
  const out = [];
  for (const m of normalized.matchAll(re)) {
    const name = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').toLowerCase();
    // `DELETE FROM (SELECT…)` style subqueries yield keywords, not tables.
    if (name && !['select', 'values'].includes(name)) out.push(name);
  }
  return [...new Set(out)];
}

// Throws unless every table in the statement lives in the plugin's namespace.
export function assertScopedSql(sql, pluginName) {
  const ns = tableNamespace(pluginName);
  const n = normalizeSql(sql);
  if (!n) throw new Error('plugin sql: empty statement');
  // D1's prepare takes ONE statement; a trailing semicolon is fine, an
  // embedded one is a second statement smuggled past the checks below.
  if (n.replace(/;\s*$/, '').includes(';')) {
    throw new Error('plugin sql: multiple statements are not allowed');
  }
  for (const [re, label] of SQL_BANNED) {
    if (re.test(n)) throw new Error(`plugin sql: ${label} is not allowed`);
  }
  const tables = tablesIn(n);
  if (!tables.length) throw new Error(`plugin sql: no table found — plugins may only touch ${ns}* tables`);
  for (const t of tables) {
    if (!t.startsWith(ns)) {
      throw new Error(`plugin sql: table "${t}" is outside this plugin's namespace (${ns}*)`);
    }
  }
  return true;
}

// A D1 handle that can only see the plugin's own tables. Deliberately exposes
// prepare() ALONE: batch/exec/dump would each need their own parsing, and a
// plugin has no need for them.
function scopedDb(env, pluginName) {
  return {
    prepare(sql) {
      assertScopedSql(sql, pluginName);
      return env.DB.prepare(sql);
    },
  };
}

// The plugin's view of the gateway layer: only the slugs its manifest declared
// and the import bound. The binding map is materialized beside the tool, so
// this holds even though the plugin's source is never rewritten.
function scopedGateway(env, pluginName, binding) {
  return async (slug, mode, input) => {
    const b = binding && binding[slug];
    if (!b) {
      const declared = Object.keys(binding || {});
      throw new Error(
        `plugin gateway: "${slug}" was not declared by this plugin `
        + `(declared: ${declared.length ? declared.join(', ') : 'none'})`,
      );
    }
    if (RESERVED_GATEWAYS.has(slug) || RESERVED_GATEWAYS.has(b.target)) {
      throw new Error(`plugin gateway: "${slug}" is reserved and can never be used by a plugin`);
    }
    const { callGateway } = await import('../gateways/index.js');
    return callGateway(env, b.target, mode, input);
  };
}

// Build one plugin's capability object. Called by the GENERATED
// plugins/index.js wrapper — plugin code never constructs its own.
export function pluginApi(env, pluginName, binding) {
  return {
    db: scopedDb(env, pluginName),
    gateway: scopedGateway(env, pluginName, binding || {}),
    log: (kind, payload) => logEvent(env, {
      kind: `plugin_${String(pluginName).replace(/-/g, '_')}_${kind}`,
      actor: `plugin:${pluginName}`,
      payload: payload || {},
    }),
    plugin: { name: pluginName, tables: tableNamespace(pluginName), gateways: Object.keys(binding || {}) },
  };
}

// The installed-as key for a bundled gateway. Double underscores because a
// single dash is ambiguous: plugin "a-b" + slug "c" and plugin "a" + slug "b-c"
// both produced "plugin-a-b-c", so one plugin could silently shadow another's
// gateway. Neither component may contain "__" (NAME_RE forbids it).
export const bundledGatewaySlug = (pluginName, slug) => `plugin__${pluginName}__${slug}`;

// A bundled gateway is FOREIGN CODE registered in the host gateway registry —
// the one place raw fetch is legitimate. It must not therefore receive the
// host's resolved credentials. Each mode runs against a projection: the
// plugin's own scoped DB and nothing else.
export function wrapGatewayModes(modes, pluginName) {
  const out = {};
  for (const [mode, fn] of Object.entries(modes || {})) {
    if (typeof fn !== 'function') continue;
    out[mode] = (env, input) => fn({ DB: scopedDb(env, pluginName) }, input);
  }
  return out;
}
