-- Additive upgrade: previously committed notices remain pending and recoverable.
ALTER TABLE leaderboard_ingestion.outbox
  ADD COLUMN state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','done','quarantined')),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN reason_code text,
  ADD COLUMN operation jsonb,
  ADD COLUMN observation_cutoff timestamptz,
  ADD COLUMN source_generations jsonb,
  ADD COLUMN collection_revision integer NOT NULL DEFAULT 0 CHECK (collection_revision >= 0),
  ADD COLUMN completion jsonb,
  ADD CONSTRAINT outbox_lease CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL));
CREATE INDEX outbox_dispatch_claim ON leaderboard_ingestion.outbox (available_at,id) WHERE state IN ('pending','leased');
CREATE TABLE leaderboard_ingestion.outbox_attempts (
  lease_token uuid PRIMARY KEY,
  event_key text NOT NULL REFERENCES leaderboard_ingestion.outbox(event_key),
  attempt integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('leased','expired','done','retry','quarantined')),
  reason_code text
);
CREATE TABLE leaderboard_ingestion.outbox_replays (
  receipt_id text PRIMARY KEY,
  event_key text NOT NULL REFERENCES leaderboard_ingestion.outbox(event_key),
  prior_attempts integer NOT NULL,
  prior_reason_code text,
  replayed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
