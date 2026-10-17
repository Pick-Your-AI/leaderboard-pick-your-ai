import { createGithubCollectionSource } from './github-source.mjs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const fail = code => { throw new Error(code); };
const required = (value, code) => typeof value === 'string' && value.trim() ? value : fail(code);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const policyDigest = value => createHash('sha256').update(value).digest('hex');
const scopeKey = scope => JSON.stringify([scope.organization, scope.repository, scope.workstream, scope.start, scope.end]);
const copy = value => structuredClone(value);
const utc = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) fail('invalid_pipeline_time');
  return value;
};
const statements = [
  'CREATE SCHEMA IF NOT EXISTS leaderboard_pipeline',
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.source_modes (fact_key text PRIMARY KEY REFERENCES leaderboard_ingestion.source_facts(fact_key), data_mode text NOT NULL CHECK(data_mode IN ('public','synthetic')))`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.normalizations (
    fact_key text NOT NULL, policy_signature text NOT NULL, document jsonb NOT NULL,
    document_hash text NOT NULL, PRIMARY KEY (fact_key, policy_signature))`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.receipts (
    receipt_id text PRIMARY KEY, operation_key text UNIQUE NOT NULL, kind text NOT NULL,
    document jsonb NOT NULL, document_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.corrections (
    request_id text PRIMARY KEY, fact_id text NOT NULL, artifact_id text NOT NULL,
    repository_id bigint NOT NULL, document jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.snapshots (
    snapshot_id text PRIMARY KEY, scope_key text NOT NULL, revision bigint NOT NULL,
    config_version text NOT NULL, repository_ids jsonb NOT NULL,
    document jsonb NOT NULL, document_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE IF NOT EXISTS leaderboard_pipeline.heads (
    scope_key text PRIMARY KEY, snapshot_id text NOT NULL REFERENCES leaderboard_pipeline.snapshots(snapshot_id), revision bigint NOT NULL)`,
];

/** Apply only this app's additive schema. Ingestion migrations remain independently owned. */
export async function migratePipeline(db) {
  for (const statement of statements) await db.query(statement);
}

/** Host-neutral composition. Authorization and source verification default to denial. */
export async function createPipeline(options) {
  const { components: c, db, controlsStore } = options;
  if (!c?.ingestion?.CollectionStore || !c?.metrics?.aggregateMetric || !c?.service?.createService || !controlsStore?.read || !db?.transaction) fail('pipeline_components_required');
  const dataMode = options.dataMode ?? 'public';
  if (!['public', 'synthetic'].includes(dataMode)) fail('invalid_pipeline_data_mode');
  const assertDataMode = value => {
    if (dataMode === 'synthetic') return;
    const serialized = JSON.stringify(value);
    if (value?.isSynthetic === true || /synthetic[_.:-]|synthetic\.example/i.test(serialized)) fail('synthetic_data_forbidden_in_public_runtime');
  };
  const config = copy(options.config ?? { version: 'unconfigured', repositories: [], policies: [], scopes: [] });
  const verifyConfig = options.verifyConfiguration ?? (async () => false);
  const authorizeCorrection = options.authorizeCorrection ?? (async () => false);
  const now = options.now ?? (() => new Date().toISOString());
  const defaultSource = options.githubClient ? createGithubCollectionSource({ client: options.githubClient, sourceId: options.sourceId, repositories: config.repositories, isSynthetic: dataMode === 'synthetic', onUnavailable: (repo,reason) => denyRepository(repo,reason,utc(now())) }) : null;
  const collectionSource = options.source ?? defaultSource;
  const probeSource = options.probeRepository ?? defaultSource?.probeRepository;
  const collection = new c.ingestion.CollectionStore(db);
  const guardedSource = { async readPage(request) {
    const page = await collectionSource.readPage(request);
    assertDataMode(page);
    return page;
  } };
  const configurationOverlay = state => options.configurationOverlay?.(state) ?? c.controls.configurationOverlay?.(state) ?? ({ revision: 0, allowedRepositoryIds: null, disabledMetricIds: [], disabledMetrics: [] });
  const restrictConfiguration = state => {
    const overlay = configurationOverlay(state);
    if (overlay.allowedRepositoryIds !== null && config.repositories.some(repo => !overlay.allowedRepositoryIds.includes(String(repo.id)))) fail('active_configuration_revoked_source');
    return overlay;
  };
  const inbox = new c.ingestion.InboxStore(db);
  const normalizer = options.normalizer ?? (options.githubClient && c.github.createGithubEvidenceNormalizer
    ? c.github.createGithubEvidenceNormalizer({ client: options.githubClient, source: options.sourceId,
      allowedRepositoryIds: config.repositories.map(repo => repo.id), isSynthetic: dataMode === 'synthetic' }) : null);
  let stopped = false;
  let stopping = null;
  let runner = null;
  let controller = null;
  let webhookServer = null;
  let workerController = null;
  let workerPromise = null;
  let controlsServer = null;
  let authorized = false;
  let operation = Promise.resolve();
  const monitorSource = repositoryId => `repository:${repositoryId}`;
  const monitorSuccess = (source, stage, started, revision = null) => {
    try { options.monitor?.success({ source, stage, latencyMs: performance.now() - started, revision }); } catch { /* telemetry cannot change durable outcomes */ }
  };
  const monitorFailure = (source, stage, code) => {
    try { void Promise.resolve(options.monitor?.failure({ source, stage, code, traceId: digest([source, stage, code, now()]).slice(0,32) })).catch(() => undefined); } catch { /* no raw errors or unapproved destination */ }
  };
  // One publisher in this runtime; SQL advisory locks protect separate runtimes.
  const serialize = work => {
    const pending = operation.then(work);
    operation = pending.catch(() => undefined);
    return pending;
  };
  async function approved() {
    authorized = Boolean(await verifyConfig(copy(config)));
    if (!authorized) return false;
    assertDataMode(config);
    restrictConfiguration(controlsStore.read());
    required(config.version, 'config_version_required');
    required(config.organization, 'organization_required');
    required(config.approvalReceipt, 'config_approval_required');
    if (!Array.isArray(config.repositories) || !Array.isArray(config.policies) || !Array.isArray(config.scopes) || config.repositories.length === 0 || config.policies.length === 0 || config.scopes.length === 0) fail('empty_pipeline_configuration');
    if (config.repositories.length > 100 || config.policies.length > 98 || config.scopes.length > 100) fail('pipeline_scope_budget_exceeded');
    if (new Set(config.repositories.map(repo => repo.id)).size !== config.repositories.length || new Set(config.policies.map(item => item.policy.metricId)).size !== config.policies.length) fail('duplicate_pipeline_configuration');
    for (const repo of config.repositories) {
      if (!Number.isSafeInteger(repo.id) || repo.id < 1 || !Number.isSafeInteger(repo.installationId) || repo.installationId < 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.slug) || !Array.isArray(repo.families) || !repo.families.length || repo.families.some(family => !c.ingestion.sourceFamilies.includes(family))) fail('invalid_repository_configuration');
      required(repo.approvalReceipt, 'repository_approval_required');
    }
    for (const item of config.policies) {
      c.metrics.validateMetricPolicy(item.policy);
      required(item.approvalReceipt, 'metric_approval_required');
      if (item.signature !== c.metrics.stableJSON(item.policy)) fail('unapproved_metric_policy_signature');
        if (['files_changed','review_rounds'].includes(item.policy.metricId) && item.policy.groupBy !== 'canonical') fail('metric_requires_conserved_path_or_head_units');
      if (item.policy.metricId === 'pr_accepted_rate' && item.policy.groupBy !== 'actor_artifact') fail('decision_ratio_requires_one_artifact_denominator');
      if (item.policy.definitionVersion !== c.metrics.metricRegistryV1.policy_version) fail('registry_definition_version_mismatch');
    }
    for (const scope of config.scopes) {
      if (scope.organization !== config.organization || !['repository', 'workstream', 'start', 'end'].every(key => key in scope)) fail('invalid_public_scope');
      if (scope.repository !== null && !config.repositories.some(repo => String(repo.id) === scope.repository)) fail('unapproved_scope_repository');
      if (scope.workstream !== null) required(scope.workstream, 'invalid_workstream_scope');
      if ((scope.start === null) !== (scope.end === null)) fail('incomplete_public_window');
      if (scope.start !== null && (utc(scope.start) >= utc(scope.end))) fail('invalid_public_window');
    }
    return true;
  }
  const configuredScope = scope => config.scopes.some(item => scopeKey(item) === scopeKey(scope));
  const repositoriesFor = scope => config.repositories.filter(repo => scope.repository === null || String(repo.id) === scope.repository);
  async function receipt(tx, operationKey, kind, document) {
    const receiptId = digest([operationKey, kind]);
    await tx.query(`INSERT INTO leaderboard_pipeline.receipts (receipt_id,operation_key,kind,document,document_hash)
      VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (operation_key) DO NOTHING`, [receiptId, operationKey, kind, JSON.stringify(document), digest(document)]);
    return receiptId;
  }
  async function denyRepository(repo, reason, checkedAt) {
    await db.transaction(async tx => {
      await tx.query(`INSERT INTO leaderboard_ingestion.repository_access (repository_id,installation_id,state)
        VALUES ($1,$2,'unavailable') ON CONFLICT (repository_id) DO UPDATE SET state='unavailable',
        generation=repository_access.generation+1,checked_at=clock_timestamp()`, [repo.id, repo.installationId]);
      await receipt(tx, `source-probe:${repo.id}:${checkedAt}:${reason}`, 'source_unavailable', { repositoryId: repo.id, reason, checkedAt });
    });
    monitorFailure(monitorSource(repo.id), 'collection', reason === 'visibility_probe_unavailable' ? 'source_unavailable' : 'permission_revoked');
  }
  async function verifyRepository(repo) {
    if (!collectionSource?.readPage || !normalizer || !probeSource) fail('source_provider_unconfigured');
    let checkedAt = utc(now());
    let probe;
    try { probe = await probeSource(copy(repo)); }
    catch { await denyRepository(repo, 'visibility_probe_unavailable', checkedAt); fail('public_source_not_verified'); }
    checkedAt = utc(now());
    try { assertDataMode(probe); }
    catch { await denyRepository(repo, 'fixture_source_rejected', checkedAt); fail('synthetic_data_forbidden_in_public_runtime'); }
    let validTime = false;
    try { validTime = utc(probe?.checkedAt) <= checkedAt && Date.parse(checkedAt) - Date.parse(probe.checkedAt) <= 60_000; } catch { /* unknown time fails closed */ }
    if (!probe || probe.repositoryId !== repo.id || probe.installationId !== repo.installationId || probe.visibility !== 'public' || !validTime) {
      await denyRepository(repo, 'visibility_or_scope_not_public', checkedAt);
      fail('public_source_not_verified');
    }
    const current = (await db.query('SELECT state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=$1', [repo.id])).rows[0];
    if (current?.state === 'public') {
      const saved = await db.query("UPDATE leaderboard_ingestion.repository_access SET checked_at=clock_timestamp() WHERE repository_id=$1 AND generation=$2 AND state='public' RETURNING repository_id", [repo.id,current.generation]);
      if (!saved.rows.length) fail('repository_access_changed');
      return;
    }
    if (!await collection.verifyPublic(repo.id, repo.installationId, current ? String(current.generation) : null)) fail('repository_revoked_or_changed');
  }
  async function normalizeStored(repositoryIds, cutoff) {
    const sourceRows = (await db.query(`SELECT fact.* FROM leaderboard_ingestion.source_facts AS fact
      JOIN leaderboard_ingestion.repository_access AS access USING (repository_id)
      WHERE fact.repository_id = ANY($1::bigint[]) AND fact.observed_at <= $2 AND access.state='public'
      AND NOT EXISTS (SELECT 1 FROM leaderboard_ingestion.object_suppressions AS removed
        WHERE removed.repository_id=fact.repository_id AND removed.subject_id=fact.subject_id)
      ORDER BY fact.fact_key LIMIT 10001`, [repositoryIds, cutoff])).rows;
    if (sourceRows.length > 10000) fail('frozen_dataset_budget_exceeded');
    const unlabeled = (await db.query(`SELECT fact.fact_key FROM leaderboard_ingestion.source_facts AS fact LEFT JOIN leaderboard_pipeline.source_modes AS mode USING(fact_key) WHERE fact.repository_id=ANY($1::bigint[]) AND (mode.data_mode IS NULL OR mode.data_mode<>$2) LIMIT 1`, [repositoryIds,dataMode])).rows;
    if (unlabeled.length) fail('cross_mode_or_unproven_source_data');
    const signature = digest([dataMode,config.policies.map(item => item.signature)]);
    const outputs = [];
    for (const row of sourceRows) {
      const cached = (await db.query('SELECT document,document_hash FROM leaderboard_pipeline.normalizations WHERE fact_key=$1 AND policy_signature=$2', [row.fact_key, signature])).rows[0];
      if (cached) {
        if (digest(cached.document) !== cached.document_hash) fail('normalization_integrity_error');
        if (cached.document.isSynthetic !== (dataMode === 'synthetic')) fail('normalization_data_mode_mismatch');
        assertDataMode(cached.document); outputs.push(cached.document); continue;
      }
      const repository = config.repositories.find(repo => String(repo.id) === String(row.repository_id));
      const normalizationStarted = performance.now();
      let output;
      try {
        output = await normalizer({ repository: copy(repository), family: row.family, factKey: row.fact_key,
          fact: copy(row.document), observedAt: new Date(row.observed_at).toISOString(), policyVersion: config.version });
        monitorSuccess(monitorSource(repository.id), 'normalization', normalizationStarted);
      } catch (error) { monitorFailure(monitorSource(repository.id), 'normalization', 'schema_changed'); throw error; }
      assertDataMode(output);
      if (output?.reasons?.includes('repository_public_scope_unverified_or_revoked')) {
        await denyRepository(repository, 'source_access_changed_during_normalization', utc(now()));
        fail('source_revoked_during_normalization');
      }
      if (!output || !Array.isArray(output.facts) || !Array.isArray(output.actors) || !Array.isArray(output.evidence) || output.facts.length > 100 || output.actors.length > 100 || output.evidence.length > 100) fail('invalid_normalized_evidence');
      // Validate the public boundary now; the public API validates it again on every read.
      for (const evidence of output.evidence) {
        c.contracts.artifactSchema.parse(evidence.artifact);
        c.contracts.contributionSchema.parse(evidence.contribution);
        if (evidence.artifact.repositoryId !== String(repository.id) || evidence.artifact.visibility !== 'public' ||
            !evidence.artifact.publicUrl?.startsWith(`https://github.com/${repository.slug}/`)) fail('normalized_evidence_scope_mismatch');
      }
      for (const fact of output.facts) if (fact.repoId !== String(repository.id) || !output.evidence.some(e => e.contribution.contributionId === fact.id && e.contribution.actorId === fact.actorId && e.contribution.artifactId === fact.artifactId && e.contribution.metricIds.includes(fact.metricId))) fail('normalized_fact_without_provenance');
      const suppressed = Array.isArray(output.suppressArtifactIds) ? output.suppressArtifactIds : [];
      for (const artifactId of suppressed) {
        if (typeof artifactId !== 'string' || !/^[A-Za-z0-9_=.:-]{1,200}$/.test(artifactId)) fail('invalid_artifact_suppression');
        await db.query("INSERT INTO leaderboard_ingestion.object_suppressions(repository_id,subject_id,reason) VALUES($1,$2,'unavailable') ON CONFLICT DO NOTHING", [repository.id,artifactId]);
      }
      const document = { suppressArtifactIds: suppressed, isSynthetic: dataMode === 'synthetic', facts: output.facts, actors: output.actors, evidence: output.evidence,
        reasons: Array.isArray(output.reasons) ? output.reasons.map(reason => typeof reason === 'string' && /^[a-z0-9_:-]{1,100}$/.test(reason) ? reason : 'normalization_unavailable') : [] };
      await db.query(`INSERT INTO leaderboard_pipeline.normalizations (fact_key,policy_signature,document,document_hash)
        VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`, [row.fact_key, signature, JSON.stringify(document), digest(document)]);
      outputs.push(document);
    }
    return outputs;
  }
  function actorContracts(actors) {
    return actors.map(actor => {
      if (!/^[1-9]\d{0,19}$/.test(actor.id) || !Number.isSafeInteger(actor.githubDatabaseId) || actor.githubDatabaseId !== Number(actor.id)) fail('unverified_actor_database_id');
      const contract = c.contracts.actorSchema.parse({ schemaVersion: 'leaderboard/v1', identityState: actor.publicState === 'deleted' ? 'deleted' : 'resolved',
        githubDatabaseId: Number(actor.id), ...(actor.githubNodeId ? { githubNodeId: actor.githubNodeId } : {}),
        ...(actor.login && actor.publicState !== 'deleted' ? { login: actor.login } : {}), kind: actor.kind, executionMode: actor.executionMode === 'automated' ? 'automated' : 'unknown' });
      return { actorId: actor.id, actor: contract, state: actor.publicState === 'visible' ? 'public' : actor.publicState === 'deleted' ? 'deleted' : 'hidden' };
    });
  }
  async function publish(scope, cutoff, observationCutoff) {
    if (!configuredScope(scope)) fail('scope_not_approved');
    const repos = repositoriesFor(scope);
    const generations = (await db.query("SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id", [repos.map(repo => repo.id)])).rows;
    if (generations.length !== repos.length || generations.some(row => row.state !== 'public')) fail('source_unavailable_before_normalization');
    const outputs = await normalizeStored(repos.map(repo => repo.id), observationCutoff);
    const suppressedArtifactIds = new Set(outputs.flatMap(output => output.suppressArtifactIds ?? []));
    const uniqueFacts = new Map();
    for (const fact of outputs.flatMap(output => output.facts)) {
      if (suppressedArtifactIds.has(fact.artifactId)) continue;
      const previous = uniqueFacts.get(fact.id);
      const semantic = value => { const { observedAt, ...rest } = value; return c.metrics.stableJSON(rest); };
      if (previous && semantic(previous) !== semantic(fact)) fail('conflicting_normalized_fact');
      if (!previous || fact.observedAt < previous.observedAt) uniqueFacts.set(fact.id, fact);
    }
    const facts = [...uniqueFacts.values()].sort((a,b) => a.id.localeCompare(b.id));
    const actors = new Map(), evidence = new Map();
    for (const output of outputs) {
      for (const actor of output.actors) {
        const previous = actors.get(actor.id);
        if (previous && c.metrics.stableJSON(previous) !== c.metrics.stableJSON(actor)) fail('conflicting_actor_metadata');
        actors.set(actor.id, actor);
      }
      for (const entry of output.evidence) {
        const id = entry.contribution.contributionId, previous = evidence.get(id);
        if (previous && c.metrics.stableJSON([previous.artifact,previous.contribution,previous.occurredAt]) !== c.metrics.stableJSON([entry.artifact,entry.contribution,entry.occurredAt])) fail('conflicting_evidence_metadata');
        if (!previous) evidence.set(id, entry);
      }
    }
    const corrections = (await db.query('SELECT document FROM leaderboard_pipeline.corrections WHERE repository_id=ANY($1::bigint[])', [repos.map(repo => repo.id)])).rows.map(row => row.document.fact);
    const window = scope.start === null ? c.metrics.resolveMetricWindow('all', cutoff) : c.metrics.resolveMetricWindow('custom', cutoff, { from: scope.start, to: scope.end });
    const engineScope = { ...window, repos: repos.map(repo => String(repo.id)), projects: [], workstreams: scope.workstream === null ? [] : [scope.workstream], roles: [], actors: 'all', context: 'event' };
    const state = controlsStore.read();
    for (const actor of actors.values()) if (state.profiles[actor.id]?.suppressed) actor.publicState = 'suppressed';
    // Completed scans establish bounded progress, not complete historic source capability.
    const coverage = repos.flatMap(repo => [...new Set(config.policies.flatMap(item => item.policy.sources))].map(source => ({
      schemaVersion: 'leaderboard/v1', state: 'partial', source, scopeId: String(repo.id), windowStart: window.from, windowEnd: window.to,
      knownStart: null, lastSuccessfulSync: cutoff, sourceWatermark: cutoff, missingPages: 0, permissionsMissing: [], sourceErrors: ['historical_capability_not_certified'],
    })));
    const frozen = { datasetId: digest([facts, corrections]), cutoff: observationCutoff, backfillRevision: digest(outputs), repositoryIds: repos.map(repo => String(repo.id)), actors: [...actors.values()], facts: [...facts, ...corrections], coverage };
    for (const item of config.policies.filter(item => item.policy.metricId === 'pr_accepted_rate')) {
      const units = new Set();
      for (const fact of frozen.facts.filter(fact => fact.metricId === item.policy.metricId && item.policy.rankedStates.includes(fact.state))) {
        const unit = JSON.stringify([fact.actorId,fact.artifactId]);
        if (units.has(unit)) fail('decision_lifecycle_selection_unproven');
        units.add(unit);
      }
    }
    const aggregates = config.policies.map(item => c.metrics.aggregateMetric(frozen, item.policy, engineScope));
    const diagnostics = aggregates.flatMap(aggregate => aggregate.rows.map(row => ({ metricId:aggregate.metricId, actorId:row.actorId, numerator:row.numerator, denominator:row.denominator, sampleCount:row.sampleCount, censored:row.censored, missingReadiness:row.missingReadiness, p75:row.p75 })));
    const rows = aggregates.flatMap(aggregate => aggregate.rows.map(row => ({ actorId: row.actorId, result: {
      schemaVersion: 'leaderboard/v1', metricId: aggregate.metricId, state: row.value === null ? 'unknown' : 'partial',
      ...(row.value === null ? {} : { value: row.value }), coverage: { ...coverage[0], scopeId: scopeKey(scope) },
    }, evidenceIds: row.evidenceIds })));
    const usedIds = new Set(rows.flatMap(row => row.evidenceIds));
    const publicEvidence = [...evidence.values()].filter(entry => usedIds.has(entry.contribution.contributionId));
    // Evidence period filtering follows the metric's declared clock, with raw time preserved upstream.
    for (const entry of publicEvidence) {
      const fact = facts.find(fact => fact.id === entry.contribution.contributionId);
      if (fact) entry.occurredAt = fact[config.policies.find(item => item.policy.metricId === fact.metricId).policy.dateBasis];
    }
    const content = { approvedPublic: true, scope: copy(scope), actors: actorContracts([...actors.values()]), rows, evidence: publicEvidence,
      ranking: config.policies.map(item => ({ metricId: item.policy.metricId, direction: 'descending', rank: item.policy.rank })),
      diagnostics, methodology: config.policies.map(item => ({ metricId: item.policy.metricId, policyVersion: item.policy.version, policySignature: policyDigest(item.signature), policyLink: item.policyLink ?? null })),
      definitionVersion: c.metrics.metricRegistryV1.policy_version, dataMode, cutoff, coverage, configVersion: config.version, repositoryIds: repos.map(repo => repo.id) };
    const snapshotId = digest(content);
    const publicationStarted = performance.now();
    try {
    const publication = await db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`pipeline:${scopeKey(scope)}`]);
      const access = (await tx.query("SELECT repository_id,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) AND state='public' FOR SHARE", [repos.map(repo => repo.id)])).rows;
      if (access.length !== repos.length || generations.some(prior => !access.some(current => String(current.repository_id) === String(prior.repository_id) && String(current.generation) === String(prior.generation)))) fail('source_revoked_before_publication');
      const current = (await tx.query('SELECT snapshot_id,revision FROM leaderboard_pipeline.heads WHERE scope_key=$1', [scopeKey(scope)])).rows[0];
      if (current?.snapshot_id === snapshotId) return { snapshotId, revision: Number(current.revision), changed: false };
      const revision = Number(current?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) fail('pipeline_revision_exhausted');
      const document = { approvedPublic: true, scope: copy(scope), actors: content.actors, rows, evidence: publicEvidence, ranking: content.ranking,
        dataMode, diagnostics, methodology: content.methodology,
        snapshot: { schemaVersion: 'leaderboard/v1', snapshotId, revision, generatedAt: utc(now()), metricDefinitionVersion: content.definitionVersion,
          computationVersion: `${dataMode}-pipeline-${digest(config.policies.map(item => item.signature)).slice(0,16)}`, coverage, results: [] } };
      await tx.query(`INSERT INTO leaderboard_pipeline.snapshots (snapshot_id,scope_key,revision,config_version,repository_ids,document,document_hash)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) ON CONFLICT DO NOTHING`, [snapshotId, scopeKey(scope), revision, config.version, JSON.stringify(content.repositoryIds), JSON.stringify(document), digest(document)]);
      await tx.query(`INSERT INTO leaderboard_pipeline.heads (scope_key,snapshot_id,revision) VALUES ($1,$2,$3)
        ON CONFLICT (scope_key) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,revision=EXCLUDED.revision`, [scopeKey(scope), snapshotId, revision]);
      const receiptId = await receipt(tx, `publish:${scopeKey(scope)}:${snapshotId}`, 'snapshot_published', { snapshotId, revision, configuration: config.version,
        policySignatures: config.policies.map(item => item.signature), datasetId: frozen.datasetId, controlsRevision: state.revision });
      return { snapshotId, revision, changed: true, receiptId };
    });
    monitorSuccess(scopeKey(scope), 'publication', publicationStarted, String(publication.revision));
    return publication;
    } catch (error) { monitorFailure(scopeKey(scope), 'publication', 'publication_failed'); throw error; }
  }
  const source = { async read(scope, pin, signal) {
    if (signal.aborted || !await approved() || !configuredScope(scope)) return null;
    return db.transaction(async tx => {
    const result = await tx.query(`SELECT selected.document,selected.document_hash,selected.config_version,selected.repository_ids,selected.revision AS selected_revision,selected.snapshot_id AS selected_id,head.revision,
      latest.snapshot_id AS head_id,latest.document->'snapshot'->>'generatedAt' AS published_at
      FROM leaderboard_pipeline.heads AS head JOIN leaderboard_pipeline.snapshots AS latest ON latest.snapshot_id=head.snapshot_id
      JOIN leaderboard_pipeline.snapshots AS selected ON selected.snapshot_id=COALESCE($2,head.snapshot_id)
      WHERE head.scope_key=$1 AND selected.scope_key=head.scope_key`, [scopeKey(scope), pin]);
    if (signal.aborted || !result.rows[0]) return null;
    const selected = result.rows[0];
    if (digest(selected.document) !== selected.document_hash || selected.document.snapshot.snapshotId !== selected.selected_id || selected.document.snapshot.revision !== Number(selected.selected_revision)) fail('public_snapshot_integrity_error');
    if (selected.config_version !== config.version || selected.document.dataMode !== dataMode) return null;
    const access = (await tx.query("SELECT repository_id,state,generation FROM leaderboard_ingestion.repository_access WHERE repository_id=ANY($1::bigint[]) ORDER BY repository_id FOR SHARE", [selected.repository_ids])).rows;
    if (signal.aborted || access.length !== selected.repository_ids.length || access.some(row => row.state !== 'public')) return null;
    const removed = (await tx.query(`SELECT subject_id FROM leaderboard_ingestion.object_suppressions WHERE repository_id=ANY($1::bigint[])
      UNION SELECT artifact_id AS subject_id FROM leaderboard_pipeline.corrections WHERE repository_id=ANY($1::bigint[])`, [selected.repository_ids])).rows.map(row => row.subject_id);
    if (signal.aborted) return null;
    // Read current private controls after all awaited I/O, even for pinned historical snapshots.
    const controls = controlsStore.read();
    const overlay = restrictConfiguration(controls);
    const document = copy(selected.document);
    document.disabledMetrics = overlay.disabledMetrics.map(entry => ({ ...entry, reason: /^[a-z0-9_:-]{1,100}$/.test(entry.reason) ? entry.reason : 'metric_disabled_by_approved_configuration' }));
    const disabled = new Set(overlay.disabledMetricIds);
    document.rows = document.rows.filter(row => !disabled.has(row.result.metricId));
    document.ranking = document.ranking.filter(row => !disabled.has(row.metricId));
    if (document.diagnostics) document.diagnostics = document.diagnostics.filter(row => !disabled.has(row.metricId));
    const evidenceIds = new Set(document.rows.flatMap(row => row.evidenceIds));
    document.evidence = document.evidence.filter(entry => evidenceIds.has(entry.contribution.contributionId));
    return { head: { snapshotId: selected.head_id, revision: Number(selected.revision), publishedAt: selected.published_at }, selected: document,
      controls: { version: `controls-${controls.revision}-${overlay.revision}-${digest([config.version, access.map(row => [String(row.repository_id), String(row.generation)]), [...removed].sort()]).slice(0,16)}`,
        suppressedActorIds: Object.entries(controls.profiles).filter(([, profile]) => profile.suppressed).map(([id]) => id),
        suppressedArtifactIds: removed, revokedSnapshotIds: [] } };
    });
  } };
  const app = c.service.createService({ source, registry: c.metrics.metricRegistryV1, cursorSecret: options.cursorSecret, now: () => Date.parse(now()) });
  async function runOnce({ cutoff = now(), mode = 'reconcile', maxPages = 100 } = {}) {
    return serialize(async () => {
      utc(cutoff);
      if (stopped) fail('pipeline_stopped');
      if (!await approved()) return { state: 'blocked', reason: 'approved_configuration_required' };
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000) fail('invalid_pipeline_page_budget');
      const progress = [];
      for (const repo of config.repositories) {
        await verifyRepository(repo, cutoff);
        for (const family of repo.families) {
          const runId = digest([config.version, repo.id, family, cutoff, mode, dataMode]);
          await collection.start({ runId, repositoryId: repo.id, family, mode, since: null, until: cutoff });
          const collectionStarted = performance.now();
          let status = 'progress';
          for (let page = 0; page < maxPages && status === 'progress'; page++) {
            status = await collection.step(runId, guardedSource);
            if (status === 'progress' || status === 'complete') await db.query(`INSERT INTO leaderboard_pipeline.source_modes(fact_key,data_mode) SELECT item.fact_key,$2 FROM leaderboard_ingestion.collection_items AS item JOIN leaderboard_ingestion.source_facts AS fact USING(fact_key) WHERE item.run_id=$1 AND fact.first_run_id=$1 ON CONFLICT DO NOTHING`, [runId,dataMode]);
          }
          if (status === 'complete') monitorSuccess(monitorSource(repo.id), 'collection', collectionStarted);
          else if (status === 'failed') monitorFailure(monitorSource(repo.id), 'collection', 'source_unavailable');
          progress.push({ repositoryId: repo.id, family, runId, status });
          if (status !== 'complete') return { state: 'collecting', progress, publications: [] };
        }
      }
      const publications = [];
      const observationCutoff = utc(now());
      if (observationCutoff < cutoff) fail('observation_clock_precedes_event_cutoff');
      for (const scope of config.scopes) publications.push(await publish(scope, cutoff, observationCutoff));
      return { state: 'published', progress, publications };
    });
  }
  async function applyCorrection({ requestId, expectedVersion, factId, operatorId, approvalReceipt }) {
    return serialize(async () => {
      if (stopped) fail('pipeline_stopped');
      if (!await approved() || !await authorizeCorrection({ requestId, expectedVersion, factId, operatorId, approvalReceipt })) fail('correction_not_authorized');
      const operationBinding = { requestId, expectedVersion, factId, operatorId, approvalReceipt };
      const priorCorrection = (await db.query('SELECT document FROM leaderboard_pipeline.corrections WHERE request_id=$1', [requestId])).rows[0]?.document;
      if (priorCorrection && c.metrics.stableJSON(priorCorrection.operation) !== c.metrics.stableJSON(operationBinding)) fail('correction_retry_mismatch');
      const state = controlsStore.read(), request = state.requests[requestId];
      if (!request || request.kind !== 'correction' || !['pending', 'applied'].includes(request.status) || request.owner === operatorId || (request.status !== 'applied' && request.version !== expectedVersion)) fail('correction_request_conflict');
      required(approvalReceipt, 'correction_approval_required');
      if (request.status === 'applied' && !priorCorrection) fail('missing_applied_correction_receipt');
      const documents = (await db.query('SELECT document FROM leaderboard_pipeline.normalizations')).rows.map(row => row.document);
      const fact = documents.flatMap(document => document.facts).find(fact => fact.id === factId);
      const evidence = documents.flatMap(document => document.evidence).find(entry => entry.contribution.contributionId === factId);
      if (!fact || !evidence || request.locator !== evidence.artifact.publicUrl) fail('correction_evidence_mismatch');
      const corrected = priorCorrection?.fact ?? { ...fact, revision: fact.revision + 1, state: 'excluded', correctionReceipt: approvalReceipt, observedAt: utc(now()) };
      const receiptId = await db.transaction(async tx => {
        const available = await tx.query("SELECT repository_id FROM leaderboard_ingestion.repository_access WHERE repository_id=$1 AND state='public' FOR UPDATE", [Number(fact.repoId)]);
        if (!available.rows.length) fail('correction_source_unavailable');
        await tx.query(`INSERT INTO leaderboard_pipeline.corrections (request_id,fact_id,artifact_id,repository_id,document)
          VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (request_id) DO NOTHING`, [requestId, fact.id, fact.artifactId, Number(fact.repoId), JSON.stringify({ fact: corrected, operation: operationBinding })]);
        const persisted = (await tx.query('SELECT document FROM leaderboard_pipeline.corrections WHERE request_id=$1 FOR UPDATE', [requestId])).rows[0];
        if (c.metrics.stableJSON(persisted.document.operation) !== c.metrics.stableJSON(operationBinding)) fail('correction_retry_mismatch');
        return receipt(tx, `correction:${requestId}:${expectedVersion}`, 'correction_applied', { requestId, factId, operatorId, approvalReceipt });
      });
      // DB overlay already denies the affected artifact if this separate controls transaction fails.
      if (request.status !== 'applied') controlsStore.transaction(current => {
        const target = current.requests[requestId];
        if (target.status === 'applied') return;
        if (target.version !== expectedVersion) fail('correction_request_conflict');
        target.status = 'applied';
        c.controls.record(current, target, operatorId, 'pipeline-correction-applied', Date.parse(now()), { receiptId });
      }, { publish: true });
      return { receiptId, requestId, status: 'applied' };
    });
  }
  async function start({ public: publicAddress = { host: '127.0.0.1', port: 0 }, webhook, controls } = {}) {
    if (stopped) fail('pipeline_stopped');
    const allowed = await approved();
    if (dataMode === 'synthetic' && [publicAddress, webhook, controls].filter(Boolean).some(address => !['127.0.0.1','::1','localhost'].includes(address.host))) fail('synthetic_runtime_requires_loopback');
    await app.listen(publicAddress);
    try {
      if (webhook) {
        if (!allowed || !options.webhookSecrets?.length) fail('webhook_configuration_required');
        const scope = new Map();
        for (const repo of config.repositories) { const ids = scope.get(repo.installationId) ?? new Set(); ids.add(repo.id); scope.set(repo.installationId, ids); }
        webhookServer = c.ingestion.createIngestionServer({ secrets: options.webhookSecrets, scope, store: inbox, lifecycle: collection });
        workerController = new AbortController();
        workerPromise = c.ingestion.runWorker(inbox, { signal: workerController.signal, idleMs: 100, failureBackoffMs: 1000 });
        await new Promise((resolve, reject) => { webhookServer.once('error', reject); webhookServer.listen(webhook.port, webhook.host, resolve); });
      }
      if (controls) {
        if (!options.controlsAuthentication) fail('controls_authentication_required');
        controlsServer = c.controls.createControlsServer({ ...options.controlsAuthentication, store: controlsStore });
        await new Promise((resolve, reject) => { controlsServer.once('error', reject); controlsServer.listen(controls.port, controls.host, resolve); });
      }
      return { public: app.server.address(), webhook: webhookServer?.address() ?? null, controls: controlsServer?.address() ?? null };
    } catch (error) { await stop(); throw error; }
  }
  function stop() {
    if (stopping) return stopping;
    stopped = true; controller?.abort(); workerController?.abort();
    stopping = (async () => {
      if (runner) await runner;
      if (workerPromise) await workerPromise;
      await operation;
      await Promise.all([app.close(), ...[webhookServer, controlsServer].filter(server => server?.listening).map(server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))]);
    })();
    return stopping;
  }
  function run({ intervalMs = 60000 } = {}) {
    if (runner || stopped || !Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) fail('invalid_pipeline_runner');
    controller = new AbortController();
    runner = (async () => {
      while (!controller.signal.aborted) {
        try { await runOnce(); } catch { /* durable source/pipeline receipts preserve retry state; health reads fail closed */ }
        try { await delay(intervalMs, undefined, { signal: controller.signal }); } catch { if (!controller.signal.aborted) throw new Error('pipeline_wait_failed'); }
      }
    })();
    return runner;
  }
  return { app, source, collection, inbox, runOnce, applyCorrection, start, stop, run,
    diagnostics: repositoryId => collection.diagnostics(repositoryId),
    operationalStatus(repositoryId, stage = 'collection') { return options.monitor?.status(monitorSource(repositoryId), stage) ?? { state:'unknown',lagMs:null,revision:null }; },
    async receipts() { return (await db.query('SELECT receipt_id,kind,document FROM leaderboard_pipeline.receipts ORDER BY created_at,receipt_id')).rows; } };
}
