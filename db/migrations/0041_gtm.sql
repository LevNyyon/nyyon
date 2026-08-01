-- GTM module — gtm-blackbox (GTM Builder) folded into the command center as one
-- module with stage tabs: Intake → Enrich → Outreach (+ You). Port of the
-- product-flow tables (leads / batches / org people / outreach angles); the
-- system layers (knowledge, activity, chat) reuse the command center's own.
-- Gateways are the SHARED ones: wa-gateway + linkedin-gateway tunnels; PDL /
-- SerpApi / Twilio / theorg are direct SaaS calls (secrets, optional).

-- One row per prospect through the whole pipeline. Ported from gtm-blackbox's
-- wide `leads` table (its 15 ALTERs flattened); dropped: org_chart (dead legacy
-- column). Added: client_id (link into the Pipeline CRM once a lead becomes a
-- deal). Stage is DERIVED, not stored: "green" = first+last name + company +
-- linkedin + position all present (see leadState in lib/gtm.js).
CREATE TABLE IF NOT EXISTS gtm_leads (
  id               TEXT PRIMARY KEY,          -- 'gl_...'
  phone            TEXT NOT NULL,             -- as pasted
  normalized_phone TEXT,                      -- E.164, dedupe key
  status           TEXT NOT NULL DEFAULT 'new', -- new | enriched
  source           TEXT,                      -- operator note: where the list came from
  batch_id         TEXT,                      -- gtm_batches.id
  country          TEXT,
  region           TEXT,
  name             TEXT,
  photo            TEXT,                      -- R2 public URL
  socials          TEXT NOT NULL DEFAULT '[]',-- [{type,url,src,at}]
  linkedin         TEXT,
  email            TEXT,
  company          TEXT,
  position         TEXT,                      -- job title
  line_type        TEXT,                      -- twilio
  carrier          TEXT,                      -- twilio
  sources          TEXT NOT NULL DEFAULT '{}',-- per-field provenance {field:{tool,at}}
  conflicts        TEXT NOT NULL DEFAULT '[]',-- [{field,value,tool,at}] never overwrite
  dismissed        TEXT NOT NULL DEFAULT '[]',-- tombstoned social URLs, never re-add
  active_tool      TEXT,                      -- transient: live enrich badge
  org_status       TEXT,                      -- null | saved | warn | none
  org_note         TEXT,
  theorg_slug      TEXT,                      -- operator override for namesakes
  icp_fit          TEXT,                      -- strong | medium | weak
  icp_reasons      TEXT,                      -- JSON {reasons:[],gaps:[]}
  company_li_id    TEXT,                      -- cached numeric LinkedIn company id
  open_positions   TEXT,                      -- JSON [{title,location,url,posted_at}]
  positions_checked_at INTEGER,
  outreach_lang    TEXT,                      -- per-lead override, e.g. 'en'
  client_id        TEXT,                      -- link into clients (Pipeline CRM)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gtm_leads_phone  ON gtm_leads(normalized_phone);
CREATE INDEX IF NOT EXISTS idx_gtm_leads_batch  ON gtm_leads(batch_id);
CREATE INDEX IF NOT EXISTS idx_gtm_leads_status ON gtm_leads(status);

-- One row per import so the Intake tab lists previous lists.
CREATE TABLE IF NOT EXISTS gtm_batches (
  id         TEXT PRIMARY KEY,                -- 'gb_...'
  source     TEXT,
  via        TEXT,                            -- paste | csv | url
  total      INTEGER NOT NULL DEFAULT 0,
  created    INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  invalid    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Org-chart people fetched from theorg.com per prospect; hierarchy encoded via
-- node_id/parent_node_id (theorg node ids, tree within one lead's chart).
-- Replaced wholesale on refetch.
CREATE TABLE IF NOT EXISTS gtm_org_people (
  id             TEXT PRIMARY KEY,            -- 'gp_...'
  lead_id        TEXT NOT NULL,
  company        TEXT,
  node_id        TEXT,
  parent_node_id TEXT,
  name           TEXT,
  role           TEXT,
  photo_url      TEXT,
  report_count   INTEGER,
  source         TEXT NOT NULL DEFAULT 'theorg',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gtm_org_people_lead ON gtm_org_people(lead_id);

-- One angle-set per lead (drafts). INSERT OR REPLACE on regenerate/save.
-- payload = {playbook_fit, connection_points, angles:[{rank,target,type,
-- rationale,messages[],confidence,missing}], blocked?}
CREATE TABLE IF NOT EXISTS gtm_outreach_angles (
  lead_id    TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Outreach send log — NEW vs gtm-blackbox (its daemon was read-only; the shared
-- wa-gateway can send). One row per bubble actually dispatched, so pacing +
-- history are auditable.
CREATE TABLE IF NOT EXISTS gtm_sends (
  id         TEXT PRIMARY KEY,                -- 'gs_...'
  lead_id    TEXT NOT NULL,
  chat_id    TEXT,
  bubble     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'sent',    -- sent | failed
  error      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gtm_sends_lead ON gtm_sends(lead_id);

-- ── Knowledge: the module doc + the editable control surfaces ─────────────
-- The stages read these BY SLUG; bodies are the gtm-blackbox defaults and are
-- meant to be edited in Knowledge (or by Nyo via write_knowledge).

INSERT OR IGNORE INTO knowledge_docs (slug, title, body, scope, module, parent_slug, updated_at) VALUES
('module-gtm', 'Module · GTM — leads, enrichment, outreach', 'GTM Builder folded into the command center. One module, four tabs:

- **Intake** — paste/CSV/URL phone lists → E.164 normalize → dedupe → offline geo-locate → lead rows. Enrichment chain per lead (accuracy order): WhatsApp (shared wa-gateway contact lookup) → company-from-LinkedIn (SerpApi) → PDL (paid, gated: skipped when name+company already present) → Twilio (line type; CNAM name only if still nameless) → Google search (HARD-GATED: requires an already-sourced name, never search an invented one). Per-field provenance in `sources`; disagreements recorded in `conflicts`, never overwritten; removed links tombstoned in `dismissed`.
- **Enrich** — GREEN leads only (first+last name + company + linkedin + position). Org chart from theorg (slug override for namesakes; CEO-mismatch ⇒ org_status=warn which BLOCKS outreach), ICP fit vs the [[gtm-icp]] doc (strong/medium/weak + tag chips), open roles via linkedin-gateway (company id cached on the lead; jobs via LinkedIn public guest API from the gateway''s residential IP).
- **Outreach** — per green lead, one Opus call assembles [[gtm-you]] + [[gtm-outreach-playbook]] + [[gtm-outreach-rules]] + [[gtm-outreach-examples]] + the verified org into ranked angles with draft bubbles (strict JSON; invented-person guard; dash scrub). Edit bubbles inline; send per-bubble via wa.me links OR paced gateway send (4–9s jittered gaps, stop on failure, logged to gtm_sends + outbox).
- **You** — operator profile JSON in [[gtm-you]]: name/role/business/location/about + WhatsApp groups + warm connections. Consumed by Enrich (contact matching → "your contact is here") and Outreach (positioning + mutuals).

Nyo tools: gtm_import_leads, gtm_list_leads, gtm_read_lead, gtm_update_lead, gtm_enrich_lead, gtm_check_whatsapp, gtm_org_chart, gtm_score_icp, gtm_open_roles, gtm_outreach_angles, gtm_save_angles, gtm_send_outreach (CONFIRM with the operator before sending), gtm_lead_to_pipeline. Gateways: the SHARED wa-gateway + linkedin-gateway (same throttles as everything else); PDL/SerpApi/Twilio are optional secrets (PDL_API_KEY, SERPAPI_KEY, TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN) — tools degrade gracefully when unset. theorg is a public GraphQL API.', 'global', NULL, 'knowledge-root', strftime('%s','now')*1000),

('gtm-icp', 'GTM · ICP — ideal customer profile', 'ICP (editable — score_icp_fit judges prospects against THIS doc)
For: describe your target company (stage, size, industry, geography).
Reachable: who you can realistically get to (e.g. a founder or a senior exec).
Fit signals: what makes a company a strong fit for what you offer.
Disqualifiers: what rules a company out.', 'global', NULL, 'module-gtm', strftime('%s','now')*1000),

('gtm-outreach-playbook', 'GTM · Outreach playbook', 'OUTREACH PLAYBOOK (strategy, editable)
Mission: a first WhatsApp touch that earns a short talk WITH the prospect. Never a sale.
You reach the prospect directly. Never ask them to introduce you to their own team.
Pick the warmest angle that is REAL, never invent one:
1. Warm mutual: a real shared person who vouches for you to the prospect.
2. Timely trigger: a real recent event (a raise, a key hire, a launch, a new office).
3. Right-door referral: you tried the real owner of the relevant function, name them and their role, then ask to talk to the prospect.
Spine: proof of work before the ask. Naming the specific person you tried and their role IS the proof.
No real mutual or trigger: it is a cold touch. Lead with who you are and one line of what you do. Stay honest, no fake warmth.', 'global', NULL, 'module-gtm', strftime('%s','now')*1000),

('gtm-outreach-rules', 'GTM · Outreach rules', 'OUTREACH RULES (hard, editable)
Goal: the ask is always a short talk WITH the prospect, never "connect me to X".
Language: match the prospect''s language and register (the shipped example targets Israeli founders in Hebrew, dugri; edit for your market). Proper nouns like your company name stay in their original script.
Positioning: include ONE plain line of what you do (see GTM · Outreach examples). A reason, not a pitch. State the outcome you deliver, not a service list. Never list services or channels.
No selling: banned phrases include "would you be open to", "let''s connect", "synergies", "opportunities", "potential", "I noticed", "Hi I''m X", and anything that asks to buy or book.
Punctuation, real texting not formal writing: no emoji, no hyphens, no dashes. Never end a bubble with a period (a period only splits two sentences inside one bubble, rarely). One question mark, on the ask. Minimal commas.
Length: 2 to 4 short bubbles, under about 45 words total. Bubble 1 = who you are and how you found them. Then the proof of work and the one positioning line. Last bubble = the ask.', 'global', NULL, 'module-gtm', strftime('%s','now')*1000),

('gtm-outreach-examples', 'GTM · Outreach examples', 'OUTREACH EXAMPLES (editable, replace with your own voice and language. Show the FEEL only, do not copy verbatim, adapt to the prospect.)
Opener, cold: hi [name], I''m [your name] from [your company]
Opener, via a mutual: hi [name], [mutual] pointed me your way
Opener, via the right door: hi [name], I tried reaching whoever leads [function] and actually wanted to talk to you
Positioning line: one plain sentence on what you do and the outcome you own
The ask: worth 15 minutes?', 'global', NULL, 'module-gtm', strftime('%s','now')*1000),

('gtm-you', 'GTM · You — operator profile', '{"name":"Lev Kerzhner","role":"Founder","business":"","phone":"","email":"","linkedin":"","location":"Israel","about":"","groups":[],"connections":[]}', 'global', NULL, 'module-gtm', strftime('%s','now')*1000);

-- Register in the modules registry (feeds the Modules page).
INSERT OR REPLACE INTO modules (slug, name, status, description, surface, created_at, updated_at)
VALUES ('gtm', 'GTM', 'shipped',
        'gtm-builder folded in: lead intake + enrichment (WA/PDL/Twilio/SerpApi), theorg org charts + ICP + open roles, drafted + paced WhatsApp outreach. Shared gateways.',
        'gtm',
        COALESCE((SELECT created_at FROM modules WHERE slug='gtm'), strftime('%s','now')*1000),
        strftime('%s','now')*1000);
