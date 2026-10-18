-- Permanent repository retirement is distinct from reversible source visibility.
-- Apply explicitly after 004. This is not a retention schedule or a cross-store purge.
CREATE TABLE leaderboard_ingestion.repository_retirements (
  operation_id text PRIMARY KEY CHECK (operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  repository_id bigint NOT NULL UNIQUE REFERENCES leaderboard_ingestion.repository_access(repository_id),
  expected_generation bigint NOT NULL CHECK (expected_generation > 0),
  source_generation bigint NOT NULL CHECK (source_generation > expected_generation),
  policy_version text NOT NULL CHECK (policy_version ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  authorization_receipt text NOT NULL CHECK (authorization_receipt ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  operator_id text NOT NULL CHECK (operator_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  retired_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION leaderboard_ingestion.reject_retirement_change() RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'immutable_repository_retirement';
END;
$$;
CREATE TRIGGER immutable_repository_retirement BEFORE UPDATE OR DELETE
  ON leaderboard_ingestion.repository_retirements FOR EACH ROW
  EXECUTE FUNCTION leaderboard_ingestion.reject_retirement_change();

CREATE FUNCTION leaderboard_ingestion.guard_retired_access() RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM leaderboard_ingestion.repository_retirements WHERE repository_id=OLD.repository_id) THEN
      RAISE EXCEPTION 'repository_retired';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.state='public' AND EXISTS (
    SELECT 1 FROM leaderboard_ingestion.repository_retirements WHERE repository_id=NEW.repository_id
  ) THEN
    RAISE EXCEPTION 'repository_retired';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retired_repository_access BEFORE INSERT OR UPDATE OR DELETE
  ON leaderboard_ingestion.repository_access FOR EACH ROW
  EXECUTE FUNCTION leaderboard_ingestion.guard_retired_access();

-- Share the existing repository row lock with readers, collectors and retirement.
-- A write already underway finishes before the fence; a later write is rejected.
CREATE FUNCTION leaderboard_ingestion.guard_retired_payload() RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE scope_id bigint;
BEGIN
  IF TG_TABLE_NAME='inbox' THEN scope_id=(NEW.envelope->>'repositoryId')::bigint;
  ELSIF TG_TABLE_NAME='observations' THEN scope_id=(NEW.observation->>'repositoryId')::bigint;
  ELSE scope_id=NEW.repository_id;
  END IF;
  PERFORM repository_id FROM leaderboard_ingestion.repository_access WHERE repository_id=scope_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM leaderboard_ingestion.repository_retirements WHERE repository_id=scope_id) THEN
    RAISE EXCEPTION 'repository_retired';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retired_collection_run BEFORE INSERT OR UPDATE OF repository_id
  ON leaderboard_ingestion.collection_runs FOR EACH ROW
  EXECUTE FUNCTION leaderboard_ingestion.guard_retired_payload();
CREATE TRIGGER retired_source_fact BEFORE INSERT ON leaderboard_ingestion.source_facts
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.guard_retired_payload();
CREATE TRIGGER retired_delivery_payload BEFORE INSERT OR UPDATE OF envelope ON leaderboard_ingestion.inbox
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.guard_retired_payload();
CREATE TRIGGER retired_observation_payload BEFORE INSERT OR UPDATE OF observation ON leaderboard_ingestion.observations
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.guard_retired_payload();

CREATE TABLE leaderboard_ingestion.collection_erasure_batches (
  operation_id text NOT NULL REFERENCES leaderboard_ingestion.repository_retirements(operation_id),
  batch_id text NOT NULL CHECK (batch_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  batch_limit integer NOT NULL CHECK (batch_limit BETWEEN 1 AND 100),
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('erasing','erased','blocked')),
  deleted_count integer NOT NULL DEFAULT 0 CHECK (deleted_count BETWEEN 0 AND batch_limit),
  source_facts_remaining boolean NOT NULL DEFAULT true,
  completed_at timestamptz,
  active_transaction bigint,
  active_fact_keys text[],
  PRIMARY KEY (operation_id,batch_id),
  CHECK ((status='erasing') = (active_transaction IS NOT NULL AND active_fact_keys IS NOT NULL)),
  CHECK ((status='erasing') = (completed_at IS NULL))
);

-- The deletion exception exists only for the exact bounded keys selected by the
-- erasure function in this transaction. Completed/blocked receipts grant no write.
CREATE INDEX source_facts_retirement_scope ON leaderboard_ingestion.source_facts(repository_id,fact_key);
CREATE INDEX collection_items_erasure_fact ON leaderboard_ingestion.collection_items(fact_key);
CREATE INDEX unfinished_erasure_receipts ON leaderboard_ingestion.collection_erasure_batches(operation_id)
  WHERE status<>'erased';
CREATE INDEX completed_source_erasure ON leaderboard_ingestion.collection_erasure_batches(operation_id)
  WHERE status='erased' AND NOT source_facts_remaining;
CREATE FUNCTION leaderboard_ingestion.guard_erasure_receipt() RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  -- Only the trusted table owner may create or advance the temporary exception.
  -- The erasure function runs as that owner; direct grants to another role do
  -- not authorize forging an active receipt in an arbitrary transaction.
  IF current_user<>(SELECT pg_catalog.pg_get_userbyid(relowner)
    FROM pg_catalog.pg_class WHERE oid=TG_RELID) THEN
    RAISE EXCEPTION 'erasure_receipt_write_forbidden';
  END IF;
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' OR OLD.status='erased' THEN RAISE EXCEPTION 'immutable_erasure_receipt'; END IF;
  IF NEW.operation_id<>OLD.operation_id OR NEW.batch_id<>OLD.batch_id OR NEW.batch_limit<>OLD.batch_limit THEN
    RAISE EXCEPTION 'erasure_batch_conflict';
  END IF;
  IF OLD.status='blocked' THEN
    IF NEW.status<>'erasing' OR NEW.attempt<>OLD.attempt+1 OR NEW.active_transaction<>txid_current() THEN
      RAISE EXCEPTION 'invalid_erasure_retry';
    END IF;
  ELSIF OLD.active_transaction<>txid_current() OR NEW.status NOT IN ('erased','blocked') OR NEW.attempt<>OLD.attempt THEN
    RAISE EXCEPTION 'invalid_erasure_completion';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retained_erasure_receipt BEFORE INSERT OR UPDATE OR DELETE
  ON leaderboard_ingestion.collection_erasure_batches FOR EACH ROW
  EXECUTE FUNCTION leaderboard_ingestion.guard_erasure_receipt();

CREATE OR REPLACE FUNCTION leaderboard_ingestion.reject_source_fact_change() RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' AND EXISTS (
    SELECT 1 FROM leaderboard_ingestion.collection_erasure_batches AS batch
    JOIN leaderboard_ingestion.repository_retirements AS retirement USING(operation_id)
    WHERE retirement.repository_id=OLD.repository_id AND batch.status='erasing'
      AND batch.active_transaction=txid_current() AND OLD.fact_key=ANY(batch.active_fact_keys)
  ) THEN RETURN OLD;
  END IF;
  RAISE EXCEPTION 'immutable_source_fact';
END;
$$;

CREATE FUNCTION leaderboard_ingestion.erase_collected_source_batch(
  p_operation_id text, p_batch_id text, p_limit integer
) RETURNS SETOF leaderboard_ingestion.collection_erasure_batches LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  retirement leaderboard_ingestion.repository_retirements%ROWTYPE;
  prior leaderboard_ingestion.collection_erasure_batches%ROWTYPE;
  keys text[];
  removed integer := 0;
  blocked boolean := false;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 OR p_batch_id IS NULL
    OR p_batch_id !~ '^[A-Za-z0-9_.:-]{1,128}$' THEN RAISE EXCEPTION 'invalid_erasure_batch'; END IF;
  SELECT * INTO retirement FROM leaderboard_ingestion.repository_retirements WHERE operation_id=p_operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_repository_retirement'; END IF;
  -- Lock ordering matches ordinary collection: repository, then its dependent rows.
  PERFORM repository_id FROM leaderboard_ingestion.repository_access
    WHERE repository_id=retirement.repository_id AND state<>'public' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'retirement_fence_unavailable'; END IF;
  SELECT * INTO prior FROM leaderboard_ingestion.collection_erasure_batches
    WHERE operation_id=p_operation_id AND batch_id=p_batch_id FOR UPDATE;
  IF FOUND THEN
    IF prior.batch_limit<>p_limit THEN RAISE EXCEPTION 'erasure_batch_conflict'; END IF;
    IF prior.status='erased' THEN RETURN NEXT prior; RETURN; END IF;
    IF prior.status<>'blocked' THEN RAISE EXCEPTION 'erasure_batch_incomplete'; END IF;
  ELSIF (SELECT count(*) FROM leaderboard_ingestion.collection_erasure_batches
    WHERE operation_id=p_operation_id AND status<>'erased')>=10000 THEN
    RAISE EXCEPTION 'erasure_receipt_limit_exceeded';
  END IF;
  SELECT COALESCE(array_agg(fact_key),ARRAY[]::text[]) INTO keys FROM (
    SELECT fact_key FROM leaderboard_ingestion.source_facts WHERE repository_id=retirement.repository_id
    ORDER BY fact_key LIMIT p_limit FOR UPDATE
  ) AS selected;
  -- Completed audit history cannot cap how much retained source can be erased.
  -- Once the empty scope has a receipt, new IDs must not grow empty audit rows.
  -- An existing blocked batch can still finish, and exact successful retries
  -- already returned their original receipt above.
  IF cardinality(keys)=0 AND prior.batch_id IS NULL AND EXISTS (
    SELECT 1 FROM leaderboard_ingestion.collection_erasure_batches
    WHERE operation_id=p_operation_id AND status='erased' AND NOT source_facts_remaining
  ) THEN RAISE EXCEPTION 'source_scope_already_erased'; END IF;
  INSERT INTO leaderboard_ingestion.collection_erasure_batches
    (operation_id,batch_id,batch_limit,attempt,status,active_transaction,active_fact_keys)
  VALUES(p_operation_id,p_batch_id,p_limit,1,'erasing',txid_current(),keys)
  ON CONFLICT(operation_id,batch_id) DO UPDATE SET attempt=collection_erasure_batches.attempt+1,
    status='erasing',completed_at=NULL,active_transaction=txid_current(),active_fact_keys=keys;
  BEGIN
    -- A corrupt cross-repository reference is not authority to delete another scope.
    IF EXISTS (
      SELECT 1 FROM leaderboard_ingestion.collection_items AS item
      JOIN leaderboard_ingestion.collection_runs AS run USING(run_id)
      WHERE item.fact_key=ANY(keys) AND run.repository_id<>retirement.repository_id
    ) THEN RAISE foreign_key_violation; END IF;
    DELETE FROM leaderboard_ingestion.enrichment_jobs WHERE fact_key=ANY(keys);
    DELETE FROM leaderboard_ingestion.collection_items WHERE fact_key=ANY(keys);
    DELETE FROM leaderboard_ingestion.source_facts WHERE repository_id=retirement.repository_id AND fact_key=ANY(keys);
    GET DIAGNOSTICS removed = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    -- PostgreSQL rolls this entire nested block back. Keep the permanent fence
    -- and a retryable receipt; never cascade into an unreviewed projection store.
    removed := 0;
    blocked := true;
  END;
  UPDATE leaderboard_ingestion.collection_erasure_batches SET
    status=CASE WHEN blocked THEN 'blocked' ELSE 'erased' END, deleted_count=removed,
    source_facts_remaining=EXISTS (
      SELECT 1 FROM leaderboard_ingestion.source_facts WHERE repository_id=retirement.repository_id
    ), completed_at=clock_timestamp(),active_transaction=NULL,active_fact_keys=NULL
  WHERE operation_id=p_operation_id AND batch_id=p_batch_id;
  RETURN QUERY SELECT * FROM leaderboard_ingestion.collection_erasure_batches
    WHERE operation_id=p_operation_id AND batch_id=p_batch_id;
END;
$$;
REVOKE ALL ON FUNCTION leaderboard_ingestion.erase_collected_source_batch(text,text,integer) FROM PUBLIC;
REVOKE ALL ON leaderboard_ingestion.collection_erasure_batches FROM PUBLIC;
