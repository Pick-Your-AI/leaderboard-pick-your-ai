import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadPipelineComponents, createPipeline, migratePipeline } from '../src/index.mjs';

const checkout = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const roots = process.env.PIPELINE_COMPONENT_ROOTS ? JSON.parse(process.env.PIPELINE_COMPONENT_ROOTS) : {};
const ingestionRoot = roots.ingestion ?? checkout;
const require = createRequire(join(ingestionRoot, 'packages/ingestion/package.json'));
const { PGlite } = require('@electric-sql/pglite');
const components = await loadPipelineComponents(roots);
const clock = () => new Date().toISOString();
const ago = days => new Date(Date.now() - days * 86400000).toISOString();
const fixtureId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const publicScope = { organization: 'Pick-Your-AI', repository: null, workstream: null, start: null, end: null };
const boardUrl = '/api/v1/boards?metric=issues_opened';

async function harness(t, extra = {}) {
  const slug = extra.markerFreeConfig ? 'example-org/example-repo' : 'synthetic-org/synthetic-repo';
  const directory = await mkdtemp(join(tmpdir(), 'leaderboard-pipeline-'));
  const engine = new PGlite(join(directory, 'postgres'));
  const db = { query: (sql, params) => engine.query(sql, params), transaction: work => engine.transaction(tx => work({ query: (sql, params) => tx.query(sql, params) })) };
  for (const name of ['001_ingestion.up.sql','002_snapshots.up.sql','003_collection.up.sql']) await engine.exec(await readFile(join(ingestionRoot, 'packages/ingestion/sql', name), 'utf8'));
  await migratePipeline(db);
  const controlsStore = new components.controls.ControlStore(join(directory, 'controls.sqlite'));
  const policy = { metricId: 'issues_opened', version: 'synthetic-policy-v1', definitionVersion: components.metrics.metricRegistryV1.policy_version,
    unit: components.metrics.getMetricDefinition('issues_opened').definition.unit, aggregation: 'count', dateBasis: 'occurredAt', rankedStates: ['observed'],
    roles: ['reporter'], groupBy: 'actor_artifact', sources: ['github_rest'], minimumSamples: 1, rank: true };
  const config = { version: 'synthetic-configuration-v1', organization: 'Pick-Your-AI', approvalReceipt: 'synthetic-config-approval',
    repositories: [{ id: 2, installationId: 1, slug, families: ['issues'], approvalReceipt: 'synthetic-source-approval' }],
    policies: [{ policy, signature: components.metrics.stableJSON(policy), approvalReceipt: 'synthetic-metric-approval' }], scopes: [publicScope] };
  if (extra.markerFreeConfig) {
    config.version = 'configuration-v1'; config.approvalReceipt = 'config-approval';
    config.repositories[0].approvalReceipt = 'source-approval';
    policy.version = 'policy-v1'; config.policies[0].approvalReceipt = 'policy-approval'; config.policies[0].signature = components.metrics.stableJSON(policy);
  }
  let privateRepository = false;
  let fixturePage = false;
  let sourceFailure = false;
  let payloads = [
    { id: 1001, node_id: 'SYNTHETIC_ISSUE_1', number: 1, html_url: `https://github.com/${slug}/issues/1`, created_at: ago(2), updated_at: ago(1), user: { id: 101, node_id: 'U_SYNTHETIC_A', login: 'synthetic-alice', type: 'User' } },
    { id: 1002, node_id: 'SYNTHETIC_ISSUE_2', number: 2, html_url: `https://github.com/${slug}/issues/2`, created_at: ago(45), updated_at: ago(1), user: { id: 102, node_id: 'U_SYNTHETIC_B', login: 'synthetic-bob', type: 'User' } },
  ];
  const githubClient = new components.github.GithubReadClient({ apiOrigin: 'https://api.synthetic.invalid', token: async () => 'synthetic-test-token',
    checkpoints: new components.github.FileCheckpointStore(join(directory, 'http-checkpoints')), maxRetries: 0,
    fetch: async value => {
      const url = new URL(value);
      if (sourceFailure) throw new Error('synthetic unavailable source');
      const repository = { id: 2, private: privateRepository, full_name: slug, default_branch: 'main' };
      let body;
      if (url.pathname === `/repos/${slug}`) body = repository;
      else if (url.pathname === `/repos/${slug}/issues`) body = payloads;
      else { const number = Number(url.pathname.match(/\/issues\/(\d+)$/)?.[1]); body = payloads.find(payload => payload.number === number); }
      return new Response(JSON.stringify(body ?? { message: 'not found' }), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
    } });
  const source = { async readPage(request) {
    const items = await githubClient.rest('installation:1', `/repos/${slug}/issues`);
    return { repositoryId: 2, visibility: 'public', isSynthetic: fixturePage, nextCursor: null, expectedCount: items.length,
      facts: items.map(item => ({ subjectId: item.node_id, sourceRevision: item.updated_at, sourceUrl: item.html_url, evidence: 'current_state', actorId: null, occurredAt: null, state: 'open' })) };
  } };
  const options = { components, db, controlsStore, githubClient, sourceId: 'installation:1', source,
    config, dataMode: 'synthetic', cursorSecret: 'synthetic-cursor-secret-is-at-least-32-characters',
    verifyConfiguration: async value => value.approvalReceipt === config.approvalReceipt,
    authorizeCorrection: async value => value.operatorId === '201' && value.approvalReceipt === 'synthetic-correction-approval',
    probeRepository: async repo => { const value = await githubClient.rest('installation:1', `/repos/${repo.slug}`); return { repositoryId: value.id, installationId: repo.installationId, visibility: value.private ? 'private' : 'public', checkedAt: clock() }; },
    ...extra };
  const runtime = await createPipeline(options);
  t.after(async () => {
    await runtime.stop(); controlsStore.close(); await engine.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(basename(directory), /^leaderboard-pipeline-/);
    await rm(directory, { recursive: true, force: true });
  });
  return { runtime, db, controlsStore, options, engine, directory,
    setPrivate(value) { privateRepository = value; }, setSourceFailure(value) { sourceFailure = value; }, setFixturePage(value) { fixturePage = value; },
    duplicate() { payloads = payloads.map(payload => ({ ...payload, updated_at: clock() })); },
    add(payload) { payloads.push(payload); }, config };
}

async function getBoard(runtime, suffix = '') {
  const response = await runtime.app.inject(boardUrl + suffix);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test('unapproved configuration fails closed before collection or public publication', async t => {
  const h = await harness(t, { verifyConfiguration: async () => false });
  assert.deepEqual(await h.runtime.runOnce(), { state: 'blocked', reason: 'approved_configuration_required' });
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode, 503);
  assert.equal((await h.db.query('SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts')).rows[0].n, 0);
});

test('actual source transport, collection, normalizer, metric engine and API preserve all-time evidence and replay duplicates', async t => {
  const h = await harness(t);
  const cutoff = clock();
  const first = await h.runtime.runOnce({ cutoff });
  assert.equal(first.state, 'published'); assert.equal(first.publications[0].changed, true);
  const board = await getBoard(h.runtime);
  assert.deepEqual(board.rows.map(row => [row.actorId, row.result.value, row.rank]), [['101',1,1],['102',1,1]]);
  assert.equal(board.coverage[0].state, 'partial');
  assert.match(board.computationVersion, /^synthetic-pipeline-/);
  assert.equal(board.methodology[0].policyVersion, 'synthetic-policy-v1');
  const repeated = await h.runtime.runOnce({ cutoff });
  assert.equal(repeated.publications[0].changed, false);
  h.duplicate();
  const late = await h.runtime.runOnce({ cutoff: clock() });
  assert.equal(late.state, 'published');
  assert.deepEqual((await getBoard(h.runtime)).rows.map(row => row.result.value), [1,1]);
  assert.equal((await h.db.query('SELECT count(*)::int AS n FROM leaderboard_ingestion.source_facts')).rows[0].n, 4);
  const receipts = await h.runtime.receipts();
  assert.equal(receipts.filter(receipt => receipt.kind === 'snapshot_published').length >= 1, true);
});

test('current server-side privacy overlay applies to pinned API, evidence, exports and live reads immediately', async t => {
  const h = await harness(t); await h.runtime.runOnce();
  const before = await getBoard(h.runtime), pin = before.snapshotId;
  const evidenceId = before.rows.find(row => row.actorId === '101').evidenceIds[0];
  h.controlsStore.transaction(state => { state.profiles['101'] = { suppressed: true, public: false, bio: '', highlights: [] }; }, { publish: true });
  const after = await getBoard(h.runtime, `&snapshot=${pin}`);
  assert.deepEqual(after.rows.map(row => row.actorId), ['102']);
  assert.notEqual(after.policyVersion, before.policyVersion);
  const profile = await h.runtime.app.inject(`/api/v1/contributors/101?snapshot=${pin}`);
  assert.equal(profile.statusCode,404);
  assert.equal((await h.runtime.app.inject(`/api/v1/evidence/${evidenceId}?snapshot=${pin}`)).statusCode,404);
  const exported = await h.runtime.app.inject(`/api/v1/exports?metric=issues_opened&format=csv&snapshot=${pin}`);
  assert.equal(exported.statusCode,200); assert.equal(exported.body.includes('synthetic-alice'),false);
  const live = await h.runtime.app.inject('/api/v1/updates'); assert.equal(live.statusCode,200); assert.equal(live.body.includes(after.policyVersion),true);
});

test('reviewed correction persists receipts, overlays old snapshots, recomputes, and binds exact retries', async t => {
  const h = await harness(t); await h.runtime.runOnce(); const before = await getBoard(h.runtime);
  const factId = before.rows.find(row => row.actorId === '101').evidenceIds[0];
  const requestId = fixtureId(50);
  h.controlsStore.transaction(state => { state.requests[requestId] = { id: requestId, kind: 'correction', owner: '102', locator: 'https://github.com/synthetic-org/synthetic-repo/issues/1', status: 'pending', version: 1, createdAt: Date.now(), updatedAt: Date.now(), history: [] }; });
  const decision = { requestId, expectedVersion: 1, factId, operatorId: '201', approvalReceipt: 'synthetic-correction-approval' };
  await assert.rejects(h.runtime.applyCorrection({ ...decision, operatorId: '102' }), /not_authorized/);
  const applied = await h.runtime.applyCorrection(decision); assert.equal(applied.status,'applied');
  const receiptCount = (await h.runtime.receipts()).length;
  assert.deepEqual(await h.runtime.applyCorrection(decision),applied);
  assert.equal((await h.runtime.receipts()).length,receiptCount);
  await assert.rejects(h.runtime.applyCorrection({ ...decision, expectedVersion: 9 }),/retry_mismatch/);
  assert.deepEqual((await getBoard(h.runtime,`&snapshot=${before.snapshotId}`)).rows.map(row=>row.actorId),['102']);
  await h.runtime.runOnce(); assert.deepEqual((await getBoard(h.runtime)).rows.map(row=>row.actorId),['102']);
  assert.equal(h.controlsStore.read().requests[requestId].status,'applied');
  assert.equal((await h.runtime.receipts()).some(receipt=>receipt.kind==='correction_applied'),true);
});

test('signed lifecycle revocation blocks historical and current API, exports and live projections', async t => {
  const h = await harness(t); await h.runtime.runOnce(); const before = await getBoard(h.runtime);
  assert.equal(await h.runtime.collection.suppress(fixtureId(70),'a'.repeat(64),1,[2],'revoked'),'accepted');
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode,503);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${before.snapshotId}`)).statusCode,410);
  assert.equal((await h.runtime.app.inject('/api/v1/exports?metric=issues_opened')).statusCode,503);
  assert.equal((await h.runtime.app.inject('/api/v1/updates')).statusCode,503);
  await assert.rejects(h.runtime.runOnce(),/revoked_or_changed/);
  assert.equal((await h.db.query('SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots')).rows[0].n,1);
});

test('negative public visibility probe fences reads even when no lifecycle webhook arrives', async t => {
  const h = await harness(t); await h.runtime.runOnce(); const pin = (await getBoard(h.runtime)).snapshotId;
  h.setPrivate(true);
  await assert.rejects(h.runtime.runOnce(),/not_verified/);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode,503);
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${pin}`)).statusCode,410);
  assert.equal((await h.runtime.receipts()).some(receipt=>receipt.kind==='source_unavailable'),true);
});

