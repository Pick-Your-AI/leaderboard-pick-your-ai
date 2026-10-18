-- Completed delivery payload expiry is independent of permanent source retirement.
-- Apply after 001-004. No duration, scheduled job or production operation is implied.
CREATE TABLE leaderboard_ingestion.delivery_payload_expiry_operations (
  operation_id text PRIMARY KEY CHECK (operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  repository_id bigint NOT NULL CHECK (repository_id BETWEEN 1 AND 9007199254740991),
  installation_id bigint NOT NULL CHECK (installation_id BETWEEN 1 AND 9007199254740991),
  completed_before timestamptz NOT NULL,
  policy_version text NOT NULL CHECK (policy_version ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  operator_id text NOT NULL CHECK (operator_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  authorization_id text NOT NULL CHECK (authorization_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  batch_limit integer NOT NULL CHECK (batch_limit BETWEEN 1 AND 100),
  expired_count integer NOT NULL CHECK (expired_count BETWEEN 0 AND batch_limit),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (completed_before <= recorded_at)
);

CREATE TABLE leaderboard_ingestion.delivery_payload_expiries (
  delivery_id uuid PRIMARY KEY REFERENCES leaderboard_ingestion.inbox(delivery_id),
  event_key text NOT NULL UNIQUE REFERENCES leaderboard_ingestion.observations(event_key),
  operation_id text NOT NULL REFERENCES leaderboard_ingestion.delivery_payload_expiry_operations(operation_id),
  repository_id bigint NOT NULL,
  installation_id bigint NOT NULL,
  subject_id text NOT NULL CHECK (subject_id ~ '^[A-Za-z0-9_=-]{1,200}$')
);
CREATE INDEX delivery_payload_expiries_scope ON leaderboard_ingestion.delivery_payload_expiries(repository_id, subject_id);
CREATE INDEX delivery_payload_expiries_operation ON leaderboard_ingestion.delivery_payload_expiries(operation_id);
CREATE INDEX inbox_payload_expiry_scope ON leaderboard_ingestion.inbox
  ((envelope->>'repositoryId'), (envelope->>'installationId'), received_at, delivery_id)
  WHERE state = 'done' AND envelope IS NOT NULL;
CREATE INDEX inbox_payload_expiry_completion ON leaderboard_ingestion.attempt_history(delivery_id, finished_at)
  WHERE outcome = 'done';
CREATE INDEX outbox_payload_expiry_completion ON leaderboard_ingestion.outbox_attempts(event_key, finished_at)
  WHERE outcome = 'done';

ALTER TABLE leaderboard_ingestion.inbox ALTER COLUMN envelope DROP NOT NULL;
ALTER TABLE leaderboard_ingestion.observations ALTER COLUMN observation DROP NOT NULL;

CREATE FUNCTION leaderboard_ingestion.reject_delivery_expiry_receipt_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_delivery_expiry_receipt';
END;
$$;
CREATE TRIGGER immutable_delivery_expiry_operation BEFORE UPDATE OR DELETE
  ON leaderboard_ingestion.delivery_payload_expiry_operations FOR EACH ROW
  EXECUTE FUNCTION leaderboard_ingestion.reject_delivery_expiry_receipt_change();
CREATE TRIGGER immutable_delivery_payload_expiry BEFORE UPDATE OR DELETE
  ON leaderboard_ingestion.delivery_payload_expiries FOR EACH ROW
  EXECUTE FUNCTION leaderboard_ingestion.reject_delivery_expiry_receipt_change();

-- Recognize the actual durable OutboxStore completion shape, not merely a
-- nonempty JSON array or a pair of equally malformed operation keys.
CREATE FUNCTION leaderboard_ingestion.delivery_expiry_completion_valid(operation jsonb, completion jsonb)
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(operation->'operationKey') = 'string'
    AND operation->>'operationKey' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(completion->'operationKey') = 'string'
    AND completion->>'operationKey' = operation->>'operationKey'
    AND jsonb_typeof(completion->'publications') = 'array'
    AND (SELECT count(*) BETWEEN 1 AND 100 AND bool_and(COALESCE(
      jsonb_typeof(publication) = 'object'
      AND jsonb_typeof(publication->'scopeKey') = 'string'
      AND length(publication->>'scopeKey') <= 2000
      AND jsonb_typeof(publication->'snapshotId') = 'string'
      AND publication->>'snapshotId' ~ '^[a-f0-9]{64}$'
      AND CASE WHEN jsonb_typeof(publication->'revision') = 'number' THEN
        (publication->>'revision')::numeric BETWEEN 1 AND 9007199254740991
        AND (publication->>'revision')::numeric = trunc((publication->>'revision')::numeric)
      ELSE false END, false
    )) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(completion->'publications') = 'array'
      THEN completion->'publications' ELSE '[]'::jsonb END) AS publication), false);
$$;

-- Receipt insertion proves the exact still-retained delivery is durably complete.
-- The ordinary inbox/observation writes never receive an unrestricted deletion switch.
CREATE FUNCTION leaderboard_ingestion.validate_delivery_payload_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operation leaderboard_ingestion.delivery_payload_expiry_operations%ROWTYPE;
  intake leaderboard_ingestion.inbox%ROWTYPE;
  notice leaderboard_ingestion.outbox%ROWTYPE;
  evidence leaderboard_ingestion.observations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT operation FROM leaderboard_ingestion.delivery_payload_expiry_operations
    WHERE operation_id = NEW.operation_id;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('leaderboard-delivery-expiry:' || operation.repository_id::text, 0)) THEN
    RAISE EXCEPTION 'delivery_expiry_scope_busy';
  END IF;
  SELECT * INTO STRICT intake FROM leaderboard_ingestion.inbox WHERE delivery_id = NEW.delivery_id FOR UPDATE;
  SELECT * INTO STRICT notice FROM leaderboard_ingestion.outbox WHERE event_key = NEW.event_key FOR UPDATE;
  SELECT * INTO STRICT evidence FROM leaderboard_ingestion.observations WHERE event_key = NEW.event_key FOR UPDATE;
  IF NEW.repository_id <> operation.repository_id OR NEW.installation_id <> operation.installation_id
    OR NEW.event_key <> 'github:delivery:' || NEW.delivery_id::text
    OR intake.state <> 'done' OR notice.state <> 'done'
    OR intake.envelope IS NULL OR evidence.observation IS NULL
    OR evidence.delivery_id <> NEW.delivery_id OR evidence.normalization_version <> 'delivery-observation/v1'
    OR intake.envelope->>'version' IS DISTINCT FROM 'github-delivery/v1'
    OR intake.envelope->>'deliveryId' IS DISTINCT FROM NEW.delivery_id::text
    OR intake.envelope->>'repositoryId' IS DISTINCT FROM NEW.repository_id::text
    OR intake.envelope->>'installationId' IS DISTINCT FROM NEW.installation_id::text
    OR intake.envelope->>'subjectId' IS DISTINCT FROM NEW.subject_id
    OR evidence.observation->>'repositoryId' IS DISTINCT FROM NEW.repository_id::text
    OR evidence.observation->>'installationId' IS DISTINCT FROM NEW.installation_id::text
    OR evidence.observation->>'subjectId' IS DISTINCT FROM NEW.subject_id
    OR evidence.observation->>'deliveryId' IS DISTINCT FROM NEW.delivery_id::text
    OR evidence.observation->>'eventKey' IS DISTINCT FROM NEW.event_key
    OR (evidence.observation - ARRAY['eventKey','observedAt','ordering','qualification']) IS DISTINCT FROM intake.envelope
    OR NOT leaderboard_ingestion.delivery_expiry_completion_valid(notice.operation, notice.completion)
    OR NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.attempt_history
      WHERE delivery_id = NEW.delivery_id AND outcome = 'done' AND finished_at < operation.completed_before)
    OR EXISTS (SELECT 1 FROM leaderboard_ingestion.attempt_history
      WHERE delivery_id = NEW.delivery_id AND outcome = 'done' AND (finished_at IS NULL OR finished_at >= operation.completed_before))
    OR NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.outbox_attempts
      WHERE event_key = NEW.event_key AND outcome = 'done' AND finished_at < operation.completed_before)
    OR EXISTS (SELECT 1 FROM leaderboard_ingestion.outbox_attempts
      WHERE event_key = NEW.event_key AND outcome = 'done' AND (finished_at IS NULL OR finished_at >= operation.completed_before)) THEN
    RAISE EXCEPTION 'delivery_payload_not_expirable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_delivery_payload_expiry BEFORE INSERT ON leaderboard_ingestion.delivery_payload_expiries
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.validate_delivery_payload_expiry();

