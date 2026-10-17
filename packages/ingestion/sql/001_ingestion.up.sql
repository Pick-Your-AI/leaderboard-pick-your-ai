CREATE SCHEMA IF NOT EXISTS leaderboard_ingestion;

CREATE TABLE leaderboard_ingestion.inbox (
  delivery_id uuid PRIMARY KEY,
  body_hash text NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  envelope jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'done', 'quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  reason_code text,
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX inbox_claim ON leaderboard_ingestion.inbox (available_at, received_at) WHERE state IN ('pending', 'leased');

CREATE TABLE leaderboard_ingestion.attempt_history (
  lease_token uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES leaderboard_ingestion.inbox(delivery_id),
  attempt integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('leased', 'expired', 'done', 'retry', 'quarantined')),
  reason_code text
);

CREATE TABLE leaderboard_ingestion.replay_receipts (
  receipt_id text PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES leaderboard_ingestion.inbox(delivery_id),
  prior_attempts integer NOT NULL,
  prior_reason_code text,
  replayed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE leaderboard_ingestion.observations (
  event_key text PRIMARY KEY,
  delivery_id uuid NOT NULL UNIQUE REFERENCES leaderboard_ingestion.inbox(delivery_id),
  normalization_version text NOT NULL,
  observation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE leaderboard_ingestion.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE REFERENCES leaderboard_ingestion.observations(event_key),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
