CREATE TABLE leaderboard_ingestion.snapshots (
  snapshot_id text PRIMARY KEY CHECK (snapshot_id ~ '^[a-f0-9]{64}$'),
  scope_key text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (scope_key, snapshot_id)
);

CREATE FUNCTION leaderboard_ingestion.reject_snapshot_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_snapshot';
END;
$$;
CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON leaderboard_ingestion.snapshots
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.reject_snapshot_change();

CREATE TABLE leaderboard_ingestion.snapshot_heads (
  scope_key text PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision > 0),
  snapshot_id text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (scope_key, snapshot_id) REFERENCES leaderboard_ingestion.snapshots(scope_key, snapshot_id)
);

CREATE TABLE leaderboard_ingestion.snapshot_notices (
  scope_key text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  snapshot_id text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope_key, revision),
  FOREIGN KEY (scope_key, snapshot_id) REFERENCES leaderboard_ingestion.snapshots(scope_key, snapshot_id)
);
