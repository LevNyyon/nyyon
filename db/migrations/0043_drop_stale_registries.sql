-- Drop the hand-maintained modules / tools / roadmap registry tables. They
-- drifted out of sync with reality and are replaced by the LIVE /api/registry
-- (workers/api/src/lib/registry.js), which is derived from the running code —
-- real gateways, Nyo's actual tool registry, and the scheduled workflows, each
-- with its knowledge dependencies. The rows were exported to a backup before
-- this drop. Nothing else in the schema references these tables.
DROP TABLE IF EXISTS tools;
DROP TABLE IF EXISTS modules;
DROP TABLE IF EXISTS roadmap_edges;
DROP TABLE IF EXISTS roadmap_nodes;
