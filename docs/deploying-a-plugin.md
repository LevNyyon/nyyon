# Deploying a nyyon plugin to the web

You are Claude Code. This file is the whole brief. It covers two different
jobs that both get called "deploy" — read the first section, decide which one
the operator means, and do that one.

| The operator wants… | Do PART A | Do PART B |
|---|---|---|
| "publish/share this plugin so people can install it" | ✅ | |
| "put the app itself online so I can use it from anywhere" | | ✅ |
| Both ("ship it") | ✅ then ✅ | |

A plugin is NOT a website. Publishing a plugin means putting its source
somewhere an install can fetch it. Deploying the app means running the nyyon
command center on Cloudflare. They are independent.

---

# PART A — publish the plugin so anyone can install it

The unit is a **git repo**. An install imports from a URL, records that URL,
and can re-fetch a newer version later. That is why a repo beats emailing a
zip: version, update path, provenance.

## What you have

Either a pack FOLDER (`plugins/<name>/` — manifest.json + tools/ + knowledge/
+ surface/) or a `.zip` of that folder. If you only have the zip, unzip it
first: `unzip <file>.zip -d <name>` — the folder is the real artifact.

## Steps

1. **Sanity-check the pack before publishing anything.** From a nyyon repo:
   ```
   node scripts/pack-plugin.mjs <path-to-pack> > /tmp/pack.json
   node --input-type=module -e "import {validateManifest} from './workers/api/src/lib/plugins.js'; import {readFileSync} from 'node:fs'; const r = await validateManifest({}, JSON.parse(readFileSync('/tmp/pack.json','utf8')).manifest); console.log((r.errors||[]).filter(e=>!e.includes('tool pool unavailable')));"
   ```
   An empty array means it is publishable. `tool pool unavailable` is an
   environment artifact outside the worker — ignore that one line only.
   Anything else: fix it, do not publish.

2. **Create the repo and push.** The pack folder's CONTENTS go at the repo
   root, so `manifest.json` is the top-level file:
   ```
   cd <pack-folder>
   git init -b main
   git add -A
   git commit -m "<name> plugin v<version>"
   gh repo create <owner>/<name>-plugin --public --source=. --push
   ```
   Ask the operator before making it public if the pack embeds anything
   private — read manifest.json's knowledge bodies first and say what you see.

3. **Tag the version** so installs can pin it:
   ```
   git tag v1.0.0 && git push --tags
   ```

4. **Hand back the install line.** In any nyyon install: Plugins → Install
   from a source → paste
   `https://github.com/<owner>/<name>-plugin` (add `/tree/v1.0.0` to pin).

## Verify it really installs

Do not declare success on a push. Install it into a running instance:

```
curl -s -b <cookie> -X POST -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/<owner>/<name>-plugin"}' \
  <base>/api/plugins/import-url
```

Expect `{"ok":true,"status":"bound"}`, then poll `<base>/api/plugins` until
that plugin reads `active` (code-bearing packs take a minute: files
materialize, the SPA build gate runs, the app reloads). `blocked` means the
validator refused it — the `errors` array says exactly why.

---

# PART B — deploy the nyyon app itself to the web (Cloudflare)

The app is a Cloudflare Worker: `workers/api/` serves the API AND the built
SPA from `web/dist`, with D1 for data and R2 for assets.

## Preconditions (ask the operator, do not guess)

- A Cloudflare account + an API token with Workers, D1, and R2 permissions.
- Decide the worker name (`wrangler.jsonc` → `name`). Two people deploying
  the same name overwrite each other.

## Steps

1. **Build the SPA** (the worker serves it, so a stale build ships stale UI):
   ```
   cd web && npm install && npm run build
   ```
   A failing build is a STOP. Never deploy past it.

2. **Create the remote D1 database and paste its id into `wrangler.jsonc`**
   (locally that field is the string `LOCAL`; remote needs the real uuid):
   ```
   cd workers/api
   CLOUDFLARE_API_TOKEN=<token> npx wrangler d1 create nyyon
   ```

3. **Apply schema + every migration, in order** — this is the step people
   skip and then see 500s from empty tables:
   ```
   CLOUDFLARE_API_TOKEN=<token> npx wrangler d1 execute nyyon --remote --file ../../db/schema.sql
   for f in ../../db/migrations/*.sql; do
     CLOUDFLARE_API_TOKEN=<token> npx wrangler d1 execute nyyon --remote --file "$f"
   done
   ```

4. **Create the R2 bucket** named in `wrangler.jsonc` (`nyyon-assets`).

5. **Deploy:**
   ```
   CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
   ```

6. **Set secrets** (never commit them):
   `npx wrangler secret put ANTHROPIC_API_KEY` and any gateway keys the
   operator uses.

7. **Register cron triggers.** `wrangler deploy` does NOT always sync them:
   ```
   CLOUDFLARE_API_TOKEN=<token> npx wrangler triggers deploy
   ```

## Bundled plugins on a web deploy

A Worker cannot write its own source, so the local applier does not exist in
the cloud. The packs in `plugins/` are therefore NOT auto-seeded there.
Install them the PART A way (import-url), or commit their materialized files
into the repo so the build includes them.

## Verify

1. `curl -o /dev/null -w '%{http_code}' <url>/` → 200.
2. Open the URL: a fresh deploy must show **"Create your account, step 1 of 2"**.
   A login wall instead means the database carried over an old account.
3. `<url>/api/plugins/surfaces` → 401 unauthenticated. That is correct: it
   proves the route exists and is gated.

---

# Rules for whoever runs this

- Never push secrets. Check `git status` before the first commit; `.dev.vars`
  and anything with a key in it stays out.
- Never deploy a working tree. Deploy committed state (`git archive HEAD`)
  so local scratch files cannot ride along.
- A build failure or a `blocked` import is the answer, not an obstacle to
  route around. Report the exact error text to the operator.
- Do not invent a hosting provider. If Cloudflare credentials are missing,
  stop and ask.
