-- Historical pipeline DDL from accepted a17ee101826973c62ed5a69f05367927e13760a6.
-- Test-only compatibility fixture. All rows seeded by its consumers are SYNTHETIC.
CREATE SCHEMA IF NOT EXISTS leaderboard_pipeline;
CREATE TABLE IF NOT EXISTS leaderboard_pipeline.source_modes (fact_key text PRIMARY KEY REFERENCES leaderboard_ingestion.source_facts(fact_key), data_mode text NOT NULL CHECK(data_mode IN ('public','synthetic')));
CREATE TABLE IF NOT EXISTS leaderboard_pipeline.normalizations (
    fact_key text NOT NULL, policy_signature text NOT NULL, document jsonb NOT NULL,
    document_hash text NOT NULL, PRIMARY KEY (fact_key, policy_signature));
CREATE TABLE IF NOT EXISTS leaderboard_pipeline.source_artifacts (
    fact_key text NOT NULL REFERENCES leaderboard_ingestion.source_facts(fact_key),
    artifact_id text NOT NULL, PRIMARY KEY (fact_key, artifact_id));
CREATE TABLE IF NOT EXISTS leaderboard_pipeline.receipts (
    receipt_id text PRIMARY KEY, operation_key text UNIQUE NOT NULL, kind text NOT NULL,
    document jsonb NOT NULL, document_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS leaderboard_pipeline.corrections (
    request_id text PRIMARY KEY, fact_id text NOT NULL, artifact_id text NOT NULL,
    repository_id bigint NOT NULL, document jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS leaderboard_pipeline.snapshots (
    snapshot_id text PRIMARY KEY, scope_key text NOT NULL, revision bigint NOT NULL,
    config_version text NOT NULL, repository_ids jsonb NOT NULL,
    document jsonb NOT NULL, document_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS leaderboard_pipeline.dispatch_publications (
    operation_key text NOT NULL, scope_key text NOT NULL,
    snapshot_id text NOT NULL REFERENCES leaderboard_pipeline.snapshots(snapshot_id),
    PRIMARY KEY(operation_key,scope_key));
CREATE TABLE IF NOT EXISTS leaderboard_pipeline.frozen_inputs (snapshot_id text PRIMARY KEY REFERENCES leaderboard_pipeline.snapshots(snapshot_id), document jsonb NOT NULL, document_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS leaderboard_pipeline.policy_comparisons (comparison_id text PRIMARY KEY, document jsonb NOT NULL, document_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS leaderboard_pipeline.heads (
    scope_key text PRIMARY KEY, snapshot_id text NOT NULL REFERENCES leaderboard_pipeline.snapshots(snapshot_id), revision bigint NOT NULL);
