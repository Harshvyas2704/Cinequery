-- Fills in `items` for embedding calls logged before the column existed, so
-- that the quota count is right for the day the column was added.
-- Every batch until then held exactly 20 movies (49 batches, 980 movies), and
-- every request embedding is one text. On a new database this changes nothing.
UPDATE llm_calls SET items = 20
WHERE items IS NULL AND stage = 'embed_batch' AND status = 'ok';

UPDATE llm_calls SET items = 1
WHERE items IS NULL AND stage = 'embed_query' AND status = 'ok';
