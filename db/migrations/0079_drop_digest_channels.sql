-- The digest's channels control plane is gone (digest 2.x): sources run by a
-- live availability probe, and the knobs live in Knowledge. The table (and
-- its seed rows, from 0016/0040/0074/0075) is an orphan on every install.
-- DDL belongs to the host, never to plugin code — the scoped plugin db bans
-- it, so a DROP inside the pack was a silent no-op.
DROP TABLE IF EXISTS plugin_digest_channels;
