-- 0020 — Seed the knowledge tree.
--
-- Writes the root + branch documents that turn the flat knowledge index
-- into a navigable tree, then reparents pre-existing docs into their
-- right slots. The shape is:
--
--   knowledge-root
--     ├── nyyon-stack
--     ├── brand → brand-voice
--     ├── module-nyo
--     ├── module-digest
--     ├── module-outbox
--     ├── module-website
--     ├── module-funnel
--     ├── module-channels
--     ├── module-contacts
--     ├── module-blog
--     ├── module-aeo → article-playbook
--     ├── module-calendar
--     ├── module-osint
--     ├── module-workflows
--     ├── system-knowledge → how-knowledge-works
--     ├── system-roadmap → how-roadmap-works
--     ├── system-modules
--     ├── system-tools
--     ├── system-activity
--     ├── system-settings
--     └── system-observability
--
-- Each branch carries the "current state" of that module — file paths,
-- routes, migrations, gotchas, and the path to extend it. The intent is
-- that an LLM (or a new human collaborator) can walk root → branch → leaf
-- and reconstruct the whole product without reading code first.
-- Author-specific content was removed for the shipped product; bodies are
-- neutral and operator-addressed.

-- ────────────────────────────────────────────────────────────────
-- ROOT
-- ────────────────────────────────────────────────────────────────
INSERT OR REPLACE INTO knowledge_docs (slug, title, body, scope, module, parent_slug, updated_at) VALUES
(
  'knowledge-root',
  'Command Center — start here',
  '# Command Center

The operator backstage hub for your company. Everything sits inside this command center: chat with Nyo, the morning digest, the funnel, your public site, contacts, and a growing list of channel integrations.

## What lives here
- **Modules**: surfaces in the sidebar. Each one is a workflow the operator runs. See `system-modules` for the registry; one doc per module below.
- **System tools**: Knowledge (this tree), Roadmap (planned next nodes), Modules registry, Tools registry, Activity log, Settings.
- **Nyo**: the chatbot at the center. Reads this knowledge tree, drives 20+ tools (knowledge CRUD, modules/tools/roadmap, content, feature flags, WhatsApp, LinkedIn).

## Where to start by goal
- **"How is this built?"** → `nyyon-stack`
- **"What does the brand sound like?"** → `brand`
- **"I want to ship a marketing change"** → `module-website` (use the Publish panel)
- **"WhatsApp isn''t sending"** → `module-channels`, then `module-outbox` to see the error row
- **"The morning digest is wrong"** → `module-digest`

## Rules of the house
- **WhatsApp test sends ONLY via `POST /api/wa/test-send`**: it forces the operator''s own number and adds a visible test prefix. Never hit `/api/wa/send` or `/api/digest/:id/execute` from a script.
- **Real sends to real chats only via a UI click.** Never from a script or a smoke test.
- **Cloudflare-only stack**: no separate infra. Pages for the public site, Workers + D1 for the API, local sidecars for the WhatsApp / LinkedIn gateways.

## How this tree is meant to be read
Every doc points at its parent via `parent_slug`. The breadcrumb above any doc is the context route — the chain of things you need to know to fully understand it. Read top-down for orientation, bottom-up when you''re debugging a leaf.',
  'global',
  NULL,
  NULL,
  strftime('%s','now')*1000
),

