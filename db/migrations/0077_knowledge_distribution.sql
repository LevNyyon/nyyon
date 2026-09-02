-- The knowledge tree must describe THIS product, not the cmd it grew from.
-- A fresh install's root doc toured funnel/website/outbox modules that do not
-- exist here, "AEO + SEO article structure" sat at top level with no writer
-- installed, and digest carried gtm-coupled docs. Editorial-ware moves into
-- the editorial pack's namespace, gtm-ware into gtm's, dead docs die, and the
-- host docs get bodies that tell the truth. Guarded + re-runnable.

-- editorial's docs, re-homed (kept for installs that HAVE editorial)
UPDATE knowledge_docs SET slug='plugin-editorial-article-playbook', parent_slug='knowledge-root' WHERE slug='article-playbook' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-article-playbook');
DELETE FROM knowledge_docs WHERE slug='article-playbook';
UPDATE knowledge_docs SET slug='plugin-editorial-brand', parent_slug='knowledge-root' WHERE slug='brand' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-brand');
DELETE FROM knowledge_docs WHERE slug='brand';
UPDATE knowledge_docs SET slug='plugin-editorial-brand-voice', parent_slug='plugin-editorial-brand' WHERE slug='brand-voice' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-editorial-brand-voice');
DELETE FROM knowledge_docs WHERE slug='brand-voice';

-- gtm's docs that lived in digest
UPDATE knowledge_docs SET slug='plugin-gtm-lead-heat' WHERE slug='plugin-digest-lead-heat' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-gtm-lead-heat');
DELETE FROM knowledge_docs WHERE slug='plugin-digest-lead-heat';
UPDATE knowledge_docs SET slug='plugin-gtm-wa-pitches' WHERE slug='plugin-digest-wa-pitches' AND NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE slug='plugin-gtm-wa-pitches');
DELETE FROM knowledge_docs WHERE slug='plugin-digest-wa-pitches';

-- a page that does not exist
DELETE FROM knowledge_docs WHERE slug='system-observability';

-- host docs, rewritten to the truth
UPDATE knowledge_docs SET title='Start here', body='# Start here

Your own AI command center. **Nyo**, the assistant at the center, plus modules that arrive as **plugins** — installable, removable, tradeable between systems.

## What lives here
- **Plugins**: the modules in the sidebar. Each ships its tools, its page, and its own knowledge docs (the plugin-* entries in this tree). Manage them on the Plugins page.
- **Nyo**: chats, plans, and drives every installed tool. The docs in this tree are its memory — edit a doc and behavior changes, no code involved.
- **System pages**: Knowledge (this tree), Plugins, Activity (everything that happened), Expand build, Settings.

## Where to start
- New here? Open the **Daily Planner** and say "plan my day".
- Connecting services (model key, WhatsApp, anything external): **Settings → Connections**.
- Something looks off: **Activity** shows every mutation; the dot bottom-left is system health.' WHERE slug='knowledge-root';

UPDATE knowledge_docs SET title='About this install', body='# About this install

An AI command center you own. It runs as one self-contained install: the app, its database, and its scheduled work all live together, and nothing leaves unless you connect it.

- **Nyo** is the center: one assistant across every module, with tiered models (fast / standard / deep).
- **Modules are plugins.** Each is a sealed capability: its own tools, page, tables and knowledge. Install, remove, export, import — the system stays coherent.
- **Tools are the verbs; modules are the sentences.** Nyo knows every verb of every installed module.
- **Knowledge is the control surface.** Rules, voices and thresholds live as editable docs here, not as code.' WHERE slug='about';

-- Nyo must know where the interview lives: asked 'interview me' in plain
-- chat, it truthfully found no such tool and improvised. The knowledge doc
-- is the right home for the answer (editable, no deploy).
UPDATE knowledge_docs SET body = body || char(10) || char(10) || '## The setup interview' || char(10) || 'The interview is a DEDICATED flow, not a plain-chat improvisation: it opens from the "finish with Nyo" banner (or the setup screen) and writes the canonical voice documents. If the operator asks you to interview them in this chat, do not improvise one — tell them to press the banner, which opens the real thing.' WHERE slug='module-nyo' AND body NOT LIKE '%The setup interview%';
