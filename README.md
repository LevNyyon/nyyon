# Nyyon Command Center

Operator backstage hub for Nyyon. A chatbot called **Nyo** sits at the center, surrounded by **modules** (workflows) and **tools** (granular capabilities). Built on the Cloudflare suite (Pages + Worker + D1) with the Inrepute paper/ink visual language.

## Layout

- `web/` — Vite + React 19 + Tailwind v4. Sidebar lists modules and tools. ChatDrawer (Cmd/Ctrl+J) is Nyo.
- `workers/api/` — Hono on Cloudflare Workers. REST routes + Nyo SSE chat endpoint with tool-use loop.
- `db/` — D1 schema + seed migration.

## Clone & run (local dev)

Any teammate can run the whole stack locally, independent of everyone else —
each person has their **own** local D1 and their **own** `.dev.vars`.

**You need:** Node 18+ and a Cloudflare API token for the account. The worker's
R2 + Workers-AI bindings are `remote: true`, so `wrangler dev` reaches the real
account for those — export `CLOUDFLARE_API_TOKEN=…` (or `wrangler login` if you
have dashboard access).

```bash
git clone https://github.com/LevNyyon/nyyon-command-center-online.git
cd nyyon-command-center-online

# 1. deps
npm --prefix workers/api install
npm --prefix web         install

# 2. secrets — copy the example, fill in your OWN keys
cp workers/api/.dev.vars.example workers/api/.dev.vars
#   ANTHROPIC_API_KEY, GATE_USER, GATE_PASSWORD, GATE_SECRET   (WA_API_KEY optional)

# 3. local database — schema + ALL migrations, one command
npm --prefix workers/api run db:apply:local

# 4. run (two terminals)
npm --prefix workers/api run dev   # API  :8788
npm --prefix web         run dev   # UI   :5174
```

Open <http://localhost:5174>. The login gate (`src/gate.js`) uses the `GATE_*`
you set; Cmd/Ctrl+J wakes Nyo.

## Working in parallel

- Each dev runs their **own** local D1 + `.dev.vars` — no shared local state, no stepping on each other.
- Branch + PR into `main`. Keep secrets out of git (`.dev.vars` is gitignored).
- Deploys to **cmd.nyyon.com are currently manual**: `npm --prefix workers/api run deploy`. Production secrets live on the Worker (`wrangler secret put …`), not in the repo. (The git-push auto-build is being stabilized — until then, a push does **not** safely deploy.)

## Stack

| Layer | Choice |
|---|---|
| LLM | Anthropic Claude Opus 4.7 (`claude-opus-4-7`) |
| Edge runtime | Cloudflare Workers (Hono) |
| DB | Cloudflare D1 (SQLite) |
| KV / R2 | bindings reserved in wrangler.jsonc, wired as modules need them |
| Frontend | Vite + React 19 + Tailwind v4 |
| Brand | Inrepute paper/ink minimal grid |

## Modules (v0)

- **Nyo** — the chatbot, persistent across sessions, tool-using.
- **Knowledge** — markdown docs Nyo reads + writes. Source of truth for system design.
- **Roadmap** — relational nodes + edges describing what shipped, what's next.

## Planned

Website, Blog, AI SDR, OSINT (Reddit + WhatsApp listeners), Remotion video, ChatGPT image gen.
