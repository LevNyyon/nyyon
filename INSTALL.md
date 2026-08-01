# Install

## The one line

Paste this into Claude Code (or Codex, or any coding agent with a terminal):

```
Install Nyyon Command Center by running: curl -fsSL https://raw.githubusercontent.com/LevNyyon/nyyon-command-center/main/install.sh | sh
```

A minute or two later a browser opens on the setup screen. Create your account,
paste an Anthropic API key, and you are in the app.

If you would rather not pipe a script into a shell, the same thing by hand:

```bash
git clone https://github.com/LevNyyon/nyyon-command-center.git
cd nyyon-command-center
npm run setup
npm start
```

## What it does to your machine

Nothing that needs an admin password, and nothing outside two directories.

- Installs the app into `~/nyyon-command-center`.
- If Node 20+ is missing, installs Node into `~/.nvm` using nvm. It does not
  touch a system Node, so it cannot break another project.
- Creates a local database inside the install folder. No Cloudflare account and
  no cloud services are required to run it.
- Generates a `.dev.vars` with a sign-in secret unique to your install.

Set `NYYON_DIR` to install somewhere else.

## What you need

- macOS or Linux. On Windows, use WSL.
- An Anthropic API key: <https://console.anthropic.com/settings/keys>.
  Setup asks for it on the second screen and you can skip it and add it later.

Everything else (your writing voice, your sources, WhatsApp, LinkedIn) is asked
for by the module that needs it, the first time you open that module.

## Where the code ends up

The folder it installs into **is** the app. There is no separate installed copy
and no build output to keep in sync, so you can edit the source and restart to
see the change. The **Expand build** screen inside the app shows you the path
and gives you a prompt to hand a coding agent.

One consequence worth knowing: the packaged desktop app lives inside that folder
and finds the source by looking upward from itself. Moving the app out on its
own breaks it.

## If it goes wrong

The installer writes two logs:

- `/tmp/nyyon-setup.log` — dependency install, database build, seeds
- `/tmp/nyyon-run.log` — the running servers

Re-running the installer is safe. It updates an existing install rather than
overwriting your data.

**Resetting to a fresh install** is the one operation with a trap. The local
database cannot be edited while the app is running: the live server holds it
open and will overwrite changes made from another process, silently. Stop the
app first, then reset.
