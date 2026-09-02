# Command Center

An AI command center you own: outreach, writing, and publishing from one place, in your voice. A chat assistant called **Nyo** sits at the center, surrounded by **modules** (product areas with their own pages) and **tools** (granular capabilities Nyo can use). It runs entirely on your own machine: Workers runtime plus a local SQLite (D1) database.

## Get your own nyyon (free, ~3 minutes)

Every install is fully independent: your Cloudflare account, your worker,
your database, your URL — reachable from any device, shared with no one.
Free tier, no card.

Have an AI agent (Claude Code, Cursor, ...)? Paste this:

```
Set up my own nyyon:
git clone https://github.com/LevNyyon/nyyon && cd nyyon
run `npx wrangler login` and wait for me to click Allow,
then `npm run deploy` and give me the setup link it prints.
```

Your part is two moments: click **Allow** when the browser opens (create the
free Cloudflare account right there if you don't have one — email + password),
then open the setup link your agent hands you and set your password. Done.

No agent? The same three commands, run by hand:

```
git clone https://github.com/LevNyyon/nyyon && cd nyyon
npx wrangler login
npm run deploy
```

The installer creates everything in your account, installs the four modules
(Daily Planner, Digest, Editorial, GTM), and prints a one-time setup link
that dies the moment your account exists. Re-running it later updates the
app and keeps your data. Add an Anthropic key in Settings when you want the
AI to answer — everything else works without it.

## Other ways to run it

**Render** (paid: ~$7/month Starter + a 1GB disk — the free tier forgets
everything on restart). One [deploy link](https://render.com/deploy?repo=https://github.com/LevNyyon/nyyon)
builds a container instance from [`render.yaml`](render.yaml) with the database
on a mounted disk and the scheduled work driven in-process. If you deploy it
without a disk, the app refuses setup and shows exactly what to change —
nobody configures an install that was going to forget them.

**Your own machine**

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
