-- How many texts an embedding call embedded. The provider's daily quota counts
-- texts, not calls, so `pnpm embed --remaining` adds these up (D-051).
-- Null for calls that are not embeddings, and for rows from before this column.
ALTER TABLE llm_calls ADD COLUMN items integer;
