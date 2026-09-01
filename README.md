# Command Center

An AI command center you own: outreach, writing, and publishing from one place, in your voice. A chat assistant called **Nyo** sits at the center, surrounded by **modules** (product areas with their own pages) and **tools** (granular capabilities Nyo can use). It runs entirely on your own machine: Workers runtime plus a local SQLite (D1) database.

## Install it on the web (one click)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/LevNyyon/nyyon)

Click the button. Render reads [`render.yaml`](render.yaml), asks you to confirm,
and builds your own instance: one web service, one 1GB disk, its own https
address. The first screen is "create your account" — the install belongs to
whoever opens it first, and that is you.

Everything runs INSIDE that instance: the app, its SQLite database on the
mounted disk, and the scheduled work (driven from inside the process, no
external scheduler). Nothing is hosted anywhere else, and you never hand a
credential to anyone.

**What it costs.** The instance needs a disk to remember anything, and disks
require Render's Starter plan: about $7/month plus $0.25 for the 1GB disk.

**You cannot set it up wrong.** If you deploy without a disk, the app checks its
own storage at boot and REFUSES to take you through setup, showing exactly what
to change instead. Nobody spends an hour configuring an install that was going
to forget them. (Deliberately want a throwaway demo? `NYYON_ALLOW_EPHEMERAL=1`
steps the screen aside.)

**What comes with it.** Four modules ship as plugins and are installed and
active on first boot: Daily Planner, Digest, Editorial (Hot Takes, Blog,
Social) and GTM (Prospecting, Outreach). Nothing else is pre-loaded — no
sample data, no keys. Add an Anthropic key in Settings when you want Nyo and
the writing tools to answer.

## Install it on your own machine

See [INSTALL.md](INSTALL.md) for the one-line installer and exactly what it does to your machine. By hand, from a clone of this repo:

```bash
npm run setup   # dependencies, local database, .dev.vars with a unique sign-in secret
npm start       # starts the API and the UI, then opens the setup screen
```

Create your account on the setup screen and paste an Anthropic API key when asked (you can skip it and add it later). External connections (WhatsApp, LinkedIn, social webhooks, enrichment APIs) are off until you configure them; each module asks for what it needs the first time you open it. Secrets live in `workers/api/.dev.vars`, which is gitignored.

## Layout

- `web/`: Vite + React + Tailwind SPA. The sidebar lists modules; the ChatDrawer (Cmd/Ctrl+J) is Nyo.
- `workers/api/`: Hono on the Workers runtime. REST routes plus the Nyo SSE chat endpoint with a tool-use loop.
- `db/`: D1 schema + migrations.
- `desktop/`: the packaged desktop app shell (Electron).
- `scripts/`: setup, run, and seed scripts.
- `docs/`: architecture and inventory notes.

## Architecture

The system is built in five layers, and each layer may reach only the layer(s) below it:

1. **Gateway**: the boundary to one external service. No reasoning.
2. **Tool**: one job, in a single shared pool.
3. **Workflow**: an ordered list of existing tools. No logic.
4. **Module**: a product area with a page.
5. **Knowledge**: editable rules, constants, and prompts. Change behavior by editing a note, not code.

Under everything sits an activity bus: every meaningful mutation logs an event. See `docs/` for the full tool, gateway, and workflow inventory.

## Stack

| Layer | Choice |
|---|---|
| LLM | Anthropic Claude (model choices live in the `llm-models` knowledge doc) |
| Runtime | Workers runtime (Hono), run locally via wrangler |
| DB | D1 (SQLite), local |
| Assets | R2 binary store (local simulation via wrangler) |
| Frontend | Vite + React + Tailwind |

## Modules

- **Nyo**: the chat assistant, persistent across sessions, tool-using.
- **Knowledge**: editable docs Nyo reads and writes: the source of truth for rules, voice, and settings.
- **Blog + AEO**: write, publish, and distribute articles to your public site, in your voice.
- **Hot Takes**: turn industry signals into a take, a brief, an article, and social posts.
- **Outreach + Prospecting**: WhatsApp-first outreach queues where only the operator approves sends.
- **Signals / OSINT**: feed sources and listeners that keep the system aware of your industry.
