import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { replayTransitions, transitionFromDelivery } from '../dist/index.js';

const fixture = JSON.parse(await readFile(new URL('../../../tests/fixtures/event-replay.json', import.meta.url), 'utf8'));
const base = fixture.events[0];
const event = (eventId, extra = {}) => ({ ...base, eventId, ...extra });
function* permutations(items) {
  if (!items.length) { yield []; return; }
  for (let i = 0; i < items.length; i++) {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...rest];
  }
}

test('all 120 arrival permutations converge across reopened lifecycle and label add/remove histories', () => {
  assert.equal(fixture.synthetic, true);
  const expected = replayTransitions(fixture.events);
  let count = 0;
  for (const input of permutations(fixture.events)) { assert.deepEqual(replayTransitions(input), expected); count++; }
  assert.equal(count, 120);
  assert.equal(expected.facets.find(facet => facet.facet === 'lifecycle').value, 'open');
  const label = expected.facets.find(facet => facet.facet.startsWith('label:'));
  assert.equal(label.state, 'known');
  assert.equal(label.value, null);
  const { digest, ...hashed } = expected;
  assert.equal(digest, createHash('sha256').update(JSON.stringify(hashed)).digest('hex'));
});

test('missing event/effective times never become observation times or ID order', () => {
  const input = [event('z', { occurredAt: null, effectiveAt: null, value: 'open' }),
    event('a', { occurredAt: null, effectiveAt: null, observedAt: '2099-01-01T00:00:00Z', value: 'closed' })];
  const result = replayTransitions(input);
  assert.equal(result.facets[0].state, 'ambiguous');
  assert.equal(result.facets[0].value, null);
  assert.ok(result.events.every(item => item.occurredAt === null && item.effectiveAt === null));
  assert.deepEqual(result.facets[0].candidateEventIds, ['a', 'z']);
});

test('equal source times remain ambiguous while explicit source order resolves a tie', () => {
  const open = event('open');
  const close = event('close', { value: 'closed' });
  assert.equal(replayTransitions([open, close]).facets[0].state, 'ambiguous');
  assert.equal(replayTransitions([open, { ...close, afterEventIds: ['open'] }]).facets[0].value, 'closed');
});

test('source occurrence time and effective time remain distinct', () => {
  const corrected = event('corrected', { occurredAt: '2026-01-10T00:00:00Z', effectiveAt: '2026-01-01T00:00:00Z' });
  const closed = event('closed', { value: 'closed', effectiveAt: '2026-01-02T00:00:00Z' });
  assert.equal(replayTransitions([closed, corrected]).facets[0].value, 'closed');
});

test('correction chains replace assertions, preserve evidence and inherit explicit predecessor/successor edges', () => {
  const a = event('a', { occurredAt: null, effectiveAt: null });
  const b = event('b', { occurredAt: null, effectiveAt: null, value: 'closed', afterEventIds: ['a'] });
  const c = event('c', { occurredAt: null, effectiveAt: null, afterEventIds: ['b'] });
  const fix = event('fix', { occurredAt: null, effectiveAt: null, supersedesEventIds: ['b'], value: 'open' });
  const fix2 = event('fix2', { occurredAt: null, effectiveAt: null, supersedesEventIds: ['fix'], value: 'closed' });
  const expected = replayTransitions([a, b, c, fix, fix2]);
  for (const input of permutations([a, b, c, fix, fix2])) assert.deepEqual(replayTransitions(input), expected);
  assert.equal(expected.events.length, 5);
  assert.equal(expected.facets[0].state, 'known');
  assert.deepEqual(expected.facets[0].candidateEventIds, ['c']);
});

