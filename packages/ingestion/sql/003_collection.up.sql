-- Collection facts are separate from delivery observations and recognition decisions.
ALTER TABLE leaderboard_ingestion.replay_receipts ADD COLUMN audit jsonb;
CREATE TABLE leaderboard_ingestion.object_suppressions (
  repository_id bigint NOT NULL,
  subject_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('deleted','unavailable')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (repository_id, subject_id)
);
CREATE TABLE leaderboard_ingestion.repository_access (
  repository_id bigint PRIMARY KEY CHECK (repository_id > 0),
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  state text NOT NULL CHECK (state IN ('public', 'unavailable', 'excluded', 'onboarding')),
  generation bigint NOT NULL DEFAULT 1,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE leaderboard_ingestion.lifecycle_receipts (
  delivery_id text PRIMARY KEY,
  body_hash text NOT NULL,
  installation_id bigint NOT NULL,
  repository_ids jsonb NOT NULL,
  reason text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE leaderboard_ingestion.collection_runs (
  run_id text PRIMARY KEY,
  repository_id bigint NOT NULL REFERENCES leaderboard_ingestion.repository_access(repository_id),
  family text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('backfill', 'reconcile', 'audit')),
  since_at timestamptz,
  until_at timestamptz NOT NULL,
  cursor text,
  page_count integer NOT NULL DEFAULT 0,
  item_count integer NOT NULL DEFAULT 0,
  expected_count integer,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete', 'failed')),
  reason text,
  last_success_at timestamptz,
  attempted_at timestamptz,
  access_generation bigint NOT NULL,
  UNIQUE (repository_id, family, run_id)
);
CREATE TABLE leaderboard_ingestion.source_facts (
  fact_key text PRIMARY KEY,
  repository_id bigint NOT NULL,
  family text NOT NULL,
  subject_id text NOT NULL,
  source_revision text NOT NULL,
  document jsonb NOT NULL,
  first_run_id text NOT NULL REFERENCES leaderboard_ingestion.collection_runs(run_id),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE leaderboard_ingestion.collection_pages (
  run_id text NOT NULL REFERENCES leaderboard_ingestion.collection_runs(run_id),
  page_number integer NOT NULL,
  item_count integer NOT NULL,
  changed_count integer NOT NULL,
  cursor_hash text NOT NULL,
  UNIQUE (run_id, cursor_hash),
  PRIMARY KEY (run_id, page_number)
);
CREATE TABLE leaderboard_ingestion.collection_items (
  run_id text NOT NULL REFERENCES leaderboard_ingestion.collection_runs(run_id),
  fact_key text NOT NULL REFERENCES leaderboard_ingestion.source_facts(fact_key),
  PRIMARY KEY (run_id, fact_key)
);
CREATE FUNCTION leaderboard_ingestion.reject_source_fact_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_source_fact';
END;
$$;
CREATE TRIGGER immutable_source_fact BEFORE UPDATE OR DELETE ON leaderboard_ingestion.source_facts
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.reject_source_fact_change();
CREATE TABLE leaderboard_ingestion.enrichment_jobs (
  fact_key text NOT NULL REFERENCES leaderboard_ingestion.source_facts(fact_key),
  policy_version text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','classified','excluded','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  reason text,
  metadata jsonb,
  access_generation bigint,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (fact_key, policy_version),
  CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
