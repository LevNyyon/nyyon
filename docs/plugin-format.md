# Nyyon Plugin Format — v1 (canonical)

One plugin = one JSON document. This file is the contract; both the exporter
and the importer validate against it and REFUSE anything that steps outside.
The design goal is a trade with minimal reasoning: code travels verbatim, the
only thing an importer may modify is which gateway a `callGateway` line
targets, and it does that mechanically.

## The manifest

```json
{
  "nyyon_plugin": 1,
  "name": "web-headline",
  "title": "Web Headline",
  "version": "1.0.0",
  "description": "One paragraph: what the plugin does for the operator.",
  "origin": { "system": "cmd.nyyon.com", "exported_at": 1787900000000 },
  "requires": {
    "gateways": [
      { "slug": "web", "modes": ["text"], "purpose": "fetch the page to headline" }
    ],
    "tables": [
      { "name": "plugin_web_headline_log", "ddl": "CREATE TABLE IF NOT EXISTS plugin_web_headline_log (id TEXT PRIMARY KEY, url TEXT, title TEXT, at INTEGER);" }
    ]
  },
  "provides": {
    "tools": [
      { "name": "read_page_headline", "def": { "name": "read_page_headline", "description": "…", "input_schema": {} }, "code": "<ESM module source>" }
    ],
    "workflows": [
      { "slug": "headline-sweep", "name": "Headline sweep", "goal": "…", "steps": ["read_page_headline"] }
    ],
    "knowledge": [
      { "slug": "plugin-web-headline", "title": "…", "body": "…" }
    ],
    "gateways": [
      { "slug": "example", "service": "…", "modes": ["fetch"], "code": "<ESM module source>" }
    ]
  },
  "sha256": "<hex sha-256 of the canonical provides+requires JSON>"
}
```

## Tool code contract (machine-enforced)

Each tool ships as one standalone ESM module:

```js
import { callGateway } from '../../gateways/index.js';   // optional
import { logEvent, readKnowledge, writeKnowledge } from '../../lib/db.js'; // optional

export const def = { name: 'read_page_headline', description: '…', input_schema: { /* … */ } };
export async function run(env, input, ctx) { /* … return JSON-safe data */ }
```

Hard rules the validator enforces on `code` (import is REFUSED otherwise):

1. Imports ONLY from the two whitelisted paths above. Nothing else — no npm
   packages, no other lib files, no other plugins.
2. No `fetch(`, no `eval`, no `new Function`, no `import(` (dynamic), no
   `process`, no `require(`. A tool reaches the world through gateways only.
3. `export const def` and `export async function run` must both exist, and
   `def.name` must equal the manifest tool name.
4. D1 access is allowed via `env.DB`, but only against tables named
   `plugin_<plugin-name>_*` (the plugin's own namespace) — enforced by
   review of the DDL list, and by the table namespace rule below.

## Bundled gateway contract

A plugin MAY bundle a gateway for a service the host might not have:

```js
export const gateway = {
  slug: 'example', service: '…', description: '…',
  modes: { fetch: async (env, input) => { /* may use fetch() — this IS the boundary */ } },
};
```

Bundled gateway code may use `fetch` (it is the service boundary) but has the
same import whitelist (db.js only; a gateway never calls another gateway) and
must do NO reasoning — no LLM calls, no business rules.

## Tables

`requires.tables[].ddl` must consist ONLY of statements matching
`CREATE TABLE IF NOT EXISTS plugin_<name>_…` or
`CREATE INDEX IF NOT EXISTS idx_plugin_<name>_…`. Anything else is refused.
Applied at import time (idempotent by construction).

## Import pipeline (what the receiving system does)

1. **Validate** — schema shape, sha256, code contracts, DDL namespace,
   workflow steps reference tools that will exist post-install, no name
   collisions with the host pool. Any failure = the plugin is stored as
   `blocked` with a precise report; nothing activates.
2. **Bind gateways** — for each `requires.gateways` entry, in order:
   a. Host has the slug with every required mode → bind to host. No changes.
   b. Plugin bundles that slug → install it namespaced
      `plugin-<name>-<slug>` and MECHANICALLY rewrite the plugin's own
      `callGateway(env, '<slug>'` call sites to the namespaced slug.
   c. Neither → `blocked`, report names the missing slug+modes.
   The binding decision is recorded verbatim in the plugin row.
3. **Activate data** — workflows, knowledge docs, tables: applied immediately
   (they are data; a Worker can do this at runtime).
4. **Materialize code** — tools + bundled gateways are files; a Worker cannot
   load new code at runtime, so an applier writes them:
   - Self-hosted (VM): the bundled applier service writes
     `workers/api/src/plugins/<name>/…`, regenerates
     `workers/api/src/plugins/index.js` from the full set of active plugins,
     and restarts the app. Seconds.
   - Cloud (cmd): the worker commits the same files through the GitHub API
     and CI redeploys. Minutes.
5. **Verify** — after materialization the plugin's tools must appear in the
   live pool; only then does status become `active`.

Statuses: `imported → bound → materialized → active`, or `blocked` (with
report) at any step, or `removed`. Every transition logs to the activity bus.

## Export

Exporting an installed plugin re-emits its manifest verbatim (round-trip
safe). Authoring a NEW plugin happens in the Plugins module: workflows and
knowledge can be lifted from the host directly (they are data); tool code is
authored as plugin code from the start. Host tools that predate the plugin
system do not have runtime-readable source and cannot be auto-exported — by
design, not omission.

## What is deliberately NOT in v1

- No remote registries, no auto-updates, no dependency graphs between plugins.
- No LLM-assisted call-site adaptation (the `b` path covers the honest cases;
  when modes mismatch, a human decides).
- No UI surfaces in plugins (tools/workflows/knowledge/gateways only).
