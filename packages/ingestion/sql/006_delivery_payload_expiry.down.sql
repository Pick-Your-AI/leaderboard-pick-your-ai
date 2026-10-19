-- Expiry operation receipts are irreversible, including zero-row batches.
-- A migration cannot recreate removed evidence or discard an immutable retry result.
DO $$
BEGIN
  -- Table locks cannot refresh a pre-expiry repeatable-read/serializable snapshot.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'delivery_expiry_requires_read_committed';
  END IF;
  -- Keep the absence check and every DDL change in one command/transaction.
  -- An expiry already underway commits first; later expiry cannot pass this gate.
  LOCK TABLE leaderboard_ingestion.delivery_payload_expiry_operations,
    leaderboard_ingestion.delivery_payload_expiries IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM leaderboard_ingestion.delivery_payload_expiry_operations)
      OR EXISTS (SELECT 1 FROM leaderboard_ingestion.delivery_payload_expiries) THEN
    RAISE EXCEPTION 'delivery_payload_expiry_irreversible';
  END IF;
DROP INDEX leaderboard_ingestion.inbox_payload_expiry_scope;
DROP INDEX leaderboard_ingestion.inbox_payload_expiry_completion;
DROP INDEX leaderboard_ingestion.outbox_payload_expiry_completion;
DROP TRIGGER guard_inbox_payload_expiry ON leaderboard_ingestion.inbox;
DROP TRIGGER guard_observation_payload_expiry ON leaderboard_ingestion.observations;
DROP FUNCTION leaderboard_ingestion.guard_expired_delivery_payload();
DROP TRIGGER guard_expired_delivery_dispatch ON leaderboard_ingestion.outbox;
DROP FUNCTION leaderboard_ingestion.guard_expired_delivery_dispatch();
DROP TABLE leaderboard_ingestion.delivery_payload_expiries;
DROP TABLE leaderboard_ingestion.delivery_payload_expiry_operations;
DROP FUNCTION leaderboard_ingestion.validate_delivery_payload_expiry();
DROP FUNCTION leaderboard_ingestion.check_delivery_expiry_commit();
DROP FUNCTION leaderboard_ingestion.delivery_expiry_completion_valid(jsonb,jsonb);
DROP FUNCTION leaderboard_ingestion.reject_delivery_expiry_receipt_change();
ALTER TABLE leaderboard_ingestion.inbox ALTER COLUMN envelope SET NOT NULL;
ALTER TABLE leaderboard_ingestion.observations ALTER COLUMN observation SET NOT NULL;
END;
$$;