-- ────────────────────────────────────────────────────────────────
-- STACK + BRAND (orienting branches)
-- ────────────────────────────────────────────────────────────────
(
  'nyyon-stack',
  'Stack — architecture, ports, deploys',
  '# Stack

Cloudflare-only for production. Local sidecars for things Cloudflare can''t do (browser puppeteer, daemons).

## Production surfaces
- **Public site**: a Cloudflare Pages project on your account. The path to production is the Publish panel in `module-website` or a manual `wrangler pages deploy`.
- **API**: a Cloudflare Worker + a single D1 database, deployed with `wrangler deploy` from `workers/api/`.

## Local services (developer machine)
- **Ops UI**: Vite, `http://localhost:5174` (`web/`). React + Tailwind.
- **Public site preview**: Vite, `http://localhost:5176` (`web-public/`).
- **API worker**: wrangler dev, `http://localhost:8788` (`workers/api/`). Hono router + D1.
- **Deploy sidecar**: Node, `http://localhost:8791` (`scripts/deploy-server.mjs`). Runs the build + Pages deploy when the Publish button is clicked.
- **WhatsApp gateway**: `http://localhost:2785/api` (separate repo). WhatsApp Web puppet.
- **LinkedIn gateway**: `http://localhost:2786` (separate repo).

## D1 database
- Single D1 binding `DB`. Migrations in `db/migrations/` (numbered, append-only). Latest migration: see `ls db/migrations/ | tail -3`.
- Local: `wrangler d1 execute <db-name> --local --file=db/migrations/000X.sql` from `workers/api/`.

## How a marketing change ships
1. Edit `web-public/src/...` locally.
2. Vite hot-reloads at :5176.
3. Click Publish in ops UI → Website → Manager.
4. The sidecar runs `npm run build` (snapshot D1 → JSON, vite, prerender blog posts) then `wrangler pages deploy dist --branch=main` against your Pages project.
5. Edge cache propagates in about 30 seconds.',
  'global',
  NULL,
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'brand',
  'Brand — voice, positioning, visual',
  '# Brand

Fill this branch in for your company. Nyo and the content writers read this tree before drafting anything public, so keep it current: who you are, your positioning one-liner, and how you sound.

## Positioning one-liner
Write yours here. One sentence a stranger could repeat.

## Voice
See `brand-voice` for the full writing rules. Keep them short and operational: what to avoid, what a good sentence looks like.

## Visual language
Describe your palette, typography, and layout conventions here so generated assets stay consistent.

## CTA destination
Every "Book a call" surface on the public site is routed through `web-public/src/lib/cta.ts`, so swapping the scheduling link is a one-line change.',
  'global',
  NULL,
  'knowledge-root',
  strftime('%s','now')*1000
),

