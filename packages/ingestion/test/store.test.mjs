import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { InboxStore, SnapshotStore, postgresDatabase, createWebhookHandler, createIngestionServer, runWorker } from '../dist/index.js';

const snapshotUp = await readFile(new URL('../sql/002_snapshots.up.sql', import.meta.url), 'utf8');
const snapshotDown = await readFile(new URL('../sql/002_snapshots.down.sql', import.meta.url), 'utf8');
const up = (await readFile(new URL('../sql/001_ingestion.up.sql', import.meta.url), 'utf8')) + '\n' + snapshotUp;
const down = snapshotDown + '\n' + (await readFile(new URL('../sql/001_ingestion.down.sql', import.meta.url), 'utf8'));
const url = process.env.INGESTION_TEST_DATABASE_URL;
let engine, db, store, snapshots;
before(async () => {
  if (url) {
    if (new URL(url).pathname !== '/leaderboard_ingestion_test') throw new Error('Tests require a disposable leaderboard_ingestion_test database');
    engine = new Pool({ connectionString: url });
    db = postgresDatabase(engine);
  } else {
    engine = new PGlite();
    db = { query: (sql, params) => engine.query(sql, params),
      transaction: fn => engine.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })) };
  }
  // Refuse to overwrite an existing schema. CI must provide a fresh disposable DB.
  const existing = await db.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'leaderboard_ingestion'");
  assert.equal(existing.rows.length, 0, 'test schema already exists; refusing to overwrite it');
  if (url) await engine.query(up); else await engine.exec(up);
  store = new InboxStore(db, 3);
  snapshots = new SnapshotStore(db);
});
after(async () => {
  if (engine) await (url ? engine.end() : engine.close());
});
beforeEach(async () => {
  await db.query('TRUNCATE leaderboard_ingestion.snapshot_notices, leaderboard_ingestion.snapshot_heads, leaderboard_ingestion.snapshots, leaderboard_ingestion.outbox, leaderboard_ingestion.observations, leaderboard_ingestion.replay_receipts, leaderboard_ingestion.attempt_history, leaderboard_ingestion.inbox RESTART IDENTITY CASCADE');
});

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function delivery(n = 1) {
  return { deliveryId: id(n), bodyHash: 'a'.repeat(64), envelope: {
    version: 'github-delivery/v1', deliveryId: id(n), event: 'issues', action: 'reopened', installationId: 1,
    repositoryId: 2, subjectId: 'SYNTHETIC_ISSUE', actorId: null, occurredAt: null,
    sourceUrl: 'https://github.com/synthetic-org/synthetic-repo/issues/3' } };
}
async function expire() {
  await db.query("UPDATE leaderboard_ingestion.inbox SET lease_until = clock_timestamp() - interval '1 second' WHERE state = 'leased'");
}
async function ready() { await db.query("UPDATE leaderboard_ingestion.inbox SET available_at = clock_timestamp() - interval '1 second'"); }
async function counts() {
  return (await db.query(`SELECT (SELECT count(*)::int FROM leaderboard_ingestion.observations) AS observations,
    (SELECT count(*)::int FROM leaderboard_ingestion.outbox) AS notices`)).rows[0];
}

test('redelivery is idempotent and a reused delivery ID with different bytes conflicts', async () => {
  assert.equal(await store.insert(delivery()), 'accepted');
  assert.equal(await store.insert(delivery()), 'duplicate');
  assert.equal(await store.insert({ ...delivery(), bodyHash: 'b'.repeat(64) }), 'conflict');
});

