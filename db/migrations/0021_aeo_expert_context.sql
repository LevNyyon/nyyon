-- AEO expert context: stores the operator interview Q&A before article is written.
-- expert_context_json: JSON array of { q, a } pairs collected by Nyo.
-- interview_status: null | 'pending' (questions sent, awaiting answers) | 'ready' (answers received, ok to write).
ALTER TABLE aeo_questions ADD COLUMN expert_context_json TEXT;
ALTER TABLE aeo_questions ADD COLUMN interview_status    TEXT;
