#!/usr/bin/env node
// Emit the SQL that makes a fresh install a LIVING database.
//
// Two independent halves, both idempotent, both emitted by default:
//
//   1. KNOWLEDGE — the notes the code reads on every run. Some are HARD
//      requirements (the article writer THROWS without `brand-voice` and
//      `article-playbook`); the rest carry thresholds, prompts and rules that
//      would otherwise be invisible until some cron happened to self-seed them.
//      Bodies here are PRODUCT-NEUTRAL placeholders: no company voice, no real
//      people, no real clients. Each one says what the operator should put there.
//      Docs are INSERTed only when absent, so an operator's edit always survives
//      a re-run (pass --overwrite-docs to force the placeholders back).
//      Every doc is also STAMPED into `seeded_docs` with a SHA-256 of the body
//      it shipped, which is how the rest of the system can tell an operator's
//      own voice document from the placeholder it replaced. See stampSql().
//
//   2. DEMO ROWS — a handful of rows per kept module so the app opens with
//      something in it instead of six empty states. EVERY demo row is keyed
//      `demo-*` (and carries a 'demo' actor/source where the table has one), so
//      the whole set is removable with one predicate. The seed DELETEs that set
//      before re-inserting it, which is both what makes re-running safe and
//      exactly what `--clear-demo` emits on its own.
//
// Usage:
//   node scripts/seed-app.mjs                 > seed.sql   # docs + demo rows
//   node scripts/seed-app.mjs --docs-only     > seed.sql   # knowledge only
//   node scripts/seed-app.mjs --demo-only     > seed.sql   # demo rows only
//   node scripts/seed-app.mjs --overwrite-docs> seed.sql   # force doc bodies
//   node scripts/seed-app.mjs --clear-demo    > clear.sql  # remove demo rows
//
// Apply (from workers/api, where wrangler.jsonc lives):
//   node ../../scripts/seed-app.mjs > /tmp/seed-app.sql
//   npx wrangler d1 execute nyyon --local --file /tmp/seed-app.sql
//
// Companion to scripts/seed-workflows.mjs (the workflow catalog). Run both on a
// fresh install; neither depends on a running worker.

import { createHash } from 'node:crypto';

const args = new Set(process.argv.slice(2));
const CLEAR_ONLY     = args.has('--clear-demo');
const DOCS_ONLY      = args.has('--docs-only');
const DEMO_ONLY      = args.has('--demo-only');
const OVERWRITE_DOCS = args.has('--overwrite-docs');

const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const j = (v) => q(JSON.stringify(v));

