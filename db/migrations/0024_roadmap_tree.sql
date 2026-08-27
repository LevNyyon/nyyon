-- 0021 — Roadmap as a tree.
--
-- Adds `parent_id` to `roadmap_nodes` so the planning surface reads
-- top-down ("here''s what we ship, and inside each module here''s what
-- comes next") instead of a flat status-grouped list. Existing edges
-- stay as semantic dependency / related links — distinct from the
-- hierarchy.

ALTER TABLE roadmap_nodes ADD COLUMN parent_id TEXT REFERENCES roadmap_nodes(id);
CREATE INDEX IF NOT EXISTS idx_roadmap_nodes_parent ON roadmap_nodes(parent_id);

-- Seed roadmap nodes + reparenting/status updates removed for the shipped product; the roadmap starts empty and is built by the operator.
