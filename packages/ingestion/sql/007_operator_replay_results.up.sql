-- Additive replay causation. Existing receipts remain unbound, never backfilled
-- from timestamps or a delivery's earlier publication.
ALTER TABLE leaderboard_ingestion.replay_receipts
  ADD CONSTRAINT replay_receipt_delivery_identity UNIQUE (receipt_id,delivery_id);
ALTER TABLE leaderboard_ingestion.attempt_history
  ADD CONSTRAINT replay_attempt_delivery_identity UNIQUE (lease_token,delivery_id);
ALTER TABLE leaderboard_ingestion.inbox
  ADD COLUMN operator_replay_receipt_id text,
  ADD CONSTRAINT inbox_operator_replay_identity
    FOREIGN KEY (operator_replay_receipt_id,delivery_id)
    REFERENCES leaderboard_ingestion.replay_receipts(receipt_id,delivery_id);

CREATE TABLE leaderboard_ingestion.replay_processing_results (
  receipt_id text PRIMARY KEY,
  delivery_id uuid NOT NULL,
  lease_token uuid NOT NULL,
  event_key text REFERENCES leaderboard_ingestion.outbox(event_key),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (receipt_id,delivery_id)
    REFERENCES leaderboard_ingestion.replay_receipts(receipt_id,delivery_id),
  FOREIGN KEY (lease_token,delivery_id)
    REFERENCES leaderboard_ingestion.attempt_history(lease_token,delivery_id),
  CHECK (event_key IS NULL OR event_key='github:delivery:' || delivery_id::text)
);
COMMENT ON COLUMN leaderboard_ingestion.replay_processing_results.event_key IS
  'Only a new outbox notice inserted by this persisted intake lease; null means no new notice was created.';
CREATE FUNCTION leaderboard_ingestion.reject_replay_processing_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_replay_processing_result';
END;
$$;
CREATE TRIGGER immutable_replay_processing_result
  BEFORE UPDATE OR DELETE ON leaderboard_ingestion.replay_processing_results
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.reject_replay_processing_change();
