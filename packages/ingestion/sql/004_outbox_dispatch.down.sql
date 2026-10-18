-- Disposable validation only: this removes dispatch diagnostics, not delivery observations.
DROP TABLE leaderboard_ingestion.outbox_replays;
DROP TABLE leaderboard_ingestion.outbox_attempts;
DROP INDEX leaderboard_ingestion.outbox_dispatch_claim;
ALTER TABLE leaderboard_ingestion.outbox
  DROP CONSTRAINT outbox_lease,
  DROP COLUMN completion, DROP COLUMN collection_revision, DROP COLUMN source_generations, DROP COLUMN observation_cutoff, DROP COLUMN operation,
  DROP COLUMN reason_code, DROP COLUMN lease_until, DROP COLUMN lease_token,
  DROP COLUMN available_at, DROP COLUMN attempts, DROP COLUMN state;