-- Null is actual payload absence. A source-shaped placeholder is never substituted.
-- Once expired, acknowledgment identity, scope binding and terminal state stay fixed.
CREATE FUNCTION leaderboard_ingestion.guard_expired_delivery_payload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt_exists boolean;
  payload_column text;
BEGIN
  payload_column := CASE WHEN TG_TABLE_NAME = 'inbox' THEN 'envelope' ELSE 'observation' END;
  IF TG_OP = 'INSERT' THEN
    IF to_jsonb(NEW)->payload_column = 'null'::jsonb THEN
      RAISE EXCEPTION 'delivery_payload_receipt_required';
    END IF;
    RETURN NEW;
  END IF;
  SELECT EXISTS (SELECT 1 FROM leaderboard_ingestion.delivery_payload_expiries
    WHERE delivery_id = OLD.delivery_id) INTO receipt_exists;
  IF receipt_exists THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable_expired_delivery'; END IF;
    IF to_jsonb(NEW)->payload_column IS DISTINCT FROM 'null'::jsonb
      OR (to_jsonb(NEW) - payload_column) IS DISTINCT FROM (to_jsonb(OLD) - payload_column) THEN
      RAISE EXCEPTION 'immutable_expired_delivery';
    END IF;
  ELSIF TG_OP = 'UPDATE' AND to_jsonb(NEW)->payload_column = 'null'::jsonb THEN
    RAISE EXCEPTION 'delivery_payload_receipt_required';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_inbox_payload_expiry BEFORE INSERT OR UPDATE OR DELETE ON leaderboard_ingestion.inbox
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.guard_expired_delivery_payload();
CREATE TRIGGER guard_observation_payload_expiry BEFORE INSERT OR UPDATE OR DELETE ON leaderboard_ingestion.observations
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.guard_expired_delivery_payload();

