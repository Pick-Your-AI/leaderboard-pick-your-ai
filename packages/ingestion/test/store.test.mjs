import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { InboxStore, postgresDatabase, createWebhookHandler, createIngestionServer, runWorker } from '../dist/index.js';

const up = await readFile(new URL('../sql/001_ingestion.up.sql', import.meta.url), 'utf8');
const down = await readFile(new URL('../sql/001_ingestion.down.sql', import.meta.url), 'utf8');
const url = process.env.INGESTION_TEST_DATABASE_URL;
let engine, db, store;
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
});
after(async () => {
  if (engine) await (url ? engine.end() : engine.close());
});
beforeEach(async () => {
  await db.query('TRUNCATE leaderboard_ingestion.outbox, leaderboard_ingestion.observations, leaderboard_ingestion.replay_receipts, leaderboard_ingestion.attempt_history, leaderboard_ingestion.inbox RESTART IDENTITY CASCADE');
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

test('migration rollback and reapply work on an empty schema', async () => {
  if (url) { await engine.query(down); await engine.query(up); }
  else { await engine.exec(down); await engine.exec(up); }
  assert.equal(await store.insert(delivery()), 'accepted');
});
