# nyyon: development brief

## What it is
A self-owned AI command center. One install per person: the app, its database, its scheduled work. Nothing leaves it unless the operator connects something.

## Use cases
1. Plan the day. Talk to the Daily Planner, get a concrete plan: two-hour Focus Sessions, supporting blocks, a to-do list. Adjust it live. Carry over what did not happen.
2. Read the brief. The Digest turns everything that piled up into one short brief: action needed, worth knowing, can wait. Sources are whatever the install has (news for chosen topics, calendar, more when connected).
3. Ask Nyo anything and have it act. One assistant, every tool of every installed module, tiered models (fast, standard, deep).
4. Extend without touching core. Modules arrive as plugins: install, remove, export, import from the Plugins page. A plugin can add a gateway (e.g. news search) and existing modules pick it up by capability.

## Shape
- Host: Cloudflare Worker (Hono) + D1 + a React SPA. Crons at :00, :45, 06:00. Optional R2 for images.
- Self-hosted alternative: `npm run server` runs the worker locally plus sidecars (plugin applier, telegram poll, whatsapp).
- Bundled plugins: daily-planner, digest. Everything else is a zip.
- Credentials are database-first (Settings), env is fallback. Anthropic key is the only model requirement.
- Knowledge docs are the control surface: personas, policies, topics, model tiers. Edit a doc, behavior changes.

## Principles (non-negotiable)
- Five layers: gateway, tool, workflow, module, knowledge. Each change lives in exactly one.
- A gateway is the boundary to one external service and never reasons.
- Tools do one job and reach services only through gateways. Every tool is documented in knowledge so Nyo can call it.
- Rules and constants live in knowledge, not code.
- The host discovers by capability, never by provider name (llm-backup, search).
- Packs own their namespace: their tables, their plugin-* docs, their gateways. No DDL from pack code; table changes are host migrations.
- The host seed carries the host plus bundled packs, nothing else. A fresh install describes itself truthfully.
- A source runs only while its backing exists on this install. No control panels over absent capabilities.
- Errors say what is actually wrong. Never invent a cause.
- Zero setup wherever possible. If a provider needs a key, say so before the user pastes anything.

## UX / UI
- One shell: a fixed left rail, a page in the middle, drawers from the right. No top nav on desktop; a hamburger bar on phones.
- Rail: logo top-left, then three groups with small mono uppercase eyebrows: MODULES (Nyo, installed plugins), PLUGINS, SYSTEM (Knowledge, Plugins, Activity, Expand build, Settings). Bottom-left: a health dot and the version. Active item is ink on paper; the rest is mute text.
- Nyo is a right-side drawer (460px, full width on phones) opened by a round ink launcher bottom-right with an unread dot. It rides alongside any page. The Daily Planner has its own chat, so the launcher hides there.
- Item detail (digest cards etc.) is a second right drawer (520px) over a dim blurred backdrop. Drawers slide, never navigate.
- Palette: paper #FAFAF9, ink #0A0A0A, line #E7E5E4, mute #78716C, card #FFFFFF. Dark mode flips them (paper #09090B, ink #FAFAF9, line #27272A, mute #A1A1AA, card #18181B). Emerald for connected or done, rose for errors, no other accent colors. A faint grid on the ground.
- Type: Inter for everything; JetBrains Mono for eyebrows, chips, ids, timestamps, always small, uppercase, letter-spaced. Body text 12 to 13px. One weight of hairline border for every edge.
- Buttons: primary is ink on paper text, secondary is hairline on paper, small radius (rounded-sm), no gradients, no shadows except drawers and the launcher.
- Empty states teach: a first-open card ("nyo · how this works") with what goes in, what comes out, and what is expected of the person. It disappears once real content exists.
- Chat: sender label once per run of messages, timestamp under the last one. Tier switch (Low, Mid, High) and voice toggle in the composer footer. Errors are sentences that name the real cause.
- Every page must work at phone width: cards own the screen, side panels become drawers, tab strips hide.

## Onboarding: how it looks and feels
Setup is its own surface, not the app shell: paper ground, one centered column, the mono eyebrow "nyyon · setup" above every step. No sidebar, no drawer, nothing to explore until setup is done. Four steps, one screen each, a thin progress line at the top.

1. Account. Heading "Create your account", two fields (email, password), one ink button. No verification mail, no terms wall. The install is yours the moment you press it.
2. Model. Headline: what the key is for in one sentence. A single field with a placeholder that shows the key's shape, and a link that opens the provider's key page beside the form. The button reads "verify and continue" and verifies with a real call before moving on. A wrong paste gets a sentence saying what was pasted and what to copy instead. "Later" is always visible: it defers, it never nags.
3. Services. The external connections this build knows (only what is real), each a card with its own steps and a paste field. All skippable with one line, "Skip services for now"; each can be connected later in Settings.
4. Interview. Nyo, in the same chat look as the app, asks four or five plain questions about who you are and what you do. Each answer writes a knowledge doc live; you can paste a whole post as an answer and line breaks are kept. Short answers are fine; "skip" is fine. It ends by saying what it wrote and where to edit it.

Then the app opens on the Daily Planner with the first-open card showing. Nothing else is pre-filled: no sample data, no demo rows, no other person's history. The Knowledge tree contains only what this install has.

Rules for every setup screen:
- One action per screen, one sentence of context above it. No feature tours, no marketing copy.
- Tell the truth before the user acts: a container without persistent storage says so on the first screen instead of taking them through setup that will be lost.
- Every wait shows what is being verified; every failure names the real cause and what to do next.
- Back is always possible; nothing is irreversible before the app opens.
- Copy is second person, present tense, no exclamation marks.

Each module explains itself on first open (see UX / UI). After that the product stays quiet until there is something real to say: the wake-up briefing on the first Nyo open is built from actual state, and is silent when there is nothing.

## Ops rules
- Bump a plugin version to redeploy it; same-version seeds are skipped.
- Never delete plugin rows while the applier runs.
- Regenerate bundle-schema and materialize-bundled with any pack change; commit the generated tree.
- Run the nyyon-lite review before finishing any code change.

## Not in this build (deliberately)
Free model tiers (Groq, Gemini), WhatsApp sidecar, LinkedIn, email. Each returns only as a plugin that proves itself.

## Size
About 31k lines of source: host worker 12.4k, web 6.6k, digest 6.5k, planner 1.2k, scripts and services 4.5k.
