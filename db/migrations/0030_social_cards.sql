-- 0030 — Social cards: code-drawn brand graphics (lib/social-cards.js).
-- Each row is one generated card. The PNG lives in the nyyon-assets R2 bucket
-- under social/<slug>-<template>.png (overwritten on regenerate, same as blog
-- featured images). slots_json captures the exact text the card was drawn
-- with so the operator can read what produced it and regenerate variations.

CREATE TABLE IF NOT EXISTS social_cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT,                -- blog post slug; NULL for custom cards
  template    TEXT NOT NULL,       -- split | statement | checklist | flow
  url         TEXT NOT NULL,       -- public URL (ASSETS_BASE_URL + key)
  r2_key      TEXT NOT NULL,
  slots_json  TEXT,                -- the text slots the card was rendered with
  width       INTEGER,
  height      INTEGER,
  actor       TEXT,                -- nyo | operator | system
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_social_cards_slug ON social_cards(slug);