CREATE FUNCTION leaderboard_ingestion.guard_expired_delivery_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM leaderboard_ingestion.delivery_payload_expiries WHERE event_key = OLD.event_key) THEN
    IF TG_OP = 'DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'immutable_expired_dispatch';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_expired_delivery_dispatch BEFORE UPDATE OR DELETE ON leaderboard_ingestion.outbox
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.guard_expired_delivery_dispatch();

-- A committed receipt cannot exist while either payload copy survives, or while
-- the operation's durable count differs from its actual per-delivery receipts.
CREATE FUNCTION leaderboard_ingestion.check_delivery_expiry_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected integer;
  actual integer;
BEGIN
  SELECT expired_count INTO STRICT expected FROM leaderboard_ingestion.delivery_payload_expiry_operations
    WHERE operation_id = NEW.operation_id;
  SELECT count(*)::integer INTO actual FROM leaderboard_ingestion.delivery_payload_expiries
    WHERE operation_id = NEW.operation_id;
  IF expected <> actual OR EXISTS (
    SELECT 1 FROM leaderboard_ingestion.delivery_payload_expiries AS receipt
      JOIN leaderboard_ingestion.inbox AS intake USING (delivery_id)
      JOIN leaderboard_ingestion.observations AS evidence USING (event_key)
    WHERE receipt.operation_id = NEW.operation_id AND (intake.envelope IS NOT NULL OR evidence.observation IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'incomplete_delivery_payload_expiry';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER complete_delivery_expiry_operation AFTER INSERT
  ON leaderboard_ingestion.delivery_payload_expiry_operations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.check_delivery_expiry_commit();
CREATE CONSTRAINT TRIGGER complete_delivery_payload_expiry AFTER INSERT
  ON leaderboard_ingestion.delivery_payload_expiries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION leaderboard_ingestion.check_delivery_expiry_commit();
