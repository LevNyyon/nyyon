-- Seed the two digest sources that generateDigest() runs but 0016 never created
-- rows for: 'osint_insights' (synthesized hot-topic angles that lead the brief)
-- and 'heartbeat' (weekly content signals). Without a row they defaulted to
-- always-on (isChannelEnabled treats a missing row as enabled), were invisible
-- to the Channels UI + /api/system/health, and could not be disabled. enabled=1
-- keeps current behaviour; now they're toggleable + stat-tracked like every
-- other source.
INSERT OR IGNORE INTO digest_channels (source, label, enabled, cadence, notes, created_at, updated_at) VALUES
  ('osint_insights', 'OSINT insights',  1, 'hourly', 'Synthesized hot-topic angles — leads the brief (urgency 1).', unixepoch()*1000, unixepoch()*1000),
  ('heartbeat',      'Content signals', 1, 'hourly', 'The week''s strongest content signals from the OSINT heartbeat.', unixepoch()*1000, unixepoch()*1000);

-- Drop the stale 'OpenWA' label — we no longer use open-wa.
UPDATE digest_channels
   SET label = 'WhatsApp', updated_at = unixepoch()*1000
 WHERE source = 'whatsapp' AND label LIKE '%OpenWA%';