-- ────────────────────────────────────────────────────────────────
-- MODULE BRANCHES
-- ────────────────────────────────────────────────────────────────
(
  'module-nyo',
  'Module · Nyo — the chatbot',
  '# Nyo

The chatbot at the center. Full-screen page (`web/src/pages/Nyo.tsx`) plus a side drawer that shares the same `ChatProvider` state.

## Today
- SSE streaming. Tool-use loop with 8 hops max.
- Provider-agnostic via `callLLM` → Anthropic or OpenAI.
- 20+ tools: knowledge CRUD, modules/tools/roadmap registry, content blocks, feature flags, WhatsApp send/reply/image/document/react, LinkedIn DMs.
- Reads the channels knowledge docs before any WhatsApp work (auto-prime → /start → poll → send).

## Where it lives
- Worker handler: `workers/api/src/chat/index.js`
- Tools registry: `workers/api/src/chat/tools.js`
- UI: `web/src/pages/Nyo.tsx`, `web/src/components/ChatDrawer.tsx`, `web/src/lib/chat.tsx`

## Provider switch
Set in `workers/api/.dev.vars`:
- `LLM_PROVIDER=openai|anthropic`
- `LLM_MODEL=...` (optional override)
- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`

Health probe at `/api/nyo/brain` reports the active provider + model + key-set status.

## Prompts
System prompts for individual tools live in knowledge docs so they can be edited without a deploy. Example: create a `prompt-wa-reply` doc to override the WhatsApp reply writer''s default prompt.

## How to add a tool
Edit `workers/api/src/chat/tools.js`. Each tool is `{ name, description, input_schema, handler(env, input) }`. The chat loop wires it automatically.',
  'module',
  'nyo',
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'module-digest',
  'Module · Digest — morning brief',
  '# Digest

Pulls actionable items from WhatsApp groups, OSINT mentions, and (soon) email into a single morning brief. Three urgency bands: Action needed / This week / Background.

## Today
- Tabs: **Brief** + **Channels** (`web/src/pages/Digest.tsx`).
- Generate button kicks off `POST /api/digest/generate`. Runs in a module-level singleton (`web/src/lib/digestBackground.ts`) so it survives sidebar navigation — operator can leave and come back.
- "Updated Nm ago" subtitle pulled from `digest_generated` events row.
- Per-item drawer with two-stage fetch: context (fast DB read, ~50ms) + actions (LLM draft, 5-15s). Target message renders instantly; LLM draft streams in.
- Recipient picker — group / private DM / "DM another contact…". LLM-recommended default + reason. Deterministic fallback: if `suggested_action` says "DM <name>" we route to private even when the LLM call hiccups.
- Sender recovery: when the WhatsApp gateway strips `author` from a group message, we extract the author from the trailing segment of the message id (`..._<id>@lid`). Works without contacts or roster lookup.

## Where it lives
- Worker lib: `workers/api/src/lib/digest.js`
- Routes: `GET /api/digest`, `/stats`, `/generate`, `/clear-read`, `/channels`, `/:id`, `/:id/context`, `/:id/actions`, `POST /:id/execute`.
- Drawer: `web/src/components/DigestItemDrawer.tsx`.

## Channels
`digest_channels` table tracks per-source state (whatsapp, calendar, osint, email — toggle, cadence, last run, last error). Surface: Digest → Channels tab.

## Migrations
`0015_digest.sql`, `0016_digest_channels.sql`.

## Customization
- Create a `digest-interests` knowledge doc to tell the LLM what to flag as "of interest".
- Create a `prompt-wa-reply` doc to override the reply writer''s system prompt.

## See also
- `module-channels` — where the raw messages come from
- `module-outbox` — where the failed/successful sends land',
  'module',
  'digest',
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'module-outbox',
  'Module · Outbox — unified send log',
  '# Outbox

Every outbound message — WhatsApp reply/text/image/document/reaction, LinkedIn DM, future email — passes through the send wrappers and lands here. Three states: `queued` → `sent` (with provider message id) or `failed` (with the error text).

## Today
- Sidebar entry "Outbox" (paper-plane Send icon).
- Page: filter bar (channel/status), counts pills, 12-col list, rose tint on failed rows.
- Expand any row for body + payload + Retry button.
- Auto-refresh every 4 seconds.

## Where it lives
- Migration: `db/migrations/0018_outbox.sql` — `outbound_log` table + 5 indexes.
- Worker lib: `workers/api/src/lib/outbox.js`. Helpers: `beginSend`, `markSent`, `markFailed`, `listOutbox`, `getOutboxRow`, `outboxStats`, `retryOutboxRow`.
- Routes: `GET /api/outbox`, `/stats`, `/:id`, `POST /:id/retry`.
- UI: `web/src/pages/Outbox.tsx`.

## How it wraps sends
The 5 WhatsApp send helpers (`replyToWaMessage`, `sendText`, `sendImage`, `sendDocument`, `reactToMessage`) and the LinkedIn `sendDirectMessage` start with `beginSend` (writes a `queued` row), run the provider call, then flip to `sent` (with `message_id`) or `failed` (with `error`). The throw still bubbles so callers can react; the row stays as the audit record.

## Backfill
An optional backfill can seed past WhatsApp outbound messages from `wa_messages` (where `from_me=1`) with `source=''backfill''` so the operator has continuity. Past FAILED sends are not recoverable — they were thrown to the UI and never persisted.

## Retry
`POST /api/outbox/:id/retry` re-fires the original payload via the channel''s sender. Chains via `parent_id` so each retry is its own row.',
  'module',
  'outbox',
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'module-website',
  'Module · Website — content + ship to prod',
  '# Website

Edits your public marketing site and ships it to production from inside the ops UI.

## Today
- Two tabs: **Content** + **Manager** (`web/src/pages/WebsiteContent.tsx`, `WebsiteManager.tsx`).
- **Content** — block-level editor with live preview iframe pointing at `localhost:5176`. Click any block to edit; preview reloads on save.
- **Manager** — Status panel (heartbeat to the production site), **Publish panel** (one-click build + deploy), Pages list, Layout (per-section visibility + reorder via drag), SEO meta editor.
- **Publish** — confirmation modal → calls local sidecar (`scripts/deploy-server.mjs` on :8791) → runs `npm run build && wrangler pages deploy dist --branch=main` in `web-public/`. Live build log streams into the panel.

## Public site features (shipped)
- Blog posts served from D1. Bodies via `prose-body` class. Inline `<aside>` CTA ribbon prerendered into every post for AEO.
- JSON-LD blocks on home (Organization, WebSite, ProfessionalService, FAQPage, HowTo). Full OG + Twitter cards. Canonical. sitemap.xml. robots.txt with AI crawler allows. llms.txt.
- Scheduling popup on every "Book a call" surface via `web-public/src/lib/cta.ts`.
- Dynamic GridLights canvas overlay: cell under cursor + 8 neighbors light up; random ambient flares every 700ms. CSS gridlines use `background-attachment: fixed` so canvas + lines stay aligned during scroll.

## Where it lives
- Public site source: `web-public/src/`
- Build pipeline: `web-public/scripts/snapshot.mjs` (D1 → JSON) → `sitemap.mjs` → vite build → `prerender-blog.mjs` (static HTML per post).
- Worker content routes: `GET/POST/PATCH/DELETE /api/content`, `GET /api/sections/:page`, `PATCH /api/sections/:id`, `POST /api/sections/reorder`.

## Deploying
**Always via the Publish button.** Manual fallback: from `web-public/`, `npm run build && npx wrangler pages deploy dist --project-name=<your-pages-project> --branch=main`.',
  'module',
  'website',
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'module-funnel',
  'Module · Funnel — identity stitching + stages',
  '# Funnel

Tracks every prospect through 9 stages from anonymous web visit to signed client. Identity-stitched across email, phone, WhatsApp, and cookie ID.

## Today
- 5 tabs: Overview / Pipeline / Live / Sessions / Identities / Conversions.
- Stitching: cookie → email → phone via `identity_links` table. Merging is automatic on email or phone match.
- 9 stages: anonymous, lead, mql, sql, opportunity, customer, expansion, churn, recovered.
- Identity drawer shows stage history, conversions, and per-stage advance buttons.

## Where it lives
- Worker lib: `workers/api/src/lib/web.js` (ingest sessions/events, identifyByEmail, conversions, sankey).
- Routes: `/api/web/sessions`, `/api/web/events`, `/api/identities`, `/api/identities/:id`, `/api/conversions`, `/api/funnel/stats`, `/api/funnel/sankey`, `/api/funnel/stages/:stage`.
- Migrations: `0005_funnel.sql`, `0006_identity_links.sql`.
- Tracker JS: `web-public/public/tracker.js` (vanilla, loaded by every public page).',
  'module',
  'funnel',
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'module-channels',
  'Module · Channels — WhatsApp + LinkedIn',
  '# Channels

Inbound + outbound WhatsApp (and LinkedIn). The raw plumbing that feeds the Digest and is fed by Outbox.

## Today
- Two tabs: **Chats** + **Feed**.
- WhatsApp via the bundled gateway at `127.0.0.1:2785`. Its key is generated per install and its session id defaults to `default`.
- Per-chat policy: `auto_listen` (digest it?) + `can_send` (allowed to send to?). Defaults are both OFF.
- 1000ms throttle between gateway calls (`waChain` Promise queue in `whatsapp.js`).
- Send wrappers all flow through Outbox.

## Where it lives
- Worker lib: `workers/api/src/lib/whatsapp.js`, `linkedin.js`.
- Routes: `/api/wa/*`, `/api/li/*`.
- Migration: `0007_whatsapp.sql` (wa_chats, wa_messages).
- Page: `web/src/pages/Channels.tsx`.

## Critical safeguards
- `POST /api/wa/test-send` is the ONLY test endpoint. Forces `WA_TEST_CHAT_ID` (the operator''s own number) + a visible timestamped test prefix.
- Real sends only via UI click. No script ever hits `/api/wa/send` directly.',
  'module',
  'channels',
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'module-contacts',
  'Module · Contacts — operator-curated people',
  '# Contacts

Explicit "I care about this person" decisions on top of the identities table. Identities are auto-created from every funnel touch; contacts are deliberate.

## Today
- Filter bar (search + status + source + owner + tag + starred toggle).
- 12-column list. Click row to expand read-only detail.
- LinkedIn URL field added (migration `0017_contacts_linkedin.sql`).
- Taxonomy:
  - status = prospect | lead | client | past_client | partner | do_not_contact
  - source = referral | inbound_form | inbound_wa | inbound_email | paid_ad | event | cold_outreach | social | other
- Nyo tools: `list_contacts`, `read_contact`, `write_contact`.

## Where it lives
- Migration: `0010_contacts.sql` + `0017_contacts_linkedin.sql`.
- Worker lib: `workers/api/src/lib/db.js` (contacts CRUD).
- Routes: `GET /api/contacts`, `/taxonomy`, `/:id`, `PUT /:id`, `POST /api/contacts`, `DELETE /:id`.
- Page: `web/src/pages/Contacts.tsx`.

## Wishlist hook
The "★ mark interesting" action on a digest item creates or updates a contact via `writeContact`. Auto-extracts LinkedIn / email from the digest context. Tag `wishlist` added; existing status preserved if already client/partner.',
  'module',
  'contacts',
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'module-blog',
  'Module · Blog — posts + featured images',
  '# Blog

The journal published on your public site under `/blog`. Articles are written through Nyo or the Manager.

## Today
- Index with search + tag filters + pagination.
- Per-post page with prerendered Article JSON-LD (`web-public/scripts/prerender-blog.mjs`).
- Inline `<aside>` CTA ribbon at the bottom of every post — visible to AI crawlers without JS.
- Featured image regeneration via Nyo tool `regenerate_blog_image`.

## Where it lives
- Migration: `0003_inner_pages.sql` (blog_posts).
- Worker lib: `workers/api/src/lib/db.js` (blog CRUD) + `blog-images.js`.
- Routes: `/api/blog`, `/:slug`, `/blog/analytics`.
- Public-site routes: `/blog`, `/blog/:slug`.

## Snapshot flow
`web-public/scripts/snapshot.mjs` reads all published posts from the local D1, writes `web-public/public/snapshot/posts.json`, which the SPA reads in production. Sitemap pulls from the same snapshot.',
  'module',
  'blog',
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'module-aeo',
  'Module · AEO — answer engine optimization',
  '# AEO

Generates question-and-answer blog content optimized for AI search engines (ChatGPT, Perplexity, Google AI Overviews, Claude). Cron-driven.

## Today
- Question queue (`aeo_questions` table). Each question has status, attempted_at, last_error.
- Nyo writer: pulls next pending question, drafts a 600-1200 word answer per the `article-playbook` style guide, attaches Article JSON-LD, publishes as a blog post.
- Public site exposes a llms.txt + structured data for AI crawler discovery.

## Where it lives
- Migration: `0011_aeo.sql`.
- Worker lib: `workers/api/src/lib/aeo-writer.js`.
- Routes: `/api/aeo/questions`, `/:id`, `/pending`.
- Page: `web/src/pages/Aeo.tsx`.

## See also
- `article-playbook` — the article structure + style rules',
  'module',
  'aeo',
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'module-calendar',
  'Module · Calendar — events + social posts',
  '# Calendar

Internal calendar — events, social-post schedule, content reminders.

## Today
- Kinds: meeting, content, social, deadline, milestone.
- Statuses: planned, confirmed, done, skipped.
- Per-event payload carries a `social_post` block (platforms, caption, media_url) that external social-scheduling pipelines can consume; on this side it''s informational.

## Where it lives
- Migration: `0012_calendar.sql`.
- Worker lib: `workers/api/src/lib/db.js` (calendar CRUD).
- Routes: `/api/calendar`, `/:id`.
- Page: `web/src/pages/Calendar.tsx`.',
  'module',
  'calendar',
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'module-osint',
  'Module · OSINT — mention scrapers',
  '# OSINT

Watches the open web for mentions of your company, its clients, and competitor names.

## Today
- Sources: HackerNews, Reddit, Stack Overflow, GitHub, App Store, website, DuckDuckGo.
- Targets table (`osint_targets`) + mentions table (`osint_mentions`).
- Per-target listener cadence (manual / daily / hourly) with last_status + last_error.

## Where it lives
- Migrations: `0013_osint.sql`, `0014_osint_listeners.sql`.
- Worker lib: `workers/api/src/lib/osint.js`.
- Routes: `/api/osint/targets`, `/mentions`, `/scrape`, `/listeners`.
- Page: `web/src/pages/Osint.tsx`.

## Roadmap
Next milestone: feed mentions directly into the morning Digest as their own kind.',
  'module',
  'osint',
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'module-workflows',
  'Module · Workflows — multi-step playbooks',
  '# Workflows

Saved multi-step playbooks the operator can run. Each workflow is a sequence of tool calls with parameter prompts.

## Today
- Workflow registry + runs table (`0013_workflows.sql`).
- Page lists workflows with last run timestamp.
- Run history captured for replay/debug.

## Where it lives
- Migration: `0013_workflows.sql`.
- Worker lib: `workers/api/src/lib/db.js` (workflows + workflow_runs).
- Routes: `/api/workflows`, `/:slug`, `/runs`.
- Page: `web/src/pages/Workflows.tsx`.

## Roadmap
Authoring UI is currently bare — workflows are seeded via SQL. Next: visual builder + parameter validation.',
  'module',
  'workflows',
  'knowledge-root',
  strftime('%s','now')*1000
),

-- ────────────────────────────────────────────────────────────────
-- SYSTEM BRANCHES
-- ────────────────────────────────────────────────────────────────
(
  'system-knowledge',
  'System · Knowledge — this tree',
  '# Knowledge

The thing you''re reading right now. A tree of markdown docs that grounds Nyo, orients new collaborators, and survives across sessions.

## Today
- D1 table `knowledge_docs` with columns: slug, title, body, scope (global/module), module, parent_slug, updated_at.
- Tree shape via `parent_slug`. Root is `knowledge-root` with `parent_slug = NULL`.
- Routes: `GET /api/knowledge`, `/:slug`, `/:slug/path` (breadcrumb chain), `PUT /:slug`, `DELETE /:slug`.
- UI: `web/src/pages/Knowledge.tsx`. Sidebar = tree view. Reading pane shows breadcrumb above the body.
- Nyo tools: `list_knowledge`, `read_knowledge`, `write_knowledge`, `delete_knowledge`. All accept `parent_slug` so Nyo can reshape the tree from chat.

## Rules
- Every doc must have a parent except the root. Orphans surface in the UI under "Unparented".
- Delete promotes children to root (no silent cascade — caller can re-parent).
- Module-scoped docs (`scope=''module''`) get an extra `module` tag for filtering.

## See also
- `how-knowledge-works` — older rationale + writing tips',
  'global',
  NULL,
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'system-roadmap',
  'System · Roadmap — planned next nodes',
  '# Roadmap

The shape of "what we''re about to build, and which existing thing it extends." Lives as a graph (`roadmap_nodes` + `roadmap_edges`) and renders as a React Flow canvas.

## Today
- Each node has: id, title, status (shipped / building / planned / idea), description, owner.
- Edges connect a parent (existing) to a child (planned).

## Where it lives
- Worker lib: `workers/api/src/lib/db.js` (roadmap CRUD).
- Routes: `/api/roadmap`, `/nodes`, `/edges`.
- Page: `web/src/pages/Roadmap.tsx` (React Flow).

## See also
- `how-roadmap-works` — older rationale + node lifecycle',
  'global',
  NULL,
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'system-modules',
  'System · Modules registry',
  '# Modules registry

The list every sidebar surface is registered in. `modules` table — slug, name, status, description, surface (UI key, null if headless).

## Today
- See `SELECT slug, status FROM modules` for the current registry.
- Page lists modules with status pill + description; operator can flip status.

## Where it lives
- Schema: `db/schema.sql`.
- Worker lib: `workers/api/src/lib/db.js` (`listModules`, `upsertModule`).
- Routes: `/api/modules`, `/:slug`.
- Page: `web/src/pages/Modules.tsx`.',
  'global',
  NULL,
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'system-tools',
  'System · Tools registry',
  '# Tools registry

Tracks every external service the system talks to — LLM providers, the WhatsApp gateway, LinkedIn, Cloudflare, third-party APIs. Each row reports status (connected / planned / broken) and the env binding name.

## Today
- Status drives the sidebar health dot.
- Page lists tools grouped by kind (llm / image / video / data / channel / storage / analytics).

## Where it lives
- Schema: `db/schema.sql` (`tools` table).
- Worker lib: `workers/api/src/lib/db.js` (`listTools`, `upsertTool`).
- Routes: `/api/tools`, `/:slug`.
- Page: `web/src/pages/Tools.tsx`.',
  'global',
  NULL,
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'system-activity',
  'System · Activity log',
  '# Activity

Every significant thing that happens lands in the `events` table — knowledge edits, contact updates, digest generations, sends, conversions, content edits. The Activity page is the unfiltered tail.

## Today
- Routes: `/api/events?limit=N`.
- Page: `web/src/pages/Activity.tsx` — reverse-chronological feed with kind filter.
- `logEvent({ kind, actor, payload })` is called throughout the worker code.

## Common event kinds
- `digest_generated` — used by the digest "updated Nm ago" subtitle
- `digest_action` — operator clicked Approve/Dismiss/Wishlist on a digest item
- `wa_sent`, `wa_reacted`, `wa_backfill`
- `contact_updated`, `contact_added`, `contact_deleted`
- `content_updated`, `blog_post_updated`
- `knowledge_updated`, `knowledge_deleted`',
  'global',
  NULL,
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'system-settings',
  'System · Settings',
  '# Settings

Operator preferences and feature flags. Three tabs:
- **Appearance** — light / dark / system theme.
- **Sidebar modules** — toggle which surface slugs appear in the sidebar (per-operator preference, stored in localStorage).
- **Feature flags** — D1-backed (`feature_flags` table) toggles that gate features for Nyo + the UI.

## Where it lives
- Schema: `db/schema.sql` (`feature_flags`).
- Routes: `/api/flags`, `/:key`.
- Page: `web/src/pages/Settings.tsx`.
- Theme helpers: `web/src/lib/theme.ts`.',
  'global',
  NULL,
  'knowledge-root',
  strftime('%s','now')*1000
),
(
  'system-observability',
  'System · Observability — health + state',
  '# Observability

How the operator answers "is everything OK right now?" without leaving the dashboard.

## Today
- Sidebar status dot — green / yellow / red — driven by `GET /api/system/health`.
- Checks: D1 reachable, LLM key set, WhatsApp gateway + session, digest channels with errors, OSINT listeners with errors.
- Roll-up: red beats yellow beats green.
- Tooltip on hover shows the failing check + remediation note.

## Where it lives
- Health route: `workers/api/src/index.js` (`/api/system/health`).
- Sidebar dot: `web/src/components/Sidebar.tsx`.',
  'global',
  NULL,
  'knowledge-root',
  strftime('%s','now')*1000
);

-- ────────────────────────────────────────────────────────────────
-- Reparent existing docs into the tree.
-- ────────────────────────────────────────────────────────────────
UPDATE knowledge_docs SET parent_slug = 'brand'            WHERE slug = 'brand-voice';
UPDATE knowledge_docs SET parent_slug = 'module-aeo'       WHERE slug = 'article-playbook';
UPDATE knowledge_docs SET parent_slug = 'system-knowledge' WHERE slug = 'how-knowledge-works';
UPDATE knowledge_docs SET parent_slug = 'system-roadmap'   WHERE slug = 'how-roadmap-works';
UPDATE knowledge_docs SET parent_slug = 'knowledge-root'   WHERE slug = 'about';
-- Reparenting of the author's remaining private docs was removed for the shipped product.