test('signed delivery survives intake and worker restart; tampered redelivery cannot change the receipt', async () => {
  const secret = 'synthetic-integration-secret-of-32-characters';
  const receive = createWebhookHandler({ secrets: [secret], scope: new Map([[1, new Set([2])]]), store });
  const body = JSON.stringify({ action: 'opened', installation: { id: 1 },
    repository: { id: 2, private: false, visibility: 'public', full_name: 'synthetic-org/synthetic-repo' },
    sender: null, issue: { node_id: 'SYNTHETIC_ISSUE', number: 3, created_at: '2026-01-01T00:00:00Z', body: 'unretained' } });
  const request = text => new Request('https://synthetic.invalid/webhook', { method: 'POST', body: text,
    headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': id(1),
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(text).digest('hex')}` } });
  assert.equal((await receive(request(body))).status, 202);
  assert.equal((await receive(request(body))).status, 200);
  assert.equal((await receive(request(body.replace('unretained', 'changed')))).status, 409);
  const restarted = new InboxStore(db, 3);
  const lease = await restarted.claim();
  assert.equal(await restarted.complete(lease), true);
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
  assert.doesNotMatch(JSON.stringify((await db.query('SELECT envelope FROM leaderboard_ingestion.inbox')).rows), /unretained|changed/);
});

test('acknowledged data survives a new store instance; only one current lease completes', async () => {
  await store.insert(delivery());
  const restarted = new InboxStore(db, 3);
  const lease = await restarted.claim();
  assert.equal(await store.claim(), null);
  assert.equal(await store.complete(lease), true);
  assert.equal(await store.complete(lease), false);
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
  const observation = (await db.query('SELECT observation FROM leaderboard_ingestion.observations')).rows[0].observation;
  assert.equal(observation.occurredAt, null);
  assert.equal(observation.actorId, null);
  assert.equal(observation.qualification, 'not_evaluated');
});

test('HTTP receiver restart retains acknowledged receipt and a restarted worker makes fresh progress', async () => {
  const secret = 'synthetic-http-integration-secret-32-characters';
  const options = { secrets: [secret], scope: new Map([[1, new Set([2])]]), store };
  const body = JSON.stringify({ action: 'reopened', installation: { id: 1 },
    repository: { id: 2, private: false, visibility: 'public', full_name: 'synthetic-org/synthetic-repo' },
    sender: null, issue: { node_id: 'SYNTHETIC_ISSUE', number: 3 } });
  const headers = { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': id(1),
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` };
  for (const expected of [202, 200]) {
    const server = createIngestionServer({ ...options, store: new InboxStore(db, 3) });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/github`, { method: 'POST', headers, body });
      assert.equal(response.status, expected);
      await response.json();
    } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
  const control = new AbortController();
  const states = [];
  await runWorker(new InboxStore(db, 3), { signal: control.signal,
    onStatus: state => { states.push(state); control.abort(); } });
  assert.deepEqual(states, ['processed']);
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
});

test('expired worker cannot complete or fail a delivery reclaimed by another worker', async () => {
  await store.insert(delivery());
  const stale = await store.claim();
  await expire();
  assert.equal(await store.complete(stale), false);
  const current = await store.claim();
  assert.notEqual(stale.token, current.token);
  assert.equal(current.attempt, 2);
  assert.equal(await store.fail(stale, 'normalization_failed'), false);
  assert.equal(await store.complete(stale), false);
  assert.equal(await store.complete(current), true);
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
});

test('outbox failure rolls back the observation and acknowledgement together', async () => {
  await store.insert(delivery());
  const lease = await store.claim();
  const broken = new InboxStore({ ...db, transaction: work => db.transaction(tx => work({ query(sql, params) {
    if (sql.includes('INSERT INTO leaderboard_ingestion.outbox')) throw new Error('synthetic outbox failure');
    return tx.query(sql, params);
  } })) });
  await assert.rejects(broken.complete(lease), /synthetic outbox failure/);
  assert.deepEqual(await counts(), { observations: 0, notices: 0 });
  assert.equal(await store.complete(lease), true);
});

test('bounded retries defer delivery then quarantine poison events', async () => {
  await store.insert(delivery());
  for (let attempt = 1; attempt <= 3; attempt++) {
    const lease = await store.claim();
    assert.equal(lease.attempt, attempt);
    assert.equal(await store.fail(lease, 'source_unavailable'), true);
    assert.equal(await store.claim(), null);
    await ready();
  }
  const row = (await db.query('SELECT state, attempts, reason_code FROM leaderboard_ingestion.inbox')).rows[0];
  assert.deepEqual(row, { state: 'quarantined', attempts: 3, reason_code: 'source_unavailable' });
});

test('crash on final attempt quarantines after expiry; permanent failures quarantine immediately', async () => {
  await store.insert(delivery());
  for (let i = 0; i < 3; i++) { assert.ok(await store.claim()); await expire(); }
  assert.equal(await store.claim(), null);
  assert.equal((await db.query('SELECT reason_code FROM leaderboard_ingestion.inbox')).rows[0].reason_code, 'attempts_exhausted');
  await store.insert(delivery(2));
  assert.equal(await store.fail(await store.claim(), 'unsupported_payload', true), true);
  assert.equal(await store.claim(), null);
});

test('PostgreSQL concurrent delivery and SKIP LOCKED workers preserve exactly one observation per delivery', { skip: !url }, async () => {
  const inserted = await Promise.all(Array.from({ length: 8 }, () => store.insert(delivery())));
  assert.equal(inserted.filter(state => state === 'accepted').length, 1);
  await store.insert(delivery(2));
  const leases = await Promise.all([store.claim(), store.claim(), store.claim()]);
  const claimed = leases.filter(Boolean);
  assert.equal(claimed.length, 2);
  assert.equal(new Set(claimed.map(lease => lease.deliveryId)).size, 2);
  assert.deepEqual(await Promise.all(claimed.map(lease => store.complete(lease))), [true, true]);
  assert.deepEqual(await counts(), { observations: 2, notices: 2 });
});

test('operator replay preserves failure history and original delivery identity and receive time', async () => {
  await store.insert(delivery());
  const original = (await db.query('SELECT received_at FROM leaderboard_ingestion.inbox')).rows[0].received_at;
  await store.fail(await store.claim(), 'unsupported_payload', true);
  assert.equal(await store.replay(id(1), 'synthetic-review-receipt-1'), true);
  assert.equal(await store.replay(id(1), 'synthetic-review-receipt-2'), false);
  assert.equal(await store.complete(await store.claim()), true);
  const history = (await db.query('SELECT outcome FROM leaderboard_ingestion.attempt_history ORDER BY started_at')).rows;
  assert.deepEqual(history.map(row => row.outcome), ['quarantined', 'done']);
  assert.deepEqual((await db.query('SELECT prior_attempts, prior_reason_code FROM leaderboard_ingestion.replay_receipts')).rows,
    [{ prior_attempts: 1, prior_reason_code: 'unsupported_payload' }]);
  assert.deepEqual((await db.query('SELECT received_at FROM leaderboard_ingestion.inbox')).rows[0].received_at, original);
});

test('read-only object replay uses source time, survives store restart and declares retained-only coverage', async () => {
  const open = delivery(1);
  open.envelope.action = 'opened';
  open.envelope.occurredAt = '2026-01-01T00:00:00.000Z';
  const closed = delivery(2);
  closed.envelope.action = 'closed';
  closed.envelope.occurredAt = '2026-01-02T00:00:00.000Z';
  // Reverse receipt order relative to the source facts.
  for (const item of [closed, open]) { await store.insert(item); await store.complete(await store.claim()); }
  const priorCounts = await counts();
  const first = await store.replayObjectState(2, 'SYNTHETIC_ISSUE');
  assert.equal(first.coverage, 'retained_observations_only');
  assert.equal(first.sourceObservationCount, 2);
  assert.equal(first.replay.facets[0].state, 'known');
  assert.equal(first.replay.facets[0].value, 'closed');
  assert.deepEqual(await new InboxStore(db, 3).replayObjectState(2, 'SYNTHETIC_ISSUE'), first);
  assert.deepEqual(await counts(), priorCounts);
  // A subsequent unknown-time reopen must not silently use database receive time.
  await store.insert(delivery(3));
  await store.complete(await store.claim());
  const after = await store.replayObjectState(2, 'SYNTHETIC_ISSUE');
  assert.equal(after.replay.facets[0].state, 'ambiguous');
  assert.equal(after.replay.facets[0].value, null);
  assert.equal((await store.replayObjectState(999, 'SYNTHETIC_ISSUE')).sourceObservationCount, 0);
  assert.deepEqual((await store.replayObjectState(999, 'SYNTHETIC_ISSUE')).replay.facets, []);
});

test('edits do not assert lifecycle and unknown normalization versions fail closed', async () => {
  const edit = delivery();
  edit.envelope.action = 'edited';
  await store.insert(edit);
  await store.complete(await store.claim());
  const result = await store.replayObjectState(2, 'SYNTHETIC_ISSUE');
  assert.equal(result.sourceObservationCount, 1);
  assert.deepEqual(result.replay.facets, []);
  await db.query("UPDATE leaderboard_ingestion.observations SET normalization_version = 'synthetic-unknown'");
  await assert.rejects(store.replayObjectState(2, 'SYNTHETIC_ISSUE'), /unsupported_normalization_version/);
  await assert.rejects(store.replayObjectState(0, 'SYNTHETIC_ISSUE'), /invalid_replay_scope/);
});

test('oversized retained history fails instead of returning an apparently complete partial replay', async () => {
  await db.query(`INSERT INTO leaderboard_ingestion.inbox (delivery_id, body_hash, envelope)
    SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, repeat('a', 64), $1::jsonb
    FROM generate_series(1, 257) AS n`, [JSON.stringify(delivery().envelope)]);
  await db.query(`INSERT INTO leaderboard_ingestion.observations (event_key, delivery_id, normalization_version, observation)
    SELECT 'synthetic-limit:' || delivery_id, delivery_id, 'delivery-observation/v1', envelope
    FROM leaderboard_ingestion.inbox`);
  await assert.rejects(store.replayObjectState(2, 'SYNTHETIC_ISSUE'), /replay_limit_exceeded/);
});

async function observe(n = 1, action = 'opened', occurredAt = '2026-01-01T00:00:00.000Z', subjectId = 'SYNTHETIC_ISSUE') {
  const item = delivery(n);
  Object.assign(item.envelope, { action, occurredAt, subjectId });
  await store.insert(item);
  assert.equal(await store.complete(await store.claim()), true);
}

test('empty snapshot scope remains unavailable, not a published zero', async () => {
  assert.equal(await snapshots.latest(2, 'SYNTHETIC_ISSUE'), null);
  assert.equal(await snapshots.byId('0'.repeat(64)), null);
  assert.deepEqual(await snapshots.notices(2, 'SYNTHETIC_ISSUE', '0'), []);
  await assert.rejects(snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0'), /snapshot_no_observations/);
});

test('publication, pinned reads and compact notices agree on one immutable snapshot', async () => {
  await observe();
  const first = await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0');
  assert.equal(first.changed, true);
  assert.equal(first.revision, '1');
  assert.equal(first.snapshot.document.coverage, 'retained_observations_only');
  assert.equal(first.snapshot.document.replay.facets[0].value, 'open');
  const { changed, ...head } = first;
  assert.deepEqual(await snapshots.latest(2, 'SYNTHETIC_ISSUE'), head);
  assert.deepEqual(await snapshots.byId(first.snapshot.snapshotId), first.snapshot);
  assert.deepEqual(await snapshots.notices(2, 'SYNTHETIC_ISSUE', '0'), [
    { revision: '1', snapshotId: first.snapshot.snapshotId, publishedAt: first.publishedAt },
  ]);
  const unchanged = await new SnapshotStore(db).publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '1');
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.snapshot, first.snapshot);
  assert.equal(unchanged.revision, '1');
  assert.equal((await snapshots.notices(2, 'SYNTHETIC_ISSUE', '0')).length, 1);
});

test('new evidence advances revision while prior IDs and definition versions remain pinned', async () => {
  await observe();
  const first = await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0');
  await observe(2, 'closed', '2026-01-02T00:00:00.000Z');
  const second = await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '1');
  assert.equal(second.revision, '2');
  assert.notEqual(second.snapshot.snapshotId, first.snapshot.snapshotId);
  assert.equal(second.snapshot.document.replay.facets[0].value, 'closed');
  assert.deepEqual(await snapshots.byId(first.snapshot.snapshotId), first.snapshot);
  assert.deepEqual((await snapshots.notices(2, 'SYNTHETIC_ISSUE', '1')).map(notice => notice.revision), ['2']);
  const policy = await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v2', '2');
  assert.equal(policy.revision, '3');
  assert.notEqual(policy.snapshot.snapshotId, second.snapshot.snapshotId);
  assert.equal((await snapshots.byId(first.snapshot.snapshotId)).document.definitionVersion, 'synthetic-policy-v1');
});

test('notice insertion failure rolls back payload, head and notice; recovery makes fresh useful progress', async () => {
  await observe();
  const first = await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0');
  await observe(2, 'closed', '2026-01-02T00:00:00.000Z');
  const broken = new SnapshotStore({ ...db, transaction: work => db.transaction(tx => work({ query(sql, params) {
    if (sql.includes('INSERT INTO leaderboard_ingestion.snapshot_notices')) throw new Error('synthetic publication failure');
    return tx.query(sql, params);
  } })) });
  await assert.rejects(broken.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '1'), /synthetic publication failure/);
  assert.equal((await snapshots.latest(2, 'SYNTHETIC_ISSUE')).snapshot.snapshotId, first.snapshot.snapshotId);
  assert.equal((await snapshots.notices(2, 'SYNTHETIC_ISSUE', '0')).length, 1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM leaderboard_ingestion.snapshots')).rows[0].count, 1);
  assert.equal((await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '1')).revision, '2');
});

test('failed rebuild and stale publisher retain the last known valid snapshot', async () => {
  await observe();
  const first = await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0');
  await assert.rejects(snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0'), /snapshot_revision_conflict/);
  await db.query("UPDATE leaderboard_ingestion.observations SET normalization_version = 'synthetic-unknown'");
  await assert.rejects(snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '1'), /unsupported_normalization_version/);
  assert.deepEqual((await snapshots.latest(2, 'SYNTHETIC_ISSUE')).snapshot, first.snapshot);
  await assert.rejects(db.query('UPDATE leaderboard_ingestion.snapshots SET document = $1::jsonb', ['{}']), /immutable_snapshot/);
  await assert.rejects(db.query('DELETE FROM leaderboard_ingestion.snapshots'), /immutable_snapshot/);
  assert.deepEqual(await snapshots.byId(first.snapshot.snapshotId), first.snapshot);
});

test('snapshot scope, cursor, version and identifier validation fail closed', async () => {
  await assert.rejects(snapshots.publishObjectState(0, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0'), /invalid_snapshot_scope/);
  await assert.rejects(snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'bad version', '0'), /invalid_definition_version/);
  for (const invalid of ['01', '-1', '9223372036854775808', '1.1']) {
    await assert.rejects(snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', invalid), /invalid_snapshot_revision/);
  }
  await assert.rejects(snapshots.byId('invalid'), /invalid_snapshot_id/);
  await assert.rejects(snapshots.notices(2, 'SYNTHETIC_ISSUE', '0', 101), /invalid_notice_limit/);
});

test('notice pagination orders numeric revisions across 9/10 without skipping or repeating any publication', async () => {
  await observe();
  for (let n = 1; n <= 12; n++) {
    await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', `synthetic-policy-v${n}`, String(n - 1));
  }
  const seen = [];
  let cursor = '0';
  while (true) {
    const page = await snapshots.notices(2, 'SYNTHETIC_ISSUE', cursor, 2);
    if (!page.length) break;
    for (const notice of page) {
      seen.push(notice.revision);
      assert.equal((await snapshots.byId(notice.snapshotId)).snapshotId, notice.snapshotId);
    }
    cursor = page.at(-1).revision;
  }
  assert.deepEqual(seen, Array.from({ length: 12 }, (_, index) => String(index + 1)));
});

test('revision cursors retain precision above 2^53 and exhaustion cannot replace a valid snapshot', async () => {
  await observe();
  await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0');
  // Synthetic boundary fixture, not an actual claim of this many publications.
  await db.query('UPDATE leaderboard_ingestion.snapshot_heads SET revision = $1', ['9007199254740992']);
  const high = await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v2', '9007199254740992');
  assert.equal(high.revision, '9007199254740993');
  assert.equal((await snapshots.notices(2, 'SYNTHETIC_ISSUE', '9007199254740992'))[0].revision, '9007199254740993');
  await db.query('UPDATE leaderboard_ingestion.snapshot_heads SET revision = $1', ['9223372036854775807']);
  const unchanged = await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v2', '9223372036854775807');
  assert.equal(unchanged.changed, false);
  await assert.rejects(snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v3', '9223372036854775807'), /snapshot_revision_exhausted/);
  assert.equal((await snapshots.latest(2, 'SYNTHETIC_ISSUE')).snapshot.snapshotId, high.snapshot.snapshotId);
});

test('snapshot readers reject mismatched hashes, malformed content and unknown document versions', async () => {
  await observe();
  const published = await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0');
  for (const corrupt of [
    row => ({ ...row, snapshot_id: '0'.repeat(64) }),
    row => ({ ...row, document: { ...row.document, version: 'synthetic-unknown' } }),
    row => ({ ...row, document: { ...row.document, unexpected: 'synthetic-private-field' } }),
    row => ({ ...row, document: { ...row.document, replay: { ...row.document.replay, facets: [] } } }),
  ]) {
    const broken = new SnapshotStore({ ...db, async query(sql, params) {
      const result = await db.query(sql, params);
      return { rows: result.rows.map(corrupt) };
    } });
    await assert.rejects(broken.byId(published.snapshot.snapshotId), /snapshot_integrity_error/);
  }
  await assert.rejects(db.query(`INSERT INTO leaderboard_ingestion.snapshot_heads (scope_key, revision, snapshot_id)
    VALUES ($1, 1, $2)`, [JSON.stringify([2, 'SYNTHETIC_OTHER']), published.snapshot.snapshotId]), /foreign key/);
});

test('PostgreSQL competing publishers commit one revision; independent scopes keep independent cursors', { skip: !url }, async () => {
  await observe();
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0')));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected' && /snapshot_revision_conflict/.test(result.reason.message)).length, 5);
  assert.equal((await snapshots.notices(2, 'SYNTHETIC_ISSUE', '0')).length, 1);
  await observe(2, 'opened', '2026-01-01T00:00:00.000Z', 'SYNTHETIC_OTHER');
  assert.equal((await snapshots.publishObjectState(2, 'SYNTHETIC_OTHER', 'synthetic-policy-v1', '0')).revision, '1');
  assert.deepEqual(await snapshots.notices(2, 'SYNTHETIC_OTHER', '1'), []);
});

test('PostgreSQL readers cannot see half-published heads or notices before commit', { skip: !url }, async () => {
  await observe();
  const first = await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0');
  await observe(2, 'closed', '2026-01-02T00:00:00.000Z');
  let enter, release, nextId;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const paused = new SnapshotStore({ ...db, transaction: work => db.transaction(tx => work({ async query(sql, params) {
    if (sql.includes('INSERT INTO leaderboard_ingestion.snapshots')) nextId = params[0];
    if (sql.includes('INSERT INTO leaderboard_ingestion.snapshot_notices')) { enter(); await gate; }
    return tx.query(sql, params);
  } })) });
  const publish = paused.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '1');
  try {
    await entered;
    assert.equal((await snapshots.latest(2, 'SYNTHETIC_ISSUE')).revision, '1');
    assert.equal((await snapshots.latest(2, 'SYNTHETIC_ISSUE')).snapshot.snapshotId, first.snapshot.snapshotId);
    assert.deepEqual(await snapshots.notices(2, 'SYNTHETIC_ISSUE', '1'), []);
    assert.equal(await snapshots.byId(nextId), null);
  } finally { release(); }
  assert.equal((await publish).revision, '2');
  const notice = (await snapshots.notices(2, 'SYNTHETIC_ISSUE', '1'))[0];
  assert.equal((await snapshots.byId(notice.snapshotId)).snapshotId, nextId);
});

test('snapshot migration rollback removes publication tables while preserving retained observations', async () => {
  await observe();
  await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0');
  if (url) await engine.query(snapshotDown); else await engine.exec(snapshotDown);
  assert.deepEqual(await counts(), { observations: 1, notices: 1 });
  if (url) await engine.query(snapshotUp); else await engine.exec(snapshotUp);
  assert.equal(await snapshots.latest(2, 'SYNTHETIC_ISSUE'), null);
  assert.equal((await snapshots.publishObjectState(2, 'SYNTHETIC_ISSUE', 'synthetic-policy-v1', '0')).revision, '1');
});

test('migration rollback and reapply work on an empty schema', async () => {
  if (url) { await engine.query(down); await engine.query(up); }
  else { await engine.exec(down); await engine.exec(up); }
  assert.equal(await store.insert(delivery()), 'accepted');
});
