-- Conversations carry the agent that produced them.
--
-- Nyo and the Daily Planner both persist through the same handleChat path, so
-- without this column the Nyo history panel lists planner threads and can reopen
-- one under Nyo's persona — the exact mixing the separate planner-chat store
-- exists to prevent. NULL = Nyo (every historical row), 'daily-planner' = the
-- planning desk.
ALTER TABLE conversations ADD COLUMN agent TEXT;

-- History is always read newest-first, per agent.
CREATE INDEX IF NOT EXISTS idx_conversations_agent_updated
  ON conversations (agent, updated_at DESC);
