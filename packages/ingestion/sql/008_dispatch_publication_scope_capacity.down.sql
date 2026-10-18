-- Restoring the legacy recognizer must not strand a retained long-scope result.
-- Refuse active outbox reads or completion, including a lease holder still
-- awaiting confirmation. Keep every receipt and payload unchanged.
DO $migration$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'publication_scope_capacity_requires_read_committed';
  END IF;
  LOCK TABLE leaderboard_ingestion.outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF EXISTS (
    SELECT 1 FROM leaderboard_ingestion.outbox AS notice,
      LATERAL jsonb_array_elements(CASE
        WHEN jsonb_typeof(notice.completion->'publications') = 'array'
        THEN notice.completion->'publications' ELSE '[]'::jsonb END) AS publication
    WHERE jsonb_typeof(publication->'scopeKey') = 'string'
      AND length(publication->>'scopeKey') > 2000
  ) THEN
    RAISE EXCEPTION 'publication_scope_capacity_in_use';
  END IF;
CREATE OR REPLACE FUNCTION leaderboard_ingestion.delivery_expiry_completion_valid(operation jsonb, completion jsonb)
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(operation->'operationKey') = 'string'
    AND operation->>'operationKey' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(completion->'operationKey') = 'string'
    AND completion->>'operationKey' = operation->>'operationKey'
    AND jsonb_typeof(completion->'publications') = 'array'
    AND (SELECT count(*) BETWEEN 1 AND 100 AND bool_and(COALESCE(
      jsonb_typeof(publication) = 'object'
      AND jsonb_typeof(publication->'scopeKey') = 'string'
      AND length(publication->>'scopeKey') <= 2000
      AND jsonb_typeof(publication->'snapshotId') = 'string'
      AND publication->>'snapshotId' ~ '^[a-f0-9]{64}$'
      AND CASE WHEN jsonb_typeof(publication->'revision') = 'number' THEN
        (publication->>'revision')::numeric BETWEEN 1 AND 9007199254740991
        AND (publication->>'revision')::numeric = trunc((publication->>'revision')::numeric)
      ELSE false END, false
    )) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(completion->'publications') = 'array'
      THEN completion->'publications' ELSE '[]'::jsonb END) AS publication), false);
$$;
END;
$migration$;