test('missing evidence references are incomplete, cross-facet references and cycles are conflicted', () => {
  assert.equal(replayTransitions([event('a', { afterEventIds: ['missing'] })]).facets[0].state, 'incomplete');
  assert.equal(replayTransitions([event('a', { supersedesEventIds: ['missing'] })]).facets[0].state, 'incomplete');
  const cross = replayTransitions([event('a'), event('b', { facet: 'different', afterEventIds: ['a'] })]);
  assert.equal(cross.facets.find(facet => facet.facet === 'different').state, 'conflicted');
  const loop = replayTransitions([event('a', { afterEventIds: ['b'] }), event('b', { afterEventIds: ['a'] })]);
  assert.equal(loop.facets[0].state, 'conflicted');
  assert.ok(loop.facets[0].reasonCodes.includes('ordering_cycle'));
  const correction = replayTransitions([event('a', { supersedesEventIds: ['b'] }), event('b', { supersedesEventIds: ['a'] })]);
  assert.equal(correction.facets[0].state, 'conflicted');
});

test('competing corrections require reconciliation; a later explicit correction can reconcile both', () => {
  const original = event('original');
  const first = event('first', { supersedesEventIds: ['original'] });
  const second = event('second', { supersedesEventIds: ['original'], value: 'closed' });
  assert.equal(replayTransitions([original, first, second]).facets[0].state, 'conflicted');
  const merged = event('merged', { supersedesEventIds: ['first', 'second'] });
  assert.equal(replayTransitions([original, first, second, merged]).facets[0].state, 'known');
});

test('contradictory temporal and explicit ordering evidence cannot choose a winner', () => {
  const earlier = event('earlier', { afterEventIds: ['later'] });
  const later = event('later', { effectiveAt: '2026-01-02T00:00:00Z', value: 'closed' });
  assert.equal(replayTransitions([earlier, later]).facets[0].state, 'conflicted');
});

test('identical duplicates do not change replay but conflicting IDs fail closed', () => {
  assert.deepEqual(replayTransitions([base, base]), replayTransitions([base]));
  assert.throws(() => replayTransitions([base, { ...base, value: 'closed' }]), /conflicting_event_id/);
});

test('empty and malformed inputs, impossible dates, payload fields, self-edges and bounds', () => {
  assert.deepEqual(replayTransitions([]).facets, []);
  for (const invalid of [null, {}, { ...base, version: 'unknown' }, { ...base, body: 'synthetic-sensitive' },
    { ...base, observedAt: null }, { ...base, effectiveAt: '2026-02-30T00:00:00Z' },
    { ...base, afterEventIds: [base.eventId] }, { ...base, evidenceIds: [] }]) {
    assert.throws(() => replayTransitions([invalid]), /invalid_transition/);
  }
  assert.throws(() => replayTransitions(Array(257).fill(base)), /replay_limit_exceeded/);
  for (const field of ['evidenceIds', 'afterEventIds', 'supersedesEventIds']) {
    assert.throws(() => replayTransitions([{ ...base, [field]: new Array(1) }]), /invalid_transition/);
  }
});

test('replay copies input and returns deterministic serialization without mutating callers', () => {
  const input = structuredClone(fixture.events);
  const prior = structuredClone(input);
  const result = replayTransitions(input);
  assert.deepEqual(input, prior);
  result.events[0].evidenceIds.push('synthetic-extra');
  assert.deepEqual(input, prior);
});

test('delivery adapter retains unknown reopen times and never treats an edit as lifecycle', () => {
  const envelope = { version: 'github-delivery/v1', deliveryId: 'synthetic-delivery', repositoryId: 2,
    subjectId: 'SYNTHETIC_ISSUE', event: 'issues', action: 'reopened', occurredAt: null };
  const reopened = transitionFromDelivery(envelope, '2026-01-10T00:00:00Z');
  assert.equal(reopened.value, 'open');
  assert.equal(reopened.effectiveAt, null);
  assert.equal(reopened.occurredAt, null);
  assert.equal(transitionFromDelivery({ ...envelope, action: 'edited' }, '2026-01-10T00:00:00Z'), null);
  assert.throws(() => transitionFromDelivery({ ...envelope, version: 'unknown' }, '2026-01-10T00:00:00Z'), /unsupported_delivery_version/);
  assert.throws(() => transitionFromDelivery({ ...envelope, event: 'push' }, '2026-01-10T00:00:00Z'), /invalid_transition/);
});
