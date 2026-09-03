# nyyon

**Your own AI command center. Three minutes. Free. Nothing shared with anyone.**

## Install

1. **Log in to Cloudflare — or create the free account**: [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). Email and password, no card.
2. **Verify your email** — click the link Cloudflare sends you.
3. **Paste this to your AI agent** (Claude Code, Cursor, any agent that runs commands):

```
Install nyyon for me: clone https://github.com/LevNyyon/nyyon, cd into it, run
`npx wrangler login` and wait while I approve it, then run `npm run deploy`
and give me the setup link it prints.
```

4. Your browser opens once — click **Allow**. That connects the deploy to **your** account: your app, your database, your https address.
5. Your agent hands you a setup link. Open it, set your password, you're in — from any device, forever.

Six packs come installed: **Daily Planner, Digest, Editorial (Blog, Hot Takes, Social), GTM (Prospecting, Outreach), News Search, Brave Search**. Add an
Anthropic key in Settings when you want the AI to answer; everything else works
without it. Re-running the install updates the app and keeps your data.

<details>
<summary><b>No agent? Install by hand</b></summary>

The same three commands, run yourself:

```
git clone https://github.com/LevNyyon/nyyon && cd nyyon
npx wrangler login
npm run deploy
```

</details>

<details>
<summary><b>Everything else</b> — other ways to run it, architecture, the plugin format</summary>

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

| Frontend | Vite + React + Tailwind |

## Modules

- **Nyo**: the chat assistant, persistent across sessions, tool-using.
- **Knowledge**: editable docs Nyo reads and writes: the source of truth for rules, voice, and settings.
- **Blog + AEO**: write, publish, and distribute articles to your public site, in your voice.
- **Hot Takes**: turn industry signals into a take, a brief, an article, and social posts.
- **Outreach + Prospecting**: WhatsApp-first outreach queues where only the operator approves sends.
- **Signals / OSINT**: feed sources and listeners that keep the system aware of your industry.

</details>
