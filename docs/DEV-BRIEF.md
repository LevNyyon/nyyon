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

## Onboarding
Create account, paste Anthropic key (verified with a real call), short interview writes the voice docs. First open of each module explains what goes in, what comes out, and what is expected of the person.

## Ops rules
- Bump a plugin version to redeploy it; same-version seeds are skipped.
- Never delete plugin rows while the applier runs.
- Regenerate bundle-schema and materialize-bundled with any pack change; commit the generated tree.
- Run the nyyon-lite review before finishing any code change.

## Not in this build (deliberately)
Free model tiers (Groq, Gemini), WhatsApp sidecar, LinkedIn, email. Each returns only as a plugin that proves itself.

## Size
About 31k lines of source: host worker 12.4k, web 6.6k, digest 6.5k, planner 1.2k, scripts and services 4.5k.
