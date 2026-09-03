-- Expand build: the single prompt the page hands to a coding agent.
-- The page (web/src/pages/ExpandBuild.tsx) renders this doc with {{REPO}}
-- substituted at render time and a copy button. It is a prompt, and prompts
-- are knowledge: operators edit it as their build diverges. INSERT OR IGNORE
-- so an operator's edited copy is never clobbered.
INSERT OR IGNORE INTO knowledge_docs (slug, title, body, parent_slug, updated_at)
VALUES ('expand-build-prompt', 'Expand build — the coding-agent prompt', '# Expand this system

You are a coding agent working on a nyyon: a self-contained AI command center the operator owns. One repo holds everything: a Cloudflare Worker API, a React SPA, a D1 database, and installable plugins. The checkout IS the install. Work inside it, in its style, and leave every layer where it belongs.

## 0. Where you are

The repo root is: {{REPO}}

Key paths:
- workers/api/src : the Worker (API, chat engine, gateways, tools, libs)
- web/src : the SPA (pages, components; plugin pages materialize into web/src/plugins/)
- plugins/ : plugin packs (source of truth for every module)
- db/migrations/ : append-only SQL migrations
- scripts/ : pack-plugin.mjs, materialize-bundled.mjs, bundle-schema.mjs
- CLAUDE.md : repo rules. Read it first. It wins over this prompt where they differ.

## 1. Connect to Cloudflare

1. npm install -g wrangler
2. wrangler login  (opens the browser; the operator approves)
3. wrangler whoami  (verify the right account)
4. Local dev: run the dev server the repo way (see CLAUDE.md / package.json scripts). The Worker runs with a local D1 under workers/api/.wrangler/state; deleting that directory resets the install.
5. Deploy: from workers/api, wrangler deploy. Database: wrangler d1 create <name> once, then wrangler d1 migrations apply. Secrets: wrangler secret put <NAME>. Model keys the operator pastes in Settings live DB-first in gateway_config; env vars are only the fallback.

## 2. Get nyyon-lite

The framework is this repo plus the rules below. To start a fresh system instead of extending this one: git clone https://github.com/LevNyyon/nyyon.git and strip the packs you do not need from plugins/.

## 3. The framework: five layers, strict

Every capability decomposes into exactly these layers. Put each change in its layer and nowhere else.

1. GATEWAY: the boundary to ONE external service (one file, one service, no reasoning, no business logic). It translates in and out, holds the service''s protocol quirks, and is the only place that touches the network for that service. Register it with modes and, when generic, a capability tag so the host discovers it by capability, never by name.
2. TOOL: one job with a name, a description a model can act on, and a strict input schema. Tools reach services only through gateways, live in one shared pool, and return {ok, ...} or {ok:false, error}. No tool calls another tool''s internals.
3. WORKFLOW: an ordered list of existing tools. No new logic inside; if you need logic, you are missing a tool.
4. MODULE: a product area with a UI page. Every module ships a visualization; a module without a screen is a library, not a module.
5. KNOWLEDGE: editable rules, prompts, thresholds, and voices as markdown docs in the knowledge tree. Behavior an operator might tune goes here, never hardcoded. Docs win over baked defaults; code falls back if a doc is missing.

Guardrails, non-negotiable:
- Gateways never reason. Tools never speak to services directly. Workflows never branch.
- Everything that mutates logs to the activity bus (events table) with actor and payload.
- Files are written whole; no append-patching of source files.
- Migrations are append-only; never edit an applied migration.
- Never edit generated files (workers/api/src/plugins/index.js, web/src/plugins/, workers/api/src/generated/): regenerate them with the scripts.
- All copy the system composes obeys the dont-sound-ai knowledge doc: it is welded into every prompt; do not remove the weld.

## 4. Build new things as PLUGINS

A module you add ships as a plugin pack in plugins/<name>/:
- manifest.json (nyyon_plugin: 2): name, version, description, requires (gateways it consumes, tables it owns), provides (gateways, tools, workflows, knowledge, surfaces).
- Namespaces are law: tables plugin_<name>_* (underscores), knowledge slugs plugin-<name>-*, gateways one per external service.
- Pack code is sealed: no imports from the host; each file receives a capability object (api.db scoped to your tables, api.gateway bound to declared gateways, api.knowledge for declared docs, api.log). Cross-pack reads are declared in requires and must degrade gracefully when the other pack is absent.
- A surface is a React page (page_file) plus optional files; it talks only to its own plugin''s tools over /api/plugins/<name>/invoke/<tool>.
- Validate and package: node scripts/pack-plugin.mjs plugins/<name> (JSON), or zip the folder. Install through the Plugins page (upload zip or paste manifest); the applier binds, materializes, and activates it live.
- Bundled-by-default packs are listed by presence in plugins/; after changing any, run node scripts/materialize-bundled.mjs and rebuild the web app.

## 5. How to work

- Before finishing any change, review it against the guardrails above.
- Test against the running install; prove a tool by invoking it, not by reading it.
- When a rule or prompt should be operator-tunable, put it in a knowledge doc and read it at runtime with a baked fallback.
- Report what you did in plain words: what changed, where, and how you verified it.
', 'knowledge-root', 1788370000000);
