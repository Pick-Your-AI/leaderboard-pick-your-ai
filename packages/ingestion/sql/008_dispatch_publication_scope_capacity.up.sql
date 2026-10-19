-- Apply after 006 without rewriting its already-applied SQL or any retained receipt.
-- Keep the completion recognizer aligned with the bounded dispatch producer and
-- replay readers: canonical 100-Project/all-role scope keys fit within 16,384.
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
      AND length(publication->>'scopeKey') <= 16384
      AND jsonb_typeof(publication->'snapshotId') = 'string'
      AND publication->>'snapshotId' ~ '^[a-f0-9]{64}$'
      AND CASE WHEN jsonb_typeof(publication->'revision') = 'number' THEN
        (publication->>'revision')::numeric BETWEEN 1 AND 9007199254740991
        AND (publication->>'revision')::numeric = trunc((publication->>'revision')::numeric)
      ELSE false END, false
    )) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(completion->'publications') = 'array'
      THEN completion->'publications' ELSE '[]'::jsonb END) AS publication), false);
$$;
