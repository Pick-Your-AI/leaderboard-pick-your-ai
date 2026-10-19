-- Optional pipeline-owned lifecycle. Apply after the pipeline schema and
-- ingestion 005; it does not modify ingestion 005/006/007 or their authority.
CREATE TABLE leaderboard_pipeline.derived_retirements (
  operation_id text PRIMARY KEY REFERENCES leaderboard_ingestion.repository_retirements(operation_id),
  repository_id bigint NOT NULL UNIQUE,
  authority_hash text NOT NULL CHECK (authority_hash ~ '^[a-f0-9]{64}$'),
  source_generation bigint NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement
CREATE TABLE leaderboard_pipeline.derived_retirement_snapshots (
  snapshot_id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES leaderboard_pipeline.derived_retirements(operation_id),
  scope_key text NOT NULL,
  revision bigint NOT NULL,
  repository_ids jsonb NOT NULL,
  document_hash text NOT NULL,
  frozen_hash text NOT NULL,
  input_hash text NOT NULL,
  engine_scope_hash text NOT NULL,
  capture_hash text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement
CREATE TABLE leaderboard_pipeline.derived_retirement_manifests (
  operation_id text NOT NULL REFERENCES leaderboard_pipeline.derived_retirements(operation_id),
  batch_id text NOT NULL CHECK (batch_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  batch_limit integer NOT NULL CHECK (batch_limit BETWEEN 1 AND 100),
  document jsonb NOT NULL,
  document_hash text NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id,batch_id)
);
-- statement
CREATE TABLE leaderboard_pipeline.derived_retirement_receipts (
  operation_id text NOT NULL,
  batch_id text NOT NULL,
  document jsonb NOT NULL,
  document_hash text NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id,batch_id),
  FOREIGN KEY (operation_id,batch_id)
    REFERENCES leaderboard_pipeline.derived_retirement_manifests(operation_id,batch_id)
);
-- statement
CREATE INDEX derived_retirement_snapshot_operation
  ON leaderboard_pipeline.derived_retirement_snapshots(operation_id,snapshot_id);
-- Keep exact source authority until its final normalization has been removed.
-- Existing orphan rows make this optional migration fail atomically; there is
-- no guessed repository assignment or unvalidated NOT VALID exception.
-- statement
ALTER TABLE leaderboard_pipeline.normalizations ADD CONSTRAINT derived_normalization_source
  FOREIGN KEY(fact_key) REFERENCES leaderboard_ingestion.source_facts(fact_key);

-- statement
CREATE FUNCTION leaderboard_pipeline.reject_derived_retirement_change()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'immutable_pipeline_retirement_record';
END;
$$;
-- statement
CREATE TRIGGER immutable_derived_retirement BEFORE UPDATE OR DELETE
  ON leaderboard_pipeline.derived_retirements FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.reject_derived_retirement_change();
-- statement
CREATE TRIGGER immutable_derived_snapshot BEFORE UPDATE OR DELETE
  ON leaderboard_pipeline.derived_retirement_snapshots FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.reject_derived_retirement_change();
-- statement
CREATE TRIGGER immutable_derived_manifest BEFORE UPDATE OR DELETE
  ON leaderboard_pipeline.derived_retirement_manifests FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.reject_derived_retirement_change();
-- statement
CREATE TRIGGER immutable_derived_receipt BEFORE UPDATE OR DELETE
  ON leaderboard_pipeline.derived_retirement_receipts FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.reject_derived_retirement_change();

-- Share ingestion's permanent repository lock. Work that predates retirement
-- can commit before its fence; a later derived insert cannot resurrect payloads.
-- statement
CREATE FUNCTION leaderboard_pipeline.require_unretired_sources(ids jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE source_id bigint; element jsonb;
BEGIN
  IF ids IS NULL OR jsonb_typeof(ids)<>'array' OR jsonb_array_length(ids)=0
    OR jsonb_array_length(ids)>10000 THEN RAISE EXCEPTION 'derived_source_binding_invalid'; END IF;
  FOR element IN SELECT value FROM jsonb_array_elements(ids) ORDER BY value LOOP
    IF jsonb_typeof(element)<>'number' OR element::text !~ '^[1-9][0-9]{0,15}$'
      OR (element::text)::numeric>9007199254740991 THEN
      RAISE EXCEPTION 'derived_source_binding_invalid';
    END IF;
    source_id=(element::text)::bigint;
    PERFORM repository_id FROM leaderboard_ingestion.repository_access
      WHERE repository_id=source_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'derived_source_binding_invalid'; END IF;
    IF EXISTS (SELECT 1 FROM leaderboard_ingestion.repository_retirements WHERE repository_id=source_id) THEN
      RAISE EXCEPTION 'pipeline_repository_retired';
    END IF;
  END LOOP;
END;
$$;
-- statement
CREATE FUNCTION leaderboard_pipeline.guard_derived_fact_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE source_id bigint;
BEGIN
  SELECT repository_id INTO source_id FROM leaderboard_ingestion.source_facts WHERE fact_key=NEW.fact_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'derived_fact_binding_missing'; END IF;
  PERFORM leaderboard_pipeline.require_unretired_sources(jsonb_build_array(source_id));
  RETURN NEW;
END;
$$;
-- statement
CREATE TRIGGER retired_normalization_write BEFORE INSERT OR UPDATE
  ON leaderboard_pipeline.normalizations FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.guard_derived_fact_write();
-- statement
CREATE TRIGGER retired_source_mode_write BEFORE INSERT OR UPDATE
  ON leaderboard_pipeline.source_modes FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.guard_derived_fact_write();
-- statement
CREATE TRIGGER retired_source_artifact_write BEFORE INSERT OR UPDATE
  ON leaderboard_pipeline.source_artifacts FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.guard_derived_fact_write();

-- statement
CREATE FUNCTION leaderboard_pipeline.guard_derived_snapshot_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE target_id text; ids jsonb;
BEGIN
  IF TG_TABLE_NAME='snapshots' THEN
    target_id=NEW.snapshot_id; ids=NEW.repository_ids;
  ELSE
    IF TG_TABLE_NAME='policy_comparisons' THEN target_id=NEW.document->>'snapshotId';
    ELSE target_id=NEW.snapshot_id; END IF;
    SELECT repository_ids INTO ids FROM leaderboard_pipeline.snapshots WHERE snapshot_id=target_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'derived_snapshot_binding_missing'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM leaderboard_pipeline.derived_retirement_snapshots WHERE snapshot_id=target_id) THEN
    RAISE EXCEPTION 'pipeline_snapshot_retired';
  END IF;
  PERFORM leaderboard_pipeline.require_unretired_sources(ids);
  RETURN NEW;
END;
$$;
-- statement
CREATE TRIGGER retired_snapshot_write BEFORE INSERT OR UPDATE
  ON leaderboard_pipeline.snapshots FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.guard_derived_snapshot_write();
-- statement
CREATE TRIGGER retired_frozen_input_write BEFORE INSERT OR UPDATE
  ON leaderboard_pipeline.frozen_inputs FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.guard_derived_snapshot_write();
-- statement
CREATE TRIGGER retired_head_write BEFORE INSERT OR UPDATE
  ON leaderboard_pipeline.heads FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.guard_derived_snapshot_write();
-- statement
CREATE TRIGGER retired_dispatch_publication_write BEFORE INSERT OR UPDATE
  ON leaderboard_pipeline.dispatch_publications FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.guard_derived_snapshot_write();
-- statement
CREATE TRIGGER retired_policy_comparison_write BEFORE INSERT OR UPDATE
  ON leaderboard_pipeline.policy_comparisons FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.guard_derived_snapshot_write();

-- statement
CREATE FUNCTION leaderboard_pipeline.guard_derived_correction_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM leaderboard_pipeline.require_unretired_sources(jsonb_build_array(NEW.repository_id));
  RETURN NEW;
END;
$$;
-- statement
CREATE TRIGGER retired_correction_write BEFORE INSERT OR UPDATE
  ON leaderboard_pipeline.corrections FOR EACH ROW
  EXECUTE FUNCTION leaderboard_pipeline.guard_derived_correction_write();
