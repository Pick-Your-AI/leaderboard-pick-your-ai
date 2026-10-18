-- A disposable empty migration can roll back. A durable retirement cannot be
-- discarded by rollback and accidentally re-enable collection or stale reads.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM leaderboard_ingestion.repository_retirements) THEN
    RAISE EXCEPTION 'retirement_history_prevents_rollback';
  END IF;
END $$;
DROP FUNCTION leaderboard_ingestion.erase_collected_source_batch(text,text,integer);
CREATE OR REPLACE FUNCTION leaderboard_ingestion.reject_source_fact_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_source_fact';
END;
$$;
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
