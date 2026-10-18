-- Keep the check and every DDL operation in one statement/transaction, including
-- when a migration runner submits this statement without an explicit BEGIN.
DO $rollback$
BEGIN
  -- A prior repeatable-read/serializable snapshot can hide a committed retirement
  -- even after acquiring locks. Only a fresh READ COMMITTED view is supported.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'retirement_rollback_requires_read_committed';
  END IF;

  -- Repository first matches retirement's write order. Take every DDL table lock
  -- before the emptiness check; NOWAIT also avoids cycles with an eraser/payload
  -- writer that already holds a dependent-table lock before requesting this row.
  -- Active traffic rejects rollback rather than creating a check-to-DROP window.
  LOCK TABLE leaderboard_ingestion.repository_access,
    leaderboard_ingestion.repository_retirements,
    leaderboard_ingestion.collection_erasure_batches,
    leaderboard_ingestion.source_facts,
    leaderboard_ingestion.collection_items,
    leaderboard_ingestion.observations,
    leaderboard_ingestion.inbox,
    leaderboard_ingestion.collection_runs
    IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF EXISTS (SELECT 1 FROM leaderboard_ingestion.repository_retirements)
    OR EXISTS (SELECT 1 FROM leaderboard_ingestion.collection_erasure_batches) THEN
    RAISE EXCEPTION 'retirement_history_prevents_rollback';
  END IF;
  DROP FUNCTION leaderboard_ingestion.erase_collected_source_batch(text,text,integer);
  CREATE OR REPLACE FUNCTION leaderboard_ingestion.reject_source_fact_change() RETURNS trigger LANGUAGE plpgsql AS $guard$
  BEGIN
    RAISE EXCEPTION 'immutable_source_fact';
  END;
  $guard$;
  DROP TABLE leaderboard_ingestion.collection_erasure_batches;
  DROP FUNCTION leaderboard_ingestion.guard_erasure_receipt();
  DROP INDEX leaderboard_ingestion.source_facts_retirement_scope;
  DROP INDEX leaderboard_ingestion.collection_items_erasure_fact;
  DROP TRIGGER retired_observation_payload ON leaderboard_ingestion.observations;
  DROP TRIGGER retired_delivery_payload ON leaderboard_ingestion.inbox;
  DROP TRIGGER retired_source_fact ON leaderboard_ingestion.source_facts;
  DROP TRIGGER retired_collection_run ON leaderboard_ingestion.collection_runs;
  DROP FUNCTION leaderboard_ingestion.guard_retired_payload();
  DROP TRIGGER retired_repository_access ON leaderboard_ingestion.repository_access;
  DROP FUNCTION leaderboard_ingestion.guard_retired_access();
  DROP TABLE leaderboard_ingestion.repository_retirements;
  DROP FUNCTION leaderboard_ingestion.reject_retirement_change();
END;
$rollback$;
