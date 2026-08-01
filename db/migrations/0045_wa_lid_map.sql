-- 0045 — WhatsApp LID -> phone cache. LIDs (privacy ids) dominate group
-- senders; the wa-gateway resolves them through WhatsApp Web's own LID<->PN
-- map (getContactLidAndPhone). Resolved pairs cache here so each LID costs
-- one gateway round-trip ever; null phones re-resolve after a TTL.
CREATE TABLE IF NOT EXISTS wa_lid_map (
  lid         TEXT PRIMARY KEY,          -- '<digits>@lid'
  phone       TEXT,                      -- E.164 ('+972...') or NULL when WhatsApp won't share
  pn          TEXT,                      -- raw '<digits>@c.us' wid from the gateway
  resolved_at INTEGER NOT NULL
);
