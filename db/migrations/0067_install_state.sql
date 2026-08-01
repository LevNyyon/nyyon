-- Install state + gateway credential store.
--
-- WHY THIS EXISTS
-- A Worker cannot write its own secrets. `wrangler secret put` is a deploy-time
-- operation from a developer's machine, so the reference command center could
-- only ever be configured by the person who deployed it. That is fine for one
-- operator and impossible for a product somebody unzips and runs: the whole
-- point of the pre-login onboarding chat is that connecting WhatsApp, or
-- pasting an Anthropic key, happens IN the app, at runtime, by a person who
-- has never seen a terminal.
--
-- So the DB becomes the first source of truth for credentials, and env
-- (Cloudflare secrets / .dev.vars) stays as the fallback. Purely additive:
-- an install that configures everything with `wrangler secret put` behaves
-- exactly as it does today, because an absent row means "fall through to env".
--
-- ── install_state ──────────────────────────────────────────────────────────
-- Exactly one row, forced by the CHECK. It answers one question the whole app
-- gates on: has this install been claimed by an operator yet?
--
--   onboarded_at NULL  → onboarding is OPEN. The setup surface is reachable.
--   onboarded_at SET   → onboarding is CLOSED, permanently. The setup surface
--                        is dead, and setup_token is burned to NULL.
--
-- setup_token is the out-of-band proof that whoever is at the keyboard is the
-- person who installed this (printed by the installer). It is only needed for
-- a NON-localhost first run: on localhost the loopback address is the proof.
-- It is a bearer token, so it never leaves the server except at install time
-- and is destroyed the moment credentials are set.
--
-- The admin password is stored as PBKDF2-SHA256 (per-install random salt,
-- iteration count carried inside admin_hash so it can be raised later without
-- a migration). Never the password, never a reversible form of it.
CREATE TABLE IF NOT EXISTS install_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  onboarded_at  INTEGER,
  setup_token   TEXT,
  admin_user    TEXT,
  admin_hash    TEXT,
  admin_salt    TEXT,
  created_at    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT 0
);

-- ── gateway_config ─────────────────────────────────────────────────────────
-- One row per gateway slug (the slugs in workers/api/src/gateways/index.js).
-- `config` is a JSON object of credential key -> value, keyed by the SAME env
-- names the libs already read (WA_API_KEY, ANTHROPIC_API_KEY, ...), so the
-- resolution seam is a one-line overlay rather than a rewrite of every lib.
--
-- Only keys a gateway DECLARES are ever stored or applied. That is a security
-- property, not tidiness: without the allowlist a write to this table could
-- shadow a Worker binding (DB, ASSETS, AI) on the resolved env object.
--
-- configured_at is stamped on first successful save and left alone afterwards,
-- so "connected since" survives a credential rotation.
CREATE TABLE IF NOT EXISTS gateway_config (
  slug          TEXT PRIMARY KEY,
  config        TEXT NOT NULL DEFAULT '{}',
  configured_at INTEGER,
  updated_at    INTEGER
);