test('default public runtime rejects synthetic config and persists no fixture facts or public snapshot', async t => {
  const h = await harness(t, { dataMode: 'public' });
  await assert.rejects(h.runtime.runOnce(),/synthetic_data_forbidden/);
  for (const table of ['leaderboard_ingestion.source_facts','leaderboard_pipeline.normalizations','leaderboard_pipeline.snapshots']) assert.equal((await h.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
  assert.equal((await h.runtime.app.inject(boardUrl)).statusCode,503);
});

test('synthetic mode cannot bind public interfaces and missing approvals cannot be supplied by source payloads', async t => {
  const h = await harness(t);
  await assert.rejects(h.runtime.start({ public: { host: '0.0.0.0',port:0 } }),/requires_loopback/);
  const other = await harness(t, { verifyConfiguration: async () => false });
  other.setFixturePage(true);
  assert.equal((await other.runtime.runOnce()).state,'blocked');
});


test('synthetic snapshots and cache cannot be consumed by a public runtime reusing the same marker-free configuration', async t => {
  const h = await harness(t, { markerFreeConfig: true });
  await h.runtime.runOnce(); const before = await getBoard(h.runtime);
  const publicRuntime = await createPipeline({ ...h.options, dataMode: 'public' });
  t.after(() => publicRuntime.stop());
  assert.equal(await publicRuntime.source.read(publicScope, before.snapshotId, new AbortController().signal),null);
  assert.equal((await publicRuntime.app.inject(`${boardUrl}&snapshot=${before.snapshotId}`)).statusCode,410);
  const count = (await h.db.query('SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots')).rows[0].n;
  const result = await publicRuntime.runOnce();
  assert.equal(result.state,'collecting');
  assert.equal((await h.db.query('SELECT count(*)::int AS n FROM leaderboard_pipeline.snapshots')).rows[0].n,count);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.source_modes WHERE data_mode='public'")).rows[0].n,0);
});

test('current activated controls configuration disables a metric with explanation and removes a revoked repository from every read', async t => {
  const h = await harness(t); await h.runtime.runOnce(); const before = await getBoard(h.runtime);
  h.controlsStore.transaction(state => {
    state.configuration = { revision: 1, proposals: {}, history: [], active: { version: 'controls-configuration-v1', digest: 'a'.repeat(64), approval: { id:'synthetic-configuration-approval' }, document: {
      repositories: [{ id:'2', installationId:'1', slug:'synthetic-org/synthetic-repo', capabilities:['issues'] }], projects: [],
      metrics: components.metrics.metricDefinitionsV1.map(metric => ({ id:metric.id, enabled:metric.id!=='issues_opened', reason:metric.id==='issues_opened'?'Paused pending source review':'', policyVersion:'synthetic-policy-v1', policyLink:'https://github.com/synthetic-org/synthetic-repo/issues/100' })) } } };
  }, { publish:true });
  const disabled = await h.runtime.app.inject(`${boardUrl}&snapshot=${before.snapshotId}`);
  assert.equal(disabled.statusCode,503,disabled.body);
  assert.equal(disabled.json().error,'metric_disabled');
  assert.equal(disabled.json().disabledMetrics[0].reason,'metric_disabled_by_approved_configuration');
  const health = await h.runtime.app.inject('/api/v1/health'); assert.equal(health.statusCode,200,health.body);
  assert.equal(health.json().disabledMetrics.length,1);
  h.controlsStore.transaction(state => { state.configuration.revision++; state.configuration.active.document.repositories=[]; }, { publish:true });
  assert.equal((await h.runtime.app.inject(`${boardUrl}&snapshot=${before.snapshotId}`)).statusCode,503);
});


test('default production source adapter uses the real read-only GitHub client and normalizer boundary', async t => {
  const h = await harness(t, { source: undefined, probeRepository: undefined });
  assert.equal((await h.runtime.runOnce()).state,'published');
  assert.deepEqual((await getBoard(h.runtime)).rows.map(row=>row.result.value),[1,1]);
});


test('host-neutral runtime starts on loopback, reports absent operations telemetry honestly and stops cleanly', async t => {
  const h = await harness(t);
  assert.deepEqual(h.runtime.operationalStatus(2),{ state:'unknown',lagMs:null,revision:null });
  const addresses = await h.runtime.start();
  const response = await fetch(`http://127.0.0.1:${addresses.public.port}/healthz`);
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,'ok');
  await Promise.all([h.runtime.stop(),h.runtime.stop()]);
});

test('actual collection and publication boundaries emit only typed optional monitor fields', async t => {
  const events=[];
  const monitor={ success:value=>events.push({state:'success',...value}), failure:async value=>events.push({state:'failure',...value}), status:()=>({state:'fresh',lagMs:0,revision:null}) };
  const h=await harness(t,{monitor}); await h.runtime.runOnce();
  assert.equal(events.some(value=>value.stage==='collection'&&value.state==='success'),true);
  assert.equal(events.some(value=>value.stage==='normalization'&&value.state==='success'),true);
  assert.equal(events.some(value=>value.stage==='publication'&&value.state==='success'),true);
  assert.equal(events.filter(value=>value.state==='success').every(value=>Number.isFinite(value.latencyMs)&&value.latencyMs>=0),true);
  h.setPrivate(true); await assert.rejects(h.runtime.runOnce());
  assert.equal(events.some(value=>value.state==='failure'&&value.code==='permission_revoked'),true);
  assert.equal(events.every(value=>!('error'in value)&&!('payload'in value)&&!('url'in value)),true);
});


test('durable normalization and public snapshot integrity checks reject altered values', async t => {
  const h=await harness(t); await h.runtime.runOnce();
  await h.db.query("UPDATE leaderboard_pipeline.snapshots SET document=jsonb_set(document,'{rows,0,result,value}','999'::jsonb)");
  const response=await h.runtime.app.inject(boardUrl);
  assert.equal(response.statusCode,503);
  assert.equal(response.body.includes('999'),false);
});

test('public recovery cannot label facts from an interrupted synthetic run as public', async t => {
  const h = await harness(t, { markerFreeConfig: true });
  const cutoff=clock(); await h.runtime.runOnce({ cutoff });
  await h.db.query('DELETE FROM leaderboard_pipeline.source_modes');
  const publicRuntime = await createPipeline({ ...h.options, dataMode: 'public', source: { async readPage() { return { repositoryId:2,visibility:'public',nextCursor:null,expectedCount:0,facts:[] }; } } });
  t.after(() => publicRuntime.stop());
  // An empty public recollection cannot establish provenance for facts left by a crashed run.
  // The original first_run_id remains authoritative even after its post-collection label was lost.
  await assert.rejects(publicRuntime.runOnce({ cutoff }), /cross_mode_or_unproven_source_data/);
  assert.equal((await h.db.query("SELECT count(*)::int AS n FROM leaderboard_pipeline.source_modes WHERE data_mode='public'")).rows[0].n,0);
  assert.equal((await publicRuntime.app.inject(boardUrl)).statusCode,503);
});