const NOW = Date.now();
const HOUR = 3600_000;
const DAY = 86400_000;
// Local calendar day, so the seeded day plan is the one the planner opens.
const TODAY = new Date(NOW - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// ───────────────────────────────────────────────────────────────────────────
// 1. KNOWLEDGE
//
// Order matters: `parent_slug` is a real FOREIGN KEY into knowledge_docs, so a
// parent must be INSERTed before any child references it. The tree nodes come
// first, then the leaves, in the order below.
// ───────────────────────────────────────────────────────────────────────────

// `nyyon-root` is the slug the Knowledge page treats as the tree root
// (web/src/pages/Knowledge.tsx ROOT_SLUG). Anything unparented renders under
// "Unparented" instead, so every doc below hangs off this or a module node.
const ROOT = 'knowledge-root';

const TREE = [
  { slug: ROOT, title: 'Command Center — knowledge root', parent: null, scope: 'global', module: null, body:
`# Knowledge root

Everything the system reads at run time lives under this node. These are not
docs *about* the product, they are the product's editable behaviour: prompts,
rubrics, thresholds and constants that the code loads on every run.

**How to use it.** Change what the system does by editing a note here, not by
changing code. A note takes effect on the next run, with no deploy.

**Two kinds of note.**
- *Prose* notes are read straight into a model prompt (voice, playbooks, rubrics).
- Notes with a fenced \`json\` block carry machine-read numbers. Keep the block
  parseable and keep its keys, or the code silently falls back to its defaults.

Every note shipped with the product is a PLACEHOLDER written to be replaced.
Work through them once during setup and the whole system starts sounding like
your company instead of like a generic install.` },

  { slug: 'module-nyo', title: 'Assistant', parent: ROOT, scope: 'module', module: 'nyo', body:
`# Assistant

The in-app chat assistant and the surfaces it drives. Its model tiers live in
\`llm-models\`; the Daily Planner's own system prompt lives in
\`plugin-daily-planner-persona\`.` },

  { slug: 'module-blog', title: 'Blog', parent: ROOT, scope: 'module', module: 'blog', body:
`# Blog

Long-form articles: drafting, figures, featured images, publishing. The writer
reads \`brand-voice\` and \`article-playbook\`; figure selection reads
\`figure-chart-selection\`.` },

  { slug: 'module-aeo', title: 'Article engine', parent: 'module-blog', scope: 'module', module: 'aeo', body:
`# Article engine

The headless writer behind the Blog: question queue, interview, drafting,
review, scheduled publish. It has no page of its own; everything it produces
appears in the Blog module.` },

  { slug: 'module-outreach', title: 'Outreach', parent: ROOT, scope: 'module', module: 'outreach', body:
`# Outreach

Conversations with prospects, and the cohort queue that paces them. Copy rules
live in \`outreach-first-touch\` and \`outreach-reply-drafting\`; pacing and the
sending window live in \`outreach-cohort-cadence\`.` },

  { slug: 'module-gtm', title: 'Prospecting', parent: ROOT, scope: 'module', module: 'gtm', body:
`# Prospecting

Import, enrichment, qualification and per-prospect outreach angles. Who you are
(the sender) lives in \`gtm-you\`; how a first touch is argued lives in
\`gtm-outreach\`; enrichment budgets live in \`gtm-api-limits\`.` },

  { slug: 'module-digest', title: 'Awareness engine', parent: ROOT, scope: 'module', module: 'digest', body:
`# Awareness engine

The headless daily sweep that scores what happened and feeds the Hot Takes feed
and the outreach KPI. No page of its own.` },

  { slug: 'module-osint', title: 'Signal collection', parent: 'module-digest', scope: 'module', module: 'osint', body:
`# Signal collection

Sources, scraping and scoring. Produces the raw signals and synthesized topics
the Hot Takes feed ranks. Quality gates live in \`heartbeat-priorities\`.` },

  { slug: 'module-hot-takes', title: 'Hot Takes', parent: ROOT, scope: 'module', module: 'hot-takes', body:
`# Hot Takes

Turn a topic into a defensible position, then into an article and its social
legs. Behaviour is spread across the \`hottakes-*\` notes below.` },
];

const DOCS = [
  // ── voice + writing ──────────────────────────────────────────────────────
  { slug: 'brand-voice', title: 'Brand voice', parent: ROOT, scope: 'global', module: null, body:
`# Brand voice

**REQUIRED.** The article writer refuses to run without this note. Replace every
line below with how your company actually writes.

## Who is speaking
One or two sentences: what the company does, for whom, and the stance it takes.
Write the sentence you would want quoted back to you.

## What we sound like
- Three to five adjectives, each with a short "so we…" clause.
- Example shape: "Direct, so we lead with the claim instead of the wind-up."

## What we never do
List the tells you want stamped out: filler openers, hype adjectives, hedging,
exclamation marks, emoji, punctuation you dislike. Be specific; the writer obeys
a concrete ban and ignores a vague preference.

## Vocabulary
- Words we use (and what they mean here).
- Words we refuse, and what to say instead.

## Two short samples
Paste two paragraphs of real writing you would sign. Samples teach voice far
better than adjectives do.` },

  { slug: 'writing-style-rules', title: 'Writing style rules', parent: ROOT, scope: 'global', module: null, body:
`# Writing style rules

Mechanical rules applied on top of the brand voice: sentence length, list use,
heading style, capitalisation, how numbers and dates are written, which
punctuation is banned.

Keep this note short and absolute. It exists for the rules that are always true,
whatever the piece is about.` },

  { slug: 'visual-style', title: 'Visual style', parent: 'module-blog', scope: 'global', module: 'blog', body:
`# Visual style

How generated images for articles should look. Replace with your own direction.

- **Subject matter** — what a featured image is allowed to depict.
- **Treatment** — photographic, illustrated, abstract, diagrammatic.
- **Palette** — the two or three colours that read as yours.
- **Never** — stock-photo clichés, logos, recognisable faces, text baked into
  the image.

Written as instructions to an image model: concrete nouns beat mood words.` },

  { slug: 'editorial-taste', title: 'Editorial taste', parent: 'module-aeo', scope: 'global', module: 'aeo', body:
`# Editorial taste

What you cut when you edit. This note is APPENDED TO OVER TIME — every time you
reject a draft for a reason worth remembering, add the reason here as one line.

Start with a few:
- Cut any sentence that would survive unchanged in a competitor's article.
- Cut the summary paragraph that restates what was just argued.
- A claim without a number, an example or a source is an opinion; label it as one.` },

  // ── models + assistant ───────────────────────────────────────────────────
  { slug: 'llm-models', title: 'LLM models — which model runs each surface', parent: 'module-nyo', scope: 'global', module: null, body:
`Which model each surface runs on. The code reads the JSON block below at run
time (\`loadModelConfig\` in lib/model-config.js) — edit here or in Settings, no
deploy. Invalid or missing fields fall back to the environment variables in
wrangler.jsonc, then to the coded defaults.

- \`nyo_low\` / \`nyo_mid\` / \`nyo_high\` — the assistant's Low/Mid/High tier switch.
  Low is meant for a cheap or local model.
- \`writer\` — the heavy background writers: article drafting, topic synthesis,
  outreach angles. Use your strongest model here.
- \`writer_small\` — the cheap utility model that "mini/haiku" call sites map to.
- \`vision\` — image judging.
- \`writer_fallback\` — an optional third-party model the writers fall back to
  when the primary provider is out of credit. Leave empty to pause instead.

Model ids must be exactly what your provider expects; a wrong id fails at call
time, not here.

\`\`\`json
{
  "nyo_low": "",
  "nyo_mid": "",
  "nyo_high": "",
  "writer": "",
  "writer_small": "",
  "vision": "",
  "writer_fallback": ""
}
\`\`\`
` },

  { slug: 'plugin-daily-planner-persona', title: 'Daily Planner — planner persona (system prompt)', parent: 'module-nyo', scope: 'global', module: null, body:
`You are the Daily Planner inside this command center — a fast planning partner that turns a short conversation into a SAVED day plan in the panel beside this chat. You share the assistant's tools. Be terse, ask ONE thing at a time, and draft as soon as you have enough.

Each new day the chat and the panel start empty. Ground yourself quietly first: call read_daily_plan (today) and read_weekly_objectives (this week) before your first reply. If today already has a plan, recap it in one line and ask what to change instead of re-asking.

Otherwise ask these FOUR things, in order, one at a time, and STOP asking the moment you can draft:
1. What do you want done today?
2. Any constraints to account for? (meetings, deadlines, energy, hours available)
3. How many Focus Sessions fit today? Each is a ~2-hour deep-work block.
4. Are we aligned with this week's objectives? (You already read them; if none are set, offer to set 2-4 with set_weekly_objectives.)

Then call save_daily_plan, which fills the panel:
- Create exactly the number of FOCUS SESSION blocks the operator gave, ~2 hours each, focus:true, each with ONE concrete deliverable (what will exist when it is done). These are the backbone of the day.
- Place them around the stated constraints; add anything else needed as regular blocks (focus:false).
- List today's to-dos as todos:[{text, star}] — star:true for the few that matter most.
- mode 'strategic' with weekly_ref (the week's Sunday) when the day serves the week's objectives, else 'wing_it'.

Say it is a first cut, then refine with update_daily_plan (only the changed keys); the panel updates live. Never claim you saved or changed the plan unless the tool returned success.

The plan is self-contained. It is NOT synced to a calendar or a task list and you have no tools for those, so plan the day inside the schedule and to-dos only. Ask about fixed commitments; do not try to read or write a calendar.

STYLE: terse, direct, plain. No marketing voice, no filler. This is the planning desk; leave general work to the main assistant.

--- OPERATOR: edit this note to change how the planner behaves. It is the planner's entire system prompt. ---` },

  // ── article engine ───────────────────────────────────────────────────────
  { slug: 'article-playbook', title: 'Article playbook', parent: 'module-aeo', scope: 'global', module: 'aeo', body:
`# Article playbook

**REQUIRED.** The article writer refuses to run without this note. It is the
brief every article is written against. Replace the placeholders below.

## Who we write for
The reader: their role, what they already know, what they are trying to decide.
Write one person, not a segment.

## What an article is for
State the job. For example: answer one real question well enough that the reader
stops looking, and make it obvious who wrote it.

## Structure
1. Open with the claim, not the context.
2. Argue it: three to five points, each with evidence.
3. Address the strongest objection honestly.
4. Close with what the reader should do differently.

## Length and format
Target word count, heading depth, whether to use lists, whether to include a
short FAQ block at the end.

## Evidence rules
- Never invent numbers, quotes, dates or sources.
- Distinguish what is sourced, what is our own experience, and what is opinion.
- If a supporting fact cannot be verified, cut the sentence.

## Titles
How a title should read: plain and specific, or provocative. Give two examples
you would actually publish, and one you would reject.

## Never
The list of things that would make you unpublish a draft on sight.` },

  // ── outreach ─────────────────────────────────────────────────────────────
  { slug: 'outreach-first-touch', title: 'Outreach · default first touch', parent: 'module-outreach', scope: 'global', module: 'outreach', body:
`Outreach · the default first-touch message.

Offered in the composer for a prospect with NO conversation and NO saved
outreach angle (a saved angle always wins). \`{first_name}\` is replaced with the
prospect's stored first name; everything else is sent exactly as written below
the separator. Never sent automatically — it lands in the composer for you to
edit.

Replace the template with your own opener. Keep it short enough to read on a
phone without scrolling, say who you are in one clause, and make one small ask.

---
Hi {first_name}, [your name] here.

[One line: who you are and what you do, in the words a stranger would use.]

[One line: why you are writing to THIS person specifically.]

Worth a short conversation?
` },

  { slug: 'outreach-reply-drafting', title: 'Outreach · reply drafting', parent: 'module-outreach', scope: 'global', module: 'outreach', body:
`Outreach · how the suggested draft under the composer is written, and how much
of the conversation the tab loads.

The draft is a SUGGESTION. It is never sent automatically: it lands in the
composer for you to edit or delete. Before you have messaged a prospect at all,
the tab shows the top saved outreach angle verbatim instead of writing anything
new, so a cold first touch is always the message you already approved.

Edit the rules below the separator to change how replies are written. Edit the
json block to change how much the tab loads. Both apply with no deploy.

\`\`\`json
{
  "thread_limit": 60,
  "message_limit": 300,
  "draft_context_messages": 12,
  "draft_context_chars": 500
}
\`\`\`

---
How to write a reply to a prospect:

- One message, not a sequence. Two or three sentences, the length a busy person
  actually reads on a phone.
- Answer what they actually said FIRST. Never restate the pitch at someone who
  has already replied to it.
- Keep the angle's positioning, drop the angle's phrasing. The saved angle is
  what we believe about them; it is not a script to paste at them.
- Plain human words. No filler openers, no "circling back", no exclamation
  marks, no emoji unless they used one first.
- Match their language. If they wrote in another language, reply in it.
- Never invent a fact: no names, numbers, dates, mutual contacts, or claims
  about their company that are not in the context you were given.
- If they declined, do not push. Acknowledge it, leave the door open in one
  short line, and stop.
- End with at most one question, and only when a question moves it forward.
` },

  { slug: 'outreach-cohort-cadence', title: 'Outreach · queue cadence', parent: 'module-outreach', scope: 'global', module: 'outreach', body:
`Outreach · queue cadence — the pacing rules the sending engine reads live.

- \`step_delays_hours\` — how long to wait before each FOLLOW-UP. Step 0 is the
  first touch and goes as soon as it is due. Fewer entries than steps means the
  last value repeats.
- \`max_sends_per_day\` / \`min_gap_minutes\` — the volume ceiling and the minimum
  spacing between two sends, so a queue never bursts.
- \`quiet_start_hour\` / \`quiet_end_hour\` / \`weekdays_only\` / \`timezone\` — the
  window in which sending is allowed, in the operator's local clock.
- \`dead_after_days\` — when a silent conversation stops being followed up.
- \`require_approval\` — when true (the default and the safe direction) every
  individual message waits for a human press before it goes.
- \`max_message_chars\` — ceiling on a hand-written message.

\`\`\`json
{
  "step_delays_hours": [72, 96, 168],
  "max_sends_per_day": 8,
  "min_gap_minutes": 20,
  "quiet_start_hour": 9,
  "quiet_end_hour": 19,
  "weekdays_only": true,
  "timezone": "UTC",
  "dead_after_days": 21,
  "require_approval": true,
  "max_message_chars": 4000
}
\`\`\`

---
**Why these numbers start low.** A brand-new install is a brand-new WhatsApp
number, and unwarmed numbers are the ones that get banned. The reference
install lost an account to 19 cold messages, 16 of them inside 100 seconds —
so the spacing rule matters more than the daily ceiling, and both ship
deliberately conservative. 8 a day with 20 minutes between them is a floor to
raise once an account has history, not a target to hit on day one.

Raise them slowly, and only after the number has been sending and RECEIVING
normal conversation for a while. Nothing here protects an account that is
blasting strangers; it only keeps an honest queue from looking like a bot.

Notes for whoever runs the queue: write down here why the numbers above are what
they are, so the next person does not "optimise" them back.
` },

  { slug: 'outreach-signature', title: 'Outreach · signature (KPI classifier rubric)', parent: 'module-digest', scope: 'global', module: null, body:
`Outreach signature — the rubric that decides whether an outbound message counts
as a genuine outreach for the daily KPI.

The classifier reads each outbound message and returns is_outreach true/false
using this rubric. Edit it to tune what counts: add phrases your outreach always
uses, or examples of messages that should NOT count. Changes apply to newly
classified messages, no deploy.

---
What a GENUINE outreach message looks like (counts toward the KPI):
- A first-touch message opening a conversation with a new prospect.
- Says who we are, or leads with a specific hook about them, then makes one
  small ask (connect, a short call, sharing something relevant).
- Reads like a deliberate business approach, even when casual.

What is NOT outreach (does not count):
- Follow-up nudges on an existing thread ("did you see my message?").
- Replies continuing a conversation already under way.
- Personal or social messages to people we already know.
- Operational chatter: invoices, files, scheduling, internal coordination.

Rule of thumb: if this is the kind of message we would send a brand-new prospect
to START a business relationship, it is outreach. If it only makes sense inside
an existing relationship, it is not.
` },

  { slug: 'outreach-sentiment', title: 'Outreach · sentiment rubric', parent: 'module-digest', scope: 'global', module: null, body:
`Outreach sentiment — the rubric used to score how a prospect feels in their
reply. Scored on the latest inbound message per conversation and cached until a
newer one arrives.

Edit this note to tune what counts as negative rather than neutral: add the
phrasings your market uses for a polite decline.

---
How to score a reply to cold outreach:
- **positive** — warm, interested, asks a question back, wants to talk.
- **neutral** — genuinely undecided: a polite acknowledgement with no lean, a
  logistics question, a real "later" with no rejection attached.
- **negative** — ANY decline, however politely phrased. "Not interested", "not
  for me", "please stop", "remove me", or a reply plainly trying to end the
  conversation.

The most common mistake is scoring a POLITE rejection as neutral because the
wording is soft. Politeness is a tone, not a signal of openness. Judge the
decision being communicated, not how nicely it is phrased.
` },

  // ── prospecting ──────────────────────────────────────────────────────────
  { slug: 'brand-icp', title: 'Brand · ICP — ideal customer profile', parent: ROOT, scope: 'global', module: null, body:
`Ideal customer profile. Prospecting ICP scoring and the outreach angle
generator judge prospects against THIS doc — fill it in your own words.

For: describe your target company (stage, size, industry, geography).
Reachable: who you can realistically get to (e.g. a founder or a senior exec).
Fit signals: what makes a company a strong fit for what you offer.
Disqualifiers: what rules a company out.` },

  { slug: 'brand-positioning', title: 'Brand · Positioning', parent: ROOT, scope: 'global', module: null, body:
`How you position what you sell. The outreach angle generator reads THIS doc
for positioning language — one-liner, who it is for, why now, and the proof.
Replace this placeholder with your own positioning.` },

  { slug: 'gtm-you', title: 'Prospecting · who you are', parent: 'module-gtm', scope: 'global', module: 'gtm', body:
`# Who you are (the sender)

Read verbatim into every outreach-angle prompt, so the messages sound like a
person and not like a product. Fill in your own details.

- **Name** —
- **Role** —
- **What you do**, in the one sentence a stranger would understand —
- **Where you are** (city, country) —
- **Groups, communities or networks** you genuinely belong to —
- **Proof you can point at** — two or three concrete things you have shipped.

Only put things here that are true. Everything in this note can end up in a
message to a real person.` },

  { slug: 'gtm-outreach', title: 'Prospecting · outreach guide', parent: 'module-gtm', scope: 'global', module: 'gtm', body:
`# Outreach guide

The single control surface for how a first touch is argued. The angle generator
reads this whole note live.

## Strategy
What we are actually asking for on a first touch, and what we are not. Name the
one next step a good reply leads to.

## Language
Which language each kind of prospect gets, and any rule that overrides the
default (for example: always the prospect's own language when it is known).

## Rules
- Message length and the maximum number of bubbles in one touch.
- What may be claimed about the prospect's company, and what may not.
- Never name a person who is not in the verified org chart.
- Banned phrases and punctuation.

## Exemplars
Paste two outreach messages you would send yourself, and one you would delete.
The generator imitates shape and register from these more than from adjectives.

## Self-check
The questions the draft must pass before it is shown: Is every fact sourced?
Would this read as automated? Is there exactly one ask?` },

  { slug: 'gtm-schedule', title: 'Prospecting · scheduled sends', parent: 'module-gtm', scope: 'global', module: 'gtm', body:
`Scheduled sends — the rules the scheduler reads live.

A scheduled send fires on a cron tick, so the actual send lands at the FIRST
tick at or after the scheduled time: it can be up to ~40 minutes late, never
early. Duplicates are structurally blocked (one live schedule per prospect and
content, atomic claim, fail-closed, no automatic retry). A claimed or failed row
is an operator decision, not a retry queue.

- \`max_horizon_days\` — how far ahead a send may be scheduled.
- \`default_send_hour\` + \`default_days_ahead\` — what the schedule picker offers
  first (12 + 0 = the next noon, rolling to tomorrow once noon has passed).
- \`default_jitter_minutes\` — random minutes added so send times are never flat.
- \`timezone\` — the wall clock the presets and every displayed time use (IANA
  name), wherever the operator's browser happens to be.

\`\`\`json
{
  "max_horizon_days": 30,
  "default_send_hour": 12,
  "default_days_ahead": 0,
  "default_jitter_minutes": 9,
  "timezone": "UTC"
}
\`\`\`
` },

  { slug: 'gtm-api-limits', title: 'Prospecting · enrichment API limits', parent: 'module-gtm', scope: 'global', module: 'gtm', body:
`Enrichment API limits — the plan caps behind the usage meters.

Put each provider's real plan numbers here. The module shows used vs limit and
days to renewal, and warns once per period when usage crosses \`warn_at_pct\`.
\`renewal_day\` is the day of the month the plan resets (check the provider's
billing page). Pay-per-use providers have no monthly cap, so their meter shows
the account balance and warns below \`balance_warn_usd\`.

Where a provider reports its own numbers, those override the counted estimate
automatically. This note mainly supplies the cap, the renewal day and the
warning line.

\`\`\`json
{
  "pdl": { "monthly_limit": 100, "renewal_day": 1, "warn_at_pct": 80 },
  "serpapi": { "monthly_limit": 250, "renewal_day": 1, "warn_at_pct": 80 },
  "twilio": { "balance_warn_usd": 5 }
}
\`\`\`
` },

  // ── hot takes ────────────────────────────────────────────────────────────
  { slug: 'hottakes-playbook', title: 'Hot Takes — playbook', parent: 'module-hot-takes', scope: 'module', module: 'hot-takes', body:
`# Hot Takes playbook

How the take-drafter and the brief-builder behave. Edit to change their
behaviour, no deploy.

## Draft a take
Propose a SPECIFIC, defensible company opinion on the topic, not a neutral
summary. Ground it in the Point-of-View Library. Answer four things: what the
company believes; what is commonly misunderstood; who should care; what the
reader should do differently. One clear argument, no hedging.

## Editorial brief
Before a long article is written: the proposed argument, the intended audience,
why the topic matters now, three to five supporting points, the evidence
available, the likely objections, and the recommended conclusion. Pick the
publication pattern that fits (see \`hottakes-article-patterns\`). The brief exists
so nobody polishes an article built around the wrong argument.

## Social posts
The company post is the organisation's position: composed, confident, no first
person singular. The personal post is direct and experiential, first person, one
concrete observation, and NOT a copy of the company post. Both end with a reason
to read the full article. Roughly 900 to 1,300 characters each, at most three
hashtags.

## Article
Write an in-depth opinion piece (1,500+ words): open with the claim, argue it
with the points above, use the evidence concretely, address the objections, and
close with the recommended action. This is a POINT OF VIEW, not a news summary.
` },

  { slug: 'hottakes-pov-library', title: 'Hot Takes — Point-of-View Library', parent: 'module-hot-takes', scope: 'module', module: 'hot-takes', body:
`# Point-of-View Library

The reusable positions every take is grounded in. This is the most valuable note
in the module: without it, takes drift into generic commentary. Replace the
placeholders with what your company actually believes.

## Positions
Three to six sentences of the form "X beats Y, because Z." Each should be
something a competent competitor could disagree with. If nobody could disagree,
it is not a position.

## Beliefs
The convictions behind the positions: what earns attention, what wastes it, what
you refuse to do even when it works for others.

## Terminology
Words you use deliberately, with the definition you mean by them. This is what
stops a draft from redefining your own vocabulary.

## Approved statements
Sentences about the company that may be used verbatim. Anything not listed here
must be argued from the positions above, not asserted.
` },

  { slug: 'hottakes-article-patterns', title: 'Hot Takes — publication patterns', parent: 'module-hot-takes', scope: 'module', module: 'hot-takes', body:
`# Reusable publication patterns

Structures the brief-builder may propose. Guidance, not a straitjacket: never
force every article into the same shape.

1. **Event → implication → our view → recommended action.** For industry news.
2. **Common belief → why it is wrong → evidence → better approach.** For
   contrarian takes.
3. **New development → who it affects → what changes → what to do next.** For
   product and model launches.
4. **What we tried → what happened → what we would do differently.** For
   first-hand experience, the pattern nobody can copy from you.

Add your own patterns as you find shapes that work.
` },

  { slug: 'hottakes-quality-rules', title: 'Hot Takes — quality rules', parent: 'module-hot-takes', scope: 'module', module: 'hot-takes', body:
`# Article quality rules

What the review scan flags. The goal is not to "hide AI" — it is an article that
is specific, original, sourced, and recognisably written from your company's
perspective.

Flag:
- Broad statements with no named subject.
- An unclear audience: who exactly should care?
- Jargon standing in for an argument.
- Sections that do not advance the central claim.
- Language that sounds unlike previously approved company writing.
- Any number, quote or date without a source.

Claim taxonomy used by the scan:
- \`directly_supported\` — a cited source backs it.
- \`company_experience\` — we know this from our own work.
- \`opinion\` — clearly framed as a stance.
- \`unsupported\` — needs confirmation or removal.
` },

  { slug: 'hottakes-timing', title: 'Hot Takes — release timing', parent: 'module-hot-takes', scope: 'module', module: 'hot-takes', body:
`# Release timing defaults

The schedule suggested when the operator picks only a date. Offsets are minutes
after the website publish. Edit the JSON block; it is parsed live.

\`\`\`json
{ "default_hour_utc": 13, "company_offset_min": 120, "personal_offset_min": 3 }
\`\`\`
` },

  { slug: 'hottakes-social-identities', title: 'Hot Takes — social identities', parent: 'module-hot-takes', scope: 'module', module: 'hot-takes', body:
`# Social identities

Who appears as the poster in each channel's preview. Edit the JSON block; it is
parsed live. \`avatar_url\` may be any image URL; when null the preview renders
initials.

\`\`\`json
{
  "linkedin-company": { "name": "Your Company", "headline": "What you do, in six words", "avatar_url": null },
  "linkedin-personal": { "name": "Your Name", "headline": "Role · Your Company", "avatar_url": null }
}
\`\`\`
` },

  // ── figures ──────────────────────────────────────────────────────────────
  { slug: 'figure-chart-selection', title: 'Figures · which chart to use when', parent: 'module-blog', scope: 'global', module: 'blog', body:
`DATA CHARTS — when an idea is backed by REAL NUMBERS, draw the numbers, not a metaphor. Pick by GOAL (the chart's main statement is the compass; once the goal is known, most chart types can simply be ignored):

CHANGE OVER TIME
- chart_line: the default for a value moving across months or years, up to 5 series. More than ~5 overlapping lines is spaghetti — use chart_multiples.
- chart_multiples: many series, one mini panel each, ONE shared scale.
- chart_area: how a total's internal breakdown shifted over time (mode "share" for a 100% view). Composition is the story, not precise values.
- chart_column: only a FEW points in time. Many periods → chart_line.
- chart_slope: only the first and last point across categories, when the wiggles between are not the story.
- chart_arrow: compact before→after for many categories.

SHARES OF A WHOLE
- chart_bar: percentages compare better as bars than as pie slices — a 3-point gap is visible in a bar and invisible in a pie. The DEFAULT for shares.
- chart_pie: only a simple, obvious split (2-4 slices, one dominant); donut mode carries a centre stat.
- chart_waffle: an illustrative of-100 share; trades precision for warmth.
- chart_treemap: proportions across MANY categories (up to ~12).
- chart_marimekko: shares AND absolute size at once (column width = size).
- chart_bar_stacked mode "share": survey / Likert rows.

AMOUNTS
- chart_bar: the workhorse — sorted, direct-labelled.
- chart_bar_grouped: 2-3 values compared within each category.
- chart_bar_stacked mode "absolute": totals split into parts.
- chart_bar_split: two components mirrored (in/out, population pyramids).
- chart_dot: several values per category in little space.
- chart_prop_area: 2-4 magnitudes as area-true shapes — impact over precision.
- bigstat (diagram): when ONE number IS the story, print it huge instead of charting it.

RELATIONSHIPS
- chart_scatter: does X relate to Y? Label only points worth naming; size makes it a bubble chart (area-true).
- chart_heatmap: a matrix of intensity (day × time, category × stage); also the fix for an unreadable dot cloud.

FLOWS
- chart_sankey: volume flowing source → destination (money, leads, energy).

CHART RULES (the renderer enforces the hard ones):
- Bars, columns, areas and waffles always start at zero; lines may zoom.
- Direct labels beat legends — the templates label line ends and bar ends themselves.
- NEVER invent numbers. Chart templates are ONLY for real figures present in the article or supplied by the operator. If the text gestures at magnitude without numbers, use a diagram (story shape) instead.
- Familiar beats fancy for a mainstream audience; one less-common shape can wake up a chart-heavy piece.
- Small screens: prefer bars (grow down) over columns (grow right).
- GEO MAPS (choropleth, symbol, locator) are NOT renderable here: use chart_bar or chart_heatmap by region instead.` },

  // ── awareness engine ─────────────────────────────────────────────────────
  { slug: 'heartbeat-priorities', title: 'Heartbeat priorities', parent: 'module-osint', scope: 'global', module: 'osint', body:
`# Heartbeat priorities

The quality gates the awareness sweep applies. Raise a number to let less
through; lower it to see more and sort by hand. The code reads the JSON block
live, so a change takes effect on the next sweep.

- \`digest_min_content\` — the content score a signal needs to reach the morning
  brief.
- \`topics_min_content\` — the floor for a signal to be considered when
  synthesizing topics.
- \`enrich_min_relevance\` — the relevance score that earns a signal a full
  article fetch and re-score. This one costs money; raise it first if the
  enrichment bill is high.

\`\`\`json
{
  "digest_min_content": 70,
  "topics_min_content": 62,
  "enrich_min_relevance": 60
}
\`\`\`
` },

  { slug: 'digest-interests', title: 'Awareness · what we care about', parent: 'module-digest', scope: 'global', module: 'digest', body:
`# What we care about

The relevance filter for incoming signals. Replace with your own subject matter.

## Always relevant
- Topics, markets, technologies and competitors we track by name.

## Sometimes relevant
- Adjacent areas, and the condition that makes them matter to us.

## Never relevant
- The recurring noise you never want to see again: funding-round roundups,
  listicles, vendor press releases, whatever else wastes your morning.

Be concrete. A named company or product filters far better than a category.` },

  { slug: 'kpi-outreach', title: 'KPI · daily outreach goal', parent: 'module-digest', scope: 'global', module: null, body:
`Daily outreach KPI — the goal and how progress is measured.

The target is \`daily_target\` NEW outreaches per WORK DAY, counted across every
channel together. An "outreach" is the FIRST time you message a person: they
count once, on the day you first reach out, and an ongoing back-and-forth never
counts again.

\`tz\` fixes when "today" rolls over and which weekday it is, so the count resets
at local midnight. \`work_days\` are the weekdays the goal applies to (0 = Sunday
… 6 = Saturday). \`work_hours\` frame the day for pace: "expected by now" ramps
from zero at the start hour to the full target at the end hour, so you can tell
mid-afternoon whether you are behind.

\`\`\`json
{
  "daily_target": 20,
  "tz": "UTC",
  "work_days": [1, 2, 3, 4, 5],
  "work_hours": [9, 18]
}
\`\`\`
` },

  // ── system policy ────────────────────────────────────────────────────────
  // NOTE: wake-up-policy's body is parsed as RAW JSON (JSON.parse(doc.body)),
  // NOT as a fenced block. Prose here would break the parse and silently fall
  // back to the coded defaults.
  { slug: 'wake-up-policy', title: 'Wake-up policy — cadence + retry thresholds', parent: ROOT, scope: 'global', module: null, body:
`{
  "cadence_hours": 18,
  "heartbeat_hours": 20,
  "outbox_window_hours": 72,
  "outbox_retry_limit": 5,
  "briefing_gap_hours": 20
}` },

  { slug: 'meeting-reminders', title: 'Meeting reminders — policy', parent: ROOT, scope: 'global', module: null, body:
`Meeting reminders — when the assistant nudges you before a calendar event.

\`lead_minutes\` is how long before the event the reminder fires; the hourly tick
means it lands at the first tick inside that window. \`quiet_start_hour\` and
\`quiet_end_hour\` are the local hours in which a reminder may be sent at all.
\`kinds\` limits which calendar entries qualify.

\`\`\`json
{
  "enabled": true,
  "lead_minutes": 30,
  "quiet_start_hour": 8,
  "quiet_end_hour": 21,
  "kinds": ["meeting"]
}
\`\`\`
` },

  // Shown by the Expand Build page, which substitutes {{REPO}} with the real
  // checkout path before handing the text to the operator. It lives here, not
  // as a literal in the React page, for the usual reason: it is a prompt, and
  // prompts are knowledge. As an operator's build diverges from the shipped
  // one, this is the note they edit so a coding agent is briefed on THEIR
  // codebase rather than the one that shipped.
  { slug: 'expand-build-prompt', title: 'Expand build — handoff prompt', parent: ROOT, scope: 'global', module: null, body:
`You are continuing development of Nyyon Command Center, a self-hosted AI command
center that is already installed and running. The complete source is at:

    {{REPO}}

That checkout IS the install. There is no separate installed copy to keep in
sync: the desktop app lives inside the repo at desktop/out/ and finds the source
by walking up from its own binary. Edit the files in place and restart the app.

Read {{REPO}}/CLAUDE.md before you write anything. It is binding, not advisory.

## Layout

    workers/api/        Cloudflare Worker (Hono) — the whole backend
      src/gateways/       one folder per external service (the ONLY place that talks out)
      src/tools/          the single shared tool pool; index.js is the registry
      src/workflows/      ordered lists of existing tools, no logic of their own
      src/lib/            shared helpers
      src/index.js        HTTP routes
    web/                React + Vite SPA; src/pages/ is roughly one file per module
    db/                 schema.sql + numbered migrations/
    scripts/            setup.mjs, dev.mjs, seed-app.mjs (knowledge + workflow seeds)
    desktop/            Electron shell (main.cjs) that spawns the worker and the SPA

## The five layers — each may reach only the layer below it

1. Gateway — the boundary to ONE external service. Does no reasoning. Only the
   \`llm\` gateway may call a model. Reach services via \`callGateway(env, slug, mode, input)\`.
2. Tool — ONE job, JSON in and JSON out, registered in the shared pool. Reaches
   the outside world only through gateways. A tool never calls another tool.
3. Workflow — an ordered list of tools that already exist. No branching.
4. Module — a product area plus the page that visualizes it. Never raw \`fetch\`.
5. Knowledge — the prompts, rubrics, thresholds and constants the code loads at
   run time. Change behaviour by editing a note, not by editing code.

Under all of it is the activity bus: every meaningful mutation calls
\`logEvent(env, { kind, actor, payload })\`.

## Running it

    cd {{REPO}}
    npm run setup     # first time only: deps, local DB, migrations, seeds
    npm start         # worker on :8799, SPA on :5180

The local database is SQLite under workers/api/.wrangler. Query it with:

    cd workers/api && npx wrangler d1 execute nyyon --local --command "select 1"

## House rules that catch people out

- A magic number, model name, list or prompt belongs in a knowledge note seeded
  from scripts/seed-app.mjs, not as a literal in code.
- A schema change is a NEW numbered file in db/migrations/ plus the same change
  in db/schema.sql. Never edit a migration that has already run.
- Adding a module surface means four edits, not one: the page in web/src/pages/,
  \`NAVS\` in web/src/App.tsx, \`SurfaceSlug\` and \`SURFACE_MODULES\` in
  web/src/lib/theme.ts, and \`SURFACE_ITEMS\` in web/src/components/Sidebar.tsx.
- .dev.vars holds real secrets and is gitignored. Never commit it, never print it.
- Writing a shared file means writing the COMPLETE file. A partial write that
  silently drops the rest of the file is the most common way this repo breaks.

## The build harness — non-negotiable for self-editing

This install edits its own code, so every change runs inside these rails:

1. **Model**: run as Claude Fable 5 (model id \`claude-fable-5\`). If your
   harness cannot select a model, ask the operator to start you with it.
2. **Checkpoint first**: this checkout must be a git repo before you edit. If
   \`git status\` fails, run \`git init && git add -A && git commit -m baseline\`.
   Commit a checkpoint before any multi-file change so a bad apply is one
   \`git restore .\` away.
3. **Read before write**: read every file you will touch, fully, in this
   session. Never write a shared file from memory — write the COMPLETE file.
4. **Validate after write**: run \`node scripts/validate.mjs\` and
   \`npm run typecheck\`, and \`node --check\` any edited worker file. Fix what
   they report before moving on.
5. **Prove it runs**: restart the app and check
   \`curl -s -o /dev/null -w '%{http_code}' localhost:8799/\` returns 200
   (\`/health\` needs a signed-in session, so it 401s from curl — that is the
   gate working, not the app failing). A change is not done until the running
   app answers.
6. **Never touch the database while the server is running** — the live worker
   holds it open and silently overwrites outside edits. Stop the app first.

## How I want you to work

Tell me which layer a change belongs in before you edit, and say so if the thing
I asked for does not fit the architecture — redesign the change rather than
breaking a guardrail. When you are done, re-read CLAUDE.md and check your own
diff against the guardrails above before you call it finished.

What I want next:` },
];

const ALL_DOCS = [...TREE, ...DOCS];

function knowledgeSql() {
  const out = [
    '-- ── knowledge ────────────────────────────────────────────────────────',
    `-- ${ALL_DOCS.length} docs. Parents first: knowledge_docs.parent_slug is a FK.`,
    OVERWRITE_DOCS
      ? '-- --overwrite-docs: existing bodies ARE replaced with the shipped placeholder.'
      : '-- Existing docs are left untouched (an operator edit always wins).',
    '',
  ];
  for (const d of ALL_DOCS) {
    out.push(
      `INSERT INTO knowledge_docs (slug, title, body, scope, module, parent_slug, updated_at)`,
      `VALUES (${q(d.slug)}, ${q(d.title)}, ${q(d.body)}, ${q(d.scope || 'global')}, ${q(d.module ?? null)}, ${q(d.parent ?? null)}, ${NOW})`,
      OVERWRITE_DOCS
        ? `ON CONFLICT(slug) DO UPDATE SET title=excluded.title, body=excluded.body, scope=excluded.scope,\n  module=excluded.module, parent_slug=excluded.parent_slug, updated_at=excluded.updated_at;`
        : `ON CONFLICT(slug) DO NOTHING;`,
      '',
    );
  }
  out.push(...stampSql());
  return out;
}

// ── the stamp: which bodies did THIS seed ship? ────────────────────────────
//
// Half the product steers on the operator's own words (brand-voice, personal
// voice, the POV library, heartbeat priorities), and every module that writes
// has to know whether those documents are theirs or still ours. The honest
// answer cannot be "does the body still contain the phrase 'REQUIRED.'" —
// that is a string match against prose in THIS file, and prose gets reworded,
// silently flipping every check downstream.
//
// So the seed records a fingerprint of exactly what it shipped, per slug, in
// `seeded_docs` (migration 0070). lib/module-prereqs.js hashes the doc as it
// stands and compares: equal means untouched, different means somebody wrote
// it (the setup interview, Nyo, or the operator in the Knowledge module), and
// absent means there is nothing of theirs there either.
//
// The fingerprint describes the SHIPPED body, never the stored row, so it is
// rewritten on every run (DO UPDATE) whatever happened to the doc:
//
//   plain re-run       docs untouched (DO NOTHING) + fingerprint of the
//                      placeholder → an edited doc still reads as the
//                      operator's, an untouched one still reads as ours.
//   --overwrite-docs   placeholder restored + its matching fingerprint → the
//                      doc correctly reads as a shipped default again.
//
// This is the one mechanism; it is implemented here and in the check, and
// nowhere else.
function fingerprint(body) {
  return createHash('sha256').update(String(body), 'utf8').digest('hex');
}

function stampSql() {
  return [
    '-- ── seed stamp ───────────────────────────────────────────────────────',
    '-- SHA-256 of every body shipped above, so "is this doc still the shipped',
    '-- placeholder?" is a fact rather than a guess. See db/migrations/0070.',
    '',
    ...ALL_DOCS.flatMap((d) => [
      `INSERT INTO seeded_docs (slug, fingerprint, seeded_at)`,
      `VALUES (${q(d.slug)}, ${q(fingerprint(d.body))}, ${NOW})`,
      `ON CONFLICT(slug) DO UPDATE SET fingerprint=excluded.fingerprint, seeded_at=excluded.seeded_at;`,
      '',
    ]),
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// 2. DEMO ROWS
//
// One predicate per table defines the demo set. The same list is what the seed
// deletes before re-inserting (which is what makes it idempotent) and what
// --clear-demo emits on its own.
// ───────────────────────────────────────────────────────────────────────────

const DEMO_PREDICATES = [
  ['gtm_outreach_angles',      `lead_id LIKE 'demo-%'`],
  ['outreach_cohort_members',  `lead_id LIKE 'demo-%'`],
  ['outreach_cohorts',         `id LIKE 'demo-%'`],
  ['gtm_leads',                `id LIKE 'demo-%'`],
  ['social_posts',             `id LIKE 'demo-%'`],
  ['hot_take_packages',        `id LIKE 'demo-%'`],
  ['osint_topics',             `id LIKE 'demo-%'`],
  ['osint_signals',            `id LIKE 'demo-%'`],
  ['osint_sources',            `id LIKE 'demo-%'`],
  ['blog_posts',               `slug LIKE 'demo-%'`],
  ['calendar_events',          `id LIKE 'demo-%'`],
  ['events',                   `id LIKE 'demo-%'`],
  // daily_plans is keyed by DATE, so it cannot carry a demo- prefix. The plan
  // JSON carries a marker instead — and because saving the plan from the UI
  // rewrites that JSON without the marker, a plan the operator has touched is
  // no longer considered demo data and survives a clear. That is deliberate.
  ['plugin_daily_planner_plans',              `plan LIKE '%"__demo_seed":true%'`],
];

function clearSql() {
  const out = [
    '-- ── remove every demo row ────────────────────────────────────────────',
    '-- Exactly the rows this script inserts. Knowledge docs are NOT touched.',
    '',
  ];
  for (const [table, pred] of DEMO_PREDICATES) out.push(`DELETE FROM ${table} WHERE ${pred};`);
  out.push('');
  return out;
}

function demoSql() {
  const out = [
    '-- ── demo rows ────────────────────────────────────────────────────────',
    '-- Every row below is keyed demo-* and carries a demo actor/source.',
    '-- Remove them all with: node scripts/seed-app.mjs --clear-demo',
    '',
    ...clearSql(),
  ];

  // ── signal collection: a source + three signals + three topics ───────────
  // Two signals stay unclaimed so the Hot Takes feed has cards; the third is
  // the one the demo package was made from (a claimed origin_ref is excluded
  // from the feed by design).
  out.push('-- osint_sources');
  out.push(
    `INSERT INTO osint_sources (id, kind, name, url, theme, enabled, last_fetched_at, last_status, created_at)`,
    `VALUES ('demo-source-1', 'rss', 'Demo Industry Feed', 'https://example.com/demo/feed.xml', 'industry', 0, ${NOW - 2 * HOUR}, 'ok', ${NOW - 30 * DAY});`,
    '',
  );

  const signals = [
    {
      id: 'demo-signal-1',
      title: 'A major platform ships an agent API, and pricing drops again',
      url: 'https://example.com/demo/agent-api-pricing',
      summary: 'A large platform opened its agent runtime to third parties and cut per-call pricing for the second time this year.',
      angle: 'The interesting part is not the model, it is that orchestration just became a commodity.',
      relevance: 84, content: 88, age: 12 * HOUR,
    },
    {
      id: 'demo-signal-2',
      title: 'Survey: most teams still cannot say what their automation changed',
      url: 'https://example.com/demo/automation-measurement',
      summary: 'A practitioner survey finds a majority of teams running automation in production with no before-and-after measurement.',
      angle: 'Adoption stories are cheap. Ask what got measured, and the field thins out fast.',
      relevance: 76, content: 74, age: 2 * DAY,
    },
    {
      id: 'demo-signal-3',
      title: 'Two competitors merge their tooling and drop the standalone tier',
      url: 'https://example.com/demo/tooling-merger',
      summary: 'A consolidation in the tooling layer removes the entry-level plan that smaller teams were using.',
      angle: 'Consolidation always arrives as a feature announcement and lands as a price rise.',
      relevance: 71, content: 69, age: 3 * DAY,
    },
  ];
  out.push('-- osint_signals');
  for (const s of signals) {
    out.push(
      `INSERT INTO osint_signals (id, source_id, source_name, theme, title, url, summary, published_at, relevance, why, content_score, formats, suggested_angle, status, created_at)`,
      `VALUES (${q(s.id)}, 'demo-source-1', 'Demo Industry Feed', 'industry', ${q(s.title)}, ${q(s.url)}, ${q(s.summary)}, ${NOW - s.age}, ${s.relevance}, 'Demo seed row — safe to delete.', ${s.content}, ${j(['article', 'social'])}, ${q(s.angle)}, 'scored', ${NOW - s.age});`,
      '',
    );
  }

  const topics = [
    {
      id: 'demo-topic-1',
      title: 'Orchestration is becoming a commodity, and that is the whole story',
      thesis: 'When the plumbing gets cheap, the advantage moves to whoever knows what to build with it.',
      why_now: 'Two pricing cuts in a year, and an agent runtime any team can call.',
      angle: 'Stop shopping for infrastructure. Start writing down which decisions you want made for you.',
      heat: 82, age: 10 * HOUR, src: 'https://example.com/demo/topic/orchestration-commodity',
    },
    {
      id: 'demo-topic-2',
      title: 'Nobody is measuring the thing they automated',
      thesis: 'Adoption is being reported as an outcome, which is how a field talks itself into a plateau.',
      why_now: 'A fresh survey puts numbers on what everyone suspected.',
      angle: 'Pick one workflow, measure it for two weeks before you touch it, and only then automate.',
      heat: 68, age: 1 * DAY, src: 'https://example.com/demo/topic/nobody-measures',
    },
    {
      id: 'demo-topic-3',
      title: 'The entry tier is disappearing across the tooling layer',
      thesis: 'Consolidation removes the cheap plan first, and small teams find out at renewal.',
      why_now: 'A merger this week retired a standalone tier with 30 days notice.',
      angle: 'Audit what you would do if each vendor doubled its price. Do that audit before renewal season.',
      heat: 61, age: 2 * DAY, src: 'https://example.com/demo/topic/entry-tier-gone',
    },
  ];
  // NOTE: each topic needs its OWN first source url. The feed dedupes cards by
  // source url (falling back to title), so topics sharing one url collapse into
  // a single card and the feed silently looks emptier than the data is.
  out.push('-- osint_topics');
  for (const t of topics) {
    out.push(
      `INSERT INTO osint_topics (id, title, thesis, why_now, angle, format, heat, sources_json, status, created_at)`,
      `VALUES (${q(t.id)}, ${q(t.title)}, ${q(t.thesis)}, ${q(t.why_now)}, ${q(t.angle)}, 'article', ${t.heat}, ${j([{ title: 'Demo Industry Feed', url: t.src }])}, 'new', ${NOW - t.age});`,
      '',
    );
  }

  // ── hot takes: one package claimed off demo-topic-3 ──────────────────────
  // Claimed on purpose: it proves the "selected" path AND leaves topics 1-2 and
  // all three signals in the feed, since a claimed origin_ref is filtered out.
  out.push('-- hot_take_packages');
  out.push(
    `INSERT INTO hot_take_packages (id, status, title, summary, why_it_matters, source_name, source_url, published_at, origin, origin_ref, pinned,`,
    `  take, believe, misunderstood, who_cares, reader_action, website_status, actor, created_at, updated_at)`,
    `VALUES ('demo-package-1', 'take', ${q(topics[2].title)}, ${q(topics[2].thesis)}, ${q(topics[2].why_now)}, 'Demo Industry Feed', 'https://example.com/demo/tooling-merger', ${NOW - 2 * DAY}, 'osint_topic', 'demo-topic-3', 1,`,
    `  'Consolidation is a price rise wearing a product announcement.',`,
    `  'The entry tier is the first thing to go in every merger, and the teams it served hear about it last.',`,
    `  'People read a merger as capability. It is almost always packaging.',`,
    `  'Anyone whose stack has more than two vendors on an annual plan.',`,
    `  'Run the doubled-price audit before renewal season, not after the email arrives.',`,
    `  'not_planned', 'demo', ${NOW - 2 * DAY}, ${NOW - 6 * HOUR});`,
    '',
  );

  // ── blog: one published, one draft, one scheduled-ish draft ──────────────
  const posts = [
    {
      slug: 'demo-what-to-automate-first',
      title: 'What to automate first, and how to know it worked',
      excerpt: 'Most automation projects fail at the measurement step, not the building step. Here is the order that works.',
      tags: ['demo', 'operations'],
      published: 1, at: NOW - 5 * DAY,
      body: `<p><em>Demo article, seeded so the Blog module opens with something in it. Delete it whenever you like.</em></p>
<p>The usual failure is not technical. A team picks the loudest manual process, automates it, and then has no way to say whether the week got better. Six months later the tool is still running and nobody can defend it.</p>
<h2>Measure before you build</h2>
<p>Pick one workflow. Count how often it runs, how long it takes, and how often it goes wrong. Two weeks of that is enough to argue with.</p>
<h2>Automate the decision, not the click</h2>
<p>Clicks are cheap to remove and cheap to re-add. Decisions are where the time actually goes, and where a system either earns its place or does not.</p>
<h2>Keep the old path warm</h2>
<p>Anything that cannot be done by hand on a bad day is not automation, it is a dependency.</p>`,
    },
    {
      slug: 'demo-the-brief-that-saves-the-draft',
      title: 'The brief that saves the draft',
      excerpt: 'A page of argument before a page of prose. Why the editorial brief is the cheapest quality control there is.',
      tags: ['demo', 'writing'],
      published: 0, at: NOW - 1 * DAY,
      body: `<p><em>Demo draft, seeded so the Blog module has an unpublished post to show. Delete it whenever you like.</em></p>
<p>Every bad article was polished at the wrong altitude. The sentences got better while the argument stayed wrong.</p>
<h2>What a brief has to answer</h2>
<p>Who is this for, what do we claim, what backs it, and what would a smart reader say against it.</p>`,
    },
  ];
  out.push('-- blog_posts');
  for (const p of posts) {
    out.push(
      `INSERT INTO blog_posts (slug, title, excerpt, body, tags, published_at, published, updated_at, updated_by)`,
      `VALUES (${q(p.slug)}, ${q(p.title)}, ${q(p.excerpt)}, ${q(p.body)}, ${j(p.tags)}, ${p.published ? p.at : 'NULL'}, ${p.published}, ${p.at}, 'demo');`,
      '',
    );
  }

  // ── social: two legs off the published demo article ──────────────────────
  out.push('-- social_posts');
  out.push(
    `INSERT INTO social_posts (id, blog_slug, package_id, channel, status, content, notes, actor, blog_title, created_at, updated_at)`,
    `VALUES ('demo-social-1', ${q(posts[0].slug)}, NULL, 'linkedin-company', 'draft',`,
    `  'Most automation projects do not fail at the building step. They fail at the measurement step, which happens before anyone writes a line of it.

Two weeks of counting: how often the workflow runs, how long it takes, how often it goes wrong. That is the whole prerequisite, and it is the step almost everyone skips.

Full piece in the comments.',`,
    `  'Demo row. Delete with --clear-demo.', 'demo', ${q(posts[0].title)}, ${NOW - 5 * DAY}, ${NOW - 5 * DAY});`,
    '',
    `INSERT INTO social_posts (id, blog_slug, package_id, channel, status, content, notes, actor, blog_title, created_at, updated_at)`,
    `VALUES ('demo-social-2', ${q(posts[0].slug)}, NULL, 'linkedin-personal', 'draft',`,
    `  'I have never regretted spending two weeks counting something before automating it. I have regretted the opposite more than once.

The counting is boring and it is the only part that lets you say, later, whether any of it worked.',`,
    `  'Demo row. Delete with --clear-demo.', 'demo', ${q(posts[0].title)}, ${NOW - 5 * DAY}, ${NOW - 5 * DAY});`,
    '',
  );

  // ── prospecting: four leads across the traffic light ─────────────────────
  // Green needs first+last name, company, a PERSON linkedin, and a position.
  // Phone numbers are in the +1-555-01xx range reserved for fiction.
  const leads = [
    {
      id: 'demo-lead-1', phone: '+15550100', name: 'avery stone', company: 'Northwind Robotics',
      position: 'VP Operations', linkedin: 'https://www.linkedin.com/in/demo-avery-stone',
      email: 'avery@example.com', status: 'enriched', icp: 'strong',
      reasons: { reasons: ['Operations lead at a 60-person hardware team', 'Publicly hiring for internal tooling'], gaps: [] },
      country: 'United States', region: 'Massachusetts', line: 'mobile', carrier: 'Demo Mobile',
    },
    {
      id: 'demo-lead-2', phone: '+15550101', name: 'priya raman', company: 'Halden Logistics',
      position: 'Head of Growth', linkedin: 'https://www.linkedin.com/in/demo-priya-raman',
      email: 'priya@example.com', status: 'enriched', icp: 'medium',
      reasons: { reasons: ['Owns demand gen end to end'], gaps: ['No signal on budget authority'] },
      country: 'United Kingdom', region: 'London', line: 'mobile', carrier: 'Demo Mobile',
    },
    {
      id: 'demo-lead-3', phone: '+15550102', name: 'jonas welt', company: 'Kestrel Analytics',
      position: null, linkedin: null, email: null, status: 'enriched', icp: 'weak',
      reasons: { reasons: [], gaps: ['No title found', 'No verified profile'] },
      country: 'Germany', region: 'Berlin', line: 'landline', carrier: 'Demo Telecom',
    },
    {
      id: 'demo-lead-4', phone: '+15550103', name: null, company: null,
      position: null, linkedin: null, email: null, status: 'new', icp: null,
      reasons: null, country: 'United States', region: null, line: null, carrier: null,
    },
  ];
  const STEPS_DONE = [
    { key: 'wa', label: 'WhatsApp', status: 'found', reason: 'demo seed', at: NOW - 3 * DAY },
    { key: 'li', label: 'LinkedIn', status: 'found', reason: 'demo seed', at: NOW - 3 * DAY },
    { key: 'pdl', label: 'PDL', status: 'skipped', reason: 'name and company already known', at: NOW - 3 * DAY },
    { key: 'twilio', label: 'Twilio', status: 'found', reason: 'demo seed', at: NOW - 3 * DAY },
    { key: 'serp', label: 'SerpApi', status: 'found', reason: 'demo seed', at: NOW - 3 * DAY },
    { key: 'confirm', label: 'Confirm', status: 'found', reason: 'demo seed', at: NOW - 3 * DAY },
  ];
  out.push('-- gtm_leads');
  for (const l of leads) {
    const socials = l.linkedin ? [{ type: 'linkedin', url: l.linkedin, src: 'demo' }] : [];
    const sources = l.name
      ? { name: { tool: 'demo', at: '' }, company: { tool: 'demo', at: '' }, position: { tool: 'demo', at: '' } }
      : {};
    out.push(
      `INSERT INTO gtm_leads (id, phone, normalized_phone, status, source, batch_id, country, region, name, socials, linkedin, email, company, position,`,
      `  line_type, carrier, sources, conflicts, dismissed, org_status, org_note, icp_fit, icp_reasons, outreach_lang, steps, company_staff_count, created_at, updated_at)`,
      `VALUES (${q(l.id)}, ${q(l.phone)}, ${q(l.phone.replace(/\D/g, ''))}, ${q(l.status)}, 'demo', 'demo-batch-1', ${q(l.country)}, ${q(l.region)}, ${q(l.name)},`,
      `  ${j(socials)}, ${q(l.linkedin)}, ${q(l.email)}, ${q(l.company)}, ${q(l.position)}, ${q(l.line)}, ${q(l.carrier)}, ${j(sources)}, '[]', '[]',`,
      `  ${l.company ? `'saved'` : 'NULL'}, ${l.company ? `'demo org chart'` : 'NULL'}, ${q(l.icp)}, ${l.reasons ? j(l.reasons) : 'NULL'}, 'en',`,
      `  ${l.status === 'enriched' ? j(STEPS_DONE) : 'NULL'}, ${l.company ? 60 : 'NULL'}, ${NOW - 7 * DAY}, ${NOW - 3 * DAY});`,
      '',
    );
  }

  // ── prospecting: saved outreach angles for the strongest lead ────────────
  const angles = {
    playbook_fit: { language: 'English', channel: 'WhatsApp', fits_hebrew_playbook: false, why: 'US-based operations lead; English, short, no formality.' },
    connection_points: [
      { type: 'company', detail: 'Hiring for internal tooling, which is the exact work being offered.', strength: 'high' },
      { type: 'peer', detail: 'Same operations-lead role we have worked with before.', strength: 'medium' },
    ],
    angles: [
      {
        rank: 1, target: 'Avery Stone - VP Operations', type: 'trigger',
        rationale: 'They posted an internal-tooling role, which means the work exists and nobody has time for it.',
        messages: [
          'Hi Avery, [your name] here. Saw you are hiring for internal tooling at Northwind.',
          'I take the project everyone agrees matters and nobody has room to lead, and hand it back as a working system your team runs.',
          'Worth fifteen minutes?',
        ],
        confidence: 'high', missing: '',
      },
      {
        rank: 2, target: 'Avery Stone - VP Operations', type: 'position_alignment',
        rationale: 'Operations leads carry the tooling backlog personally once a team passes fifty people.',
        messages: [
          'Hi Avery, quick one. At sixty people the internal-tooling backlog usually lands on ops by default.',
          'That is the work I take on, end to end, and leave running.',
        ],
        confidence: 'medium', missing: 'No signal on their current tooling stack.',
      },
    ],
    demo: true,
  };
  out.push('-- gtm_outreach_angles');
  out.push(
    `INSERT INTO gtm_outreach_angles (lead_id, payload, created_at, updated_at)`,
    `VALUES ('demo-lead-1', ${j(angles)}, ${NOW - 2 * DAY}, ${NOW - 2 * DAY});`,
    '',
  );

  // ── outreach: one cohort with a real sequence and two members ────────────
  const sequence = {
    default_language: 'en',
    steps: [
      { delay_hours: 0, channel: 'whatsapp', trigger: 'no_reply', bodies: { en: 'Hi {first_name}, [your name] here. I work with operations leads at companies like {company} on the internal project nobody has room to lead.\n\nWorth a short conversation?' } },
      { delay_hours: 72, channel: 'whatsapp', trigger: 'no_reply', bodies: { en: 'Following up once, {first_name}. If the timing is wrong just say so and I will stop.' } },
      { delay_hours: 168, channel: 'whatsapp', trigger: 'no_reply', bodies: { en: 'Last one from me. If this becomes relevant later, I am easy to find.' } },
    ],
  };
  out.push('-- outreach_cohorts');
  out.push(
    `INSERT INTO outreach_cohorts (id, name, note, created_at, updated_at, sequence, status, timezone, send_days, languages, start_hour, end_hour)`,
    `VALUES ('demo-cohort-1', 'Demo · operations leads', 'Seeded demo cohort. Remove with --clear-demo.', ${NOW - 6 * DAY}, ${NOW - 1 * DAY},`,
    `  ${j(sequence)}, 'active', 'UTC', ${j([1, 2, 3, 4, 5])}, ${j(['en'])}, 9, 19);`,
    '',
  );
  out.push('-- outreach_cohort_members');
  out.push(
    `INSERT INTO outreach_cohort_members (lead_id, cohort_id, chat_id, status, step, next_send_at, last_sent_at, last_sent_text, enrolled_at, updated_at)`,
    `VALUES ('demo-lead-1', 'demo-cohort-1', '15550100@c.us', 'active', 1, ${NOW + 2 * DAY}, ${NOW - 1 * DAY},`,
    `  'Hi Avery, [your name] here. I work with operations leads at companies like Northwind Robotics on the internal project nobody has room to lead.', ${NOW - 6 * DAY}, ${NOW - 1 * DAY});`,
    '',
    `INSERT INTO outreach_cohort_members (lead_id, cohort_id, chat_id, status, step, next_send_at, enrolled_at, updated_at)`,
    `VALUES ('demo-lead-2', 'demo-cohort-1', '15550101@c.us', 'active', 0, ${NOW + 4 * HOUR}, ${NOW - 2 * DAY}, ${NOW - 2 * DAY});`,
    '',
  );

  // ── daily planner: today's plan ──────────────────────────────────────────
  const plan = {
    mode: 'strategic',
    __demo_seed: true,
    summary: 'Demo day plan, seeded so the planner opens with something. Overwrite it by planning your own day.',
    weekly_ref: null,
    schedule: [
      { id: 'b1', start: '09:00', end: '11:00', title: 'Focus session: outreach angles for the qualified list', deliverable: 'Angles drafted and reviewed for every green prospect', done: true, focus: true },
      { id: 'b2', start: '11:30', end: '12:00', title: 'Reply to anything that came in overnight', deliverable: 'Inbox at zero', done: true, focus: false },
      { id: 'b3', start: '14:00', end: '16:00', title: 'Focus session: finish the draft article', deliverable: 'Draft ready for review', done: false, focus: true },
      { id: 'b4', start: '16:30', end: '17:00', title: 'Review the hot takes feed and pick tomorrow topic', deliverable: 'One topic claimed', done: false, focus: false },
    ],
    todos: [
      { id: 't1', text: 'Replace the placeholder knowledge docs with your own voice', done: false, star: true, priority: 1 },
      { id: 't2', text: 'Connect a messaging gateway so outreach can actually send', done: false, star: true, priority: 2 },
      { id: 't3', text: 'Delete the demo rows once the real data is in', done: false, star: false, priority: 3 },
    ],
  };
  out.push('-- plugin_daily_planner_plans');
  out.push(
    `INSERT INTO plugin_daily_planner_plans (date, plan, mode, created_at, updated_at)`,
    `VALUES (${q(TODAY)}, ${j(plan)}, 'strategic', ${NOW - 8 * HOUR}, ${NOW - 2 * HOUR});`,
    '',
  );

  // ── calendar: two events today, one tomorrow ─────────────────────────────
  const cal = [
    { id: 'demo-cal-1', title: 'Demo · intro call with Northwind Robotics', start: NOW + 3 * HOUR, dur: HOUR, loc: 'Video call', desc: 'Seeded demo event. Remove with --clear-demo.' },
    { id: 'demo-cal-2', title: 'Demo · weekly review', start: NOW + 6 * HOUR, dur: 30 * 60000, loc: 'Desk', desc: 'Seeded demo event. Remove with --clear-demo.' },
    { id: 'demo-cal-3', title: 'Demo · content planning', start: NOW + DAY + 2 * HOUR, dur: HOUR, loc: 'Video call', desc: 'Seeded demo event. Remove with --clear-demo.' },
  ];
  out.push('-- calendar_events');
  for (const e of cal) {
    out.push(
      `INSERT INTO calendar_events (id, kind, title, description, starts_at, ends_at, all_day, status, source, location, attendees, created_at, updated_at, created_by, updated_by)`,
      `VALUES (${q(e.id)}, 'meeting', ${q(e.title)}, ${q(e.desc)}, ${e.start}, ${e.start + e.dur}, 0, 'confirmed', 'demo', ${q(e.loc)}, ${j([])}, ${NOW - 2 * DAY}, ${NOW - 2 * DAY}, 'demo', 'demo');`,
      '',
    );
  }

  // ── activity: a believable recent trail ──────────────────────────────────
  const evs = [
    { id: 'demo-event-1', kind: 'osint_signals_ingested', actor: 'demo', at: NOW - 26 * HOUR, payload: { source: 'Demo Industry Feed', ingested: 3, scored: 3 } },
    { id: 'demo-event-2', kind: 'osint_topics_synthesized', actor: 'demo', at: NOW - 25 * HOUR, payload: { topics: 3, from_signals: 3 } },
    { id: 'demo-event-3', kind: 'gtm_lead_enriched', actor: 'demo', at: NOW - 3 * DAY, payload: { id: 'demo-lead-1', state: 'green', steps: ['wa:found', 'li:found', 'pdl:skipped', 'twilio:found', 'serp:found', 'confirm:found'] } },
    { id: 'demo-event-4', kind: 'gtm_angles_generated', actor: 'demo', at: NOW - 2 * DAY, payload: { lead_id: 'demo-lead-1', angles: 2, top_confidence: 'high' } },
    { id: 'demo-event-5', kind: 'outreach_cohort_sent', actor: 'demo', at: NOW - DAY, payload: { cohort_id: 'demo-cohort-1', lead_id: 'demo-lead-1', step: 0, channel: 'whatsapp' } },
    { id: 'demo-event-6', kind: 'blog_post_published', actor: 'demo', at: NOW - 5 * DAY, payload: { slug: 'demo-what-to-automate-first', title: 'What to automate first, and how to know it worked' } },
    { id: 'demo-event-7', kind: 'hottake_topic_added', actor: 'demo', at: NOW - 2 * DAY, payload: { id: 'demo-package-1', origin: 'osint_topic', origin_ref: 'demo-topic-3' } },
    { id: 'demo-event-8', kind: 'plugin_daily_planner_plan_saved', actor: 'demo', at: NOW - 8 * HOUR, payload: { date: TODAY, mode: 'strategic', blocks: 4, todos: 3 } },
  ];
  out.push('-- events (activity bus)');
  for (const e of evs) {
    out.push(
      `INSERT INTO events (id, kind, actor, payload, created_at)`,
      `VALUES (${q(e.id)}, ${q(e.kind)}, ${q(e.actor)}, ${j(e.payload)}, ${e.at});`,
      '',
    );
  }

  return out;
}

// ───────────────────────────────────────────────────────────────────────────

const lines = ['-- Generated by scripts/seed-app.mjs — do not edit by hand.', `-- generated_at ${new Date(NOW).toISOString()}`, ''];

if (CLEAR_ONLY) {
  lines.push(...clearSql());
  process.stderr.write(`emitted DELETEs for demo rows in ${DEMO_PREDICATES.length} tables\n`);
} else {
  if (!DEMO_ONLY) lines.push(...knowledgeSql());
  if (!DOCS_ONLY) lines.push(...demoSql());
  const parts = [];
  if (!DEMO_ONLY) parts.push(`${ALL_DOCS.length} knowledge docs${OVERWRITE_DOCS ? ' (overwrite)' : ' (insert-if-absent)'} + ${ALL_DOCS.length} seed stamps`);
  if (!DOCS_ONLY) parts.push(`demo rows across ${DEMO_PREDICATES.length} tables`);
  process.stderr.write(`seeded ${parts.join(' + ')}\n`);
}

process.stdout.write(lines.join('\n') + '\n');
