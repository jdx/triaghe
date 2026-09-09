/**
 * Regression tests for closed-thread reactivation.
 *
 * This is the ordering that the whole notification replacement rests on: a
 * closed or answered thread is `done` until somebody turns up after GitHub
 * resolved it, and stops being `needs_you` once the owner has answered them.
 * Every branch here fails silently if it regresses — the item simply stops
 * appearing, which is indistinguishable from there being nothing to see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeState } from '../src/state.mjs';

const CLOSED_AT = '2026-06-01T00:00:00Z';

/** A closed issue whose last inbound activity is `spokeAt`, by a real person. */
const closed = (spokeAt, over = {}) => ({
  id: 'o/r#issue#1',
  kind: 'issue',
  state: 'CLOSED',
  author: 'alice',
  created_at: '2026-05-01T00:00:00Z',
  resolved_at: CLOSED_AT,
  last_human_at: spokeAt,
  last_human_actor: 'alice',
  last_actor_at: spokeAt,
  last_actor: 'alice',
  last_owner_at: null,
  ...over,
});

test('a comment after the thread was closed reopens it', () => {
  const s = computeState(closed('2026-06-02T00:00:00Z'), null);
  assert.equal(s.state, 'needs_you');
  assert.match(s.reason, /alice/);
  assert.match(s.reason, /closed/);
});

test('a comment before the thread was closed does not reopen it', () => {
  const s = computeState(closed('2026-05-20T00:00:00Z'), null);
  assert.equal(s.state, 'done',
    'the conversation that led to the close is not new traffic');
});

test('a comment at the exact moment of closing does not reopen it', () => {
  const s = computeState(closed(CLOSED_AT), null);
  assert.equal(s.state, 'done', 'reactivation is strictly after, not at');
});

test('an owner reply after the reactivating comment clears it', () => {
  const s = computeState(
    closed('2026-06-02T00:00:00Z', { last_owner_at: '2026-06-03T00:00:00Z' }),
    null,
  );
  assert.equal(s.state, 'done', 'answering it is what makes it stop asking');
});

test('an owner reply before the reactivating comment does not clear it', () => {
  const s = computeState(
    closed('2026-06-04T00:00:00Z', { last_owner_at: '2026-06-03T00:00:00Z' }),
    null,
  );
  assert.equal(s.state, 'needs_you', 'they replied after you did');
});

test('an answered discussion reactivates on later activity too', () => {
  const item = closed('2026-06-02T00:00:00Z', {
    kind: 'discussion',
    state: 'OPEN',
    is_answered: 1,
    resolved_at: CLOSED_AT,
  });
  assert.equal(computeState(item, null).state, 'needs_you');
  assert.equal(computeState({ ...item, last_human_at: '2026-05-02T00:00:00Z', last_actor_at: '2026-05-02T00:00:00Z' }, null).state, 'done');
});

test('a resolved thread with no resolution timestamp stays done', () => {
  const s = computeState(closed('2026-06-02T00:00:00Z', { resolved_at: null }), null);
  assert.equal(s.state, 'done',
    'without an ordering to compare against, guessing reopens everything');
});

test('a mark sticks until activity lands after it', () => {
  const item = closed('2026-06-02T00:00:00Z');
  const marked = { outcome: 'ignored', marked_at_activity: '2026-06-02T00:00:00Z' };
  assert.equal(computeState(item, marked).state, 'done');

  const later = closed('2026-06-05T00:00:00Z');
  assert.equal(computeState(later, marked).state, 'needs_you',
    'new traffic after a dismissal is the case the dismissal cannot speak for');
});

test('a snooze outranks reactivation until it expires', () => {
  const item = closed('2026-06-02T00:00:00Z');
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.equal(computeState(item, { snoozed_until: future }).state, 'snoozed');
  assert.equal(computeState(item, { snoozed_until: past }).state, 'needs_you');
});

test('bot activity on a closed thread still reopens it, and reads as automated', () => {
  const item = closed('2026-06-02T00:00:00Z', {
    last_human_at: null,
    last_human_actor: null,
    last_actor: 'renovate',
  });
  const s = computeState(item, null);
  assert.equal(s.state, 'needs_you');
  assert.match(s.reason, /renovate/);
});
