# nyyon

**Your own AI command center. One click. Free. Nothing shared with anyone.**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LevNyyon/nyyon)

Click it. Cloudflare asks you to sign in (the free account is email and
password, no card), forks this repo to your GitHub, creates your database and
storage in your own account, deploys, and hands you an https address. No
terminal, no token, nothing to copy. Open the address, create your account on
the first screen, and you are in from any device.

Four modules arrive installed and active: **Daily Planner, Digest, Editorial
(Blog, Hot Takes, Social), GTM (Prospecting, Outreach)**. Nothing is
pre-loaded: no sample data, no keys, no other person's history. Add an
Anthropic key when setup asks and the assistant starts answering.

<details>
<summary><b>Want an AI agent to install it instead?</b></summary>

An agent cannot click through a browser sign-in, so give it a token.

1. [**Create the token**](https://dash.cloudflare.com/profile/api-tokens/create?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%5D&name=nyyon-deploy&accountId=%2A&zoneId=all) — the link opens Cloudflare with the right
   permissions already ticked. Press Continue to summary, then Create Token,
   and copy it. Cloudflare shows it once.
2. Paste this to Claude, with your token in place of the placeholder:

```
Install nyyon for me. Clone https://github.com/LevNyyon/nyyon, cd into it,
then deploy it to my Cloudflare account using this token:

CLOUDFLARE_API_TOKEN=<paste your token here>

Run `npm install`, then `CLOUDFLARE_API_TOKEN=<token> npm run deploy`.
When it finishes, give me the URL and the setup link it prints.
```

3. Open the link it gives you and create your account.

</details>

<details>
<summary><b>Do it yourself in a terminal</b></summary>

```
git clone https://github.com/LevNyyon/nyyon && cd nyyon
npx wrangler login
npm run deploy
```

Re-running the deploy updates the app and keeps your data.

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
