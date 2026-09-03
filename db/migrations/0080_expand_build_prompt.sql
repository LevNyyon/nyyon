-- The Expand build screen is one prompt and nothing else: the operator copies
-- it into a coding agent, which then asks what they want and guides them.
-- Replaces the earlier prompt plus the manual steps that sat around it.
INSERT INTO knowledge_docs (slug, title, body, scope, parent_slug, created_at, updated_at)
VALUES ('expand-build-prompt', 'Expand build (the prompt)', '# Expand build (the prompt)

I run a nyyon command center. It is my own AI operator: an assistant called Nyo plus modules that are installable plugins. I want you to help me extend it. Ask me what I want, then build it.

## First, get your bearings

Ask me where the code is if you do not already know, then read, in this order: `CLAUDE.md` at the repo root, `docs/DEV-BRIEF.md`, `workers/api/src/gateways/index.js` (which external services this install can reach and with which modes), `workers/api/src/lib/plugins.js` (how a plugin is validated, bound and installed), one existing pack under `plugins/` or `plugins-installable/` end to end, and `plugins-installable/*/CONNECT.md` for how a pack explains itself. Tell me in three sentences what you found before you propose anything.

## Then ask me what I want, one question at a time

Do not assume. Find out:

1. What do I want it to do, in plain words? What should be different after it works?
2. Is this a new module with its own page, a new source of information, a new capability for Nyo, or a change to something that exists?
3. Does it need a service outside this install? Which one, and do I already have an account or a key?
4. What does one useful result look like? Show me the shape you have in mind and get a yes.

If I answer vaguely, ask once more with a concrete example. If what I want needs a login with a password and has no API, tell me plainly that it cannot work and say what would.

## Then place the work in the right layer

nyyon is five layers, and every change belongs to exactly one:

- **gateway** — the boundary to ONE external service. It fetches and translates. It never reasons, never reads knowledge, never decides what matters. A capability string (for example `search`) is how the rest of the system discovers it without knowing its name.
- **tool** — one job, described so Nyo knows when to call it. Reaches the outside world only through a gateway.
- **workflow** — existing tools in a fixed order. No logic of its own.
- **module** — a product area with a page.
- **knowledge** — the editable rules, prompts, thresholds and voices. Anything a person might want to change without code lives here, never as a constant in code.

Say which layer you are touching and why before you write a file.

## Build it as a plugin

Unless I ask otherwise, ship it as a plugin folder, not as a change to the host: `manifest.json` (nyyon_plugin 2), gateways as `gateway-<slug>.mjs` exporting `gateway`, tools as `tools/<name>.mjs` exporting `def` and `run(api, input)`, knowledge as `knowledge/plugin-<name>-*.md`, an optional page under `surface/`, and a `CONNECT.md` that explains to a non-technical person what it does, how to install it, and how to connect anything it needs.

Hard limits, because the install refuses a plugin that breaks them: touch only tables named `plugin_<name>_*`, declare every table in the manifest, no DDL from plugin code, no imports from outside the plugin folder, no environment variables, no secrets in code (a key goes in the plugin''s own table and the person pastes it to Nyo), and every required gateway must either exist on the host with all the modes you use or be bundled in the plugin.

House style for anything a person reads: plain sentences, no em dashes, no exclamation marks, honest errors that name the real cause. Never fake data or a success.

## Prove it before you tell me it works

Run these and fix what they say until all pass:

- `node scripts/pack-plugin.mjs <pack dir> > /tmp/p.json`, then bind and validate it against the host with `bindGateways` and `validateManifest` from `workers/api/src/lib/plugins.js`. Both must be clean.
- `node --check` on every `.mjs`.
- If it has a page, typecheck it the way the repo does for plugin surfaces.
- Every manifest tool entry has a file and every file has an entry; every workflow step names a tool that exists; every knowledge file referenced exists.

Then tell me what you built, what it needs from me, and exactly what to click: Plugins page, upload the zip, wait about a minute.

## While you work

Ask me whenever a choice is mine to make, especially anything that costs money or sends something outward. Tell me what you cannot do instead of working around it. If you find something already broken, say so rather than building on top of it.
', 'global', 'knowledge-root', 1788400000000, 1788400000000)
ON CONFLICT(slug) DO UPDATE SET title=excluded.title, body=excluded.body, updated_at=excluded.updated_at;
