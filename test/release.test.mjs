/**
 * Regression tests for keeping release PRs out of the inbox.
 *
 * The failure mode being guarded against is a silent one in both directions: a
 * release PR that leaks back into the inbox is noise nobody reports, and an
 * ordinary PR misfiled as a release disappears from the only list that gets
 * read. The rule therefore has to be exact about which titles count and who
 * wrote them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeState } from '../src/state.mjs';
import { isReleasePr } from '../src/config.mjs';

/** An open PR nobody has answered, which would otherwise be `needs_you`. */
const openPr = (over = {}) => ({
  id: 'o/r#pr#1',
  kind: 'pr',
  state: 'OPEN',
  title: 'chore: release v1.35.2',
  author: 'mise-en-dev',
  author_is_bot: 1,
  labels: '[]',
  created_at: '2026-06-01T00:00:00Z',
  last_actor: 'mise-en-dev',
  last_actor_at: '2026-06-01T00:00:00Z',
  last_owner_at: null,
  ...over,
});

test('a labelled release PR leaves the inbox', () => {
  const s = computeState(openPr({ labels: '["release"]' }), null);
  assert.equal(s.state, 'release');
});

test('an unlabelled release PR from a bot leaves the inbox too', () => {
  // jdx/fnox#813 carried no labels at all while jdx/usage and jdx/mise carried
  // `release`, same bot, same kind of PR. Matching only the label would have
  // left a third of them behind.
  const s = computeState(openPr({ labels: '[]' }), null);
  assert.equal(s.state, 'release', 'the label is not applied consistently enough to rely on');
});

test('a person writing about releases stays in the inbox', () => {
  const mine = openPr({
    title: 'docs: explain the release process',
    author: 'alice',
    author_is_bot: 0,
    last_actor: 'alice',
    last_human_at: '2026-06-01T00:00:00Z',
    last_human_actor: 'alice',
  });
  assert.equal(computeState(mine, null).state, 'needs_you');

  // Even the exact release wording, when a human wrote it: a person chose to
  // open this and is waiting on a review.
  const theirs = { ...mine, title: 'release: cut 2.0 by hand' };
  assert.equal(computeState(theirs, null).state, 'needs_you');
});

test('a fix to release machinery is not a release', () => {
  assert.equal(isReleasePr({
    kind: 'pr', title: 'fix(release): handle a missing tag', author_is_bot: 1, labels: '[]',
  }), false);
});

test('an issue is never a release, whatever it is called', () => {
  assert.equal(isReleasePr({
    kind: 'issue', title: 'chore: release v1.0.0', author_is_bot: 1, labels: '["release"]',
  }), false);
});

test('labels are accepted parsed or raw', () => {
  const base = { kind: 'pr', title: 'anything', author_is_bot: 0 };
  assert.equal(isReleasePr({ ...base, labels: ['Release'] }), true, 'case-insensitive');
  assert.equal(isReleasePr({ ...base, labels: '["release"]' }), true, 'JSON as read from D1');
  assert.equal(isReleasePr({ ...base, labels: null }), false, 'a null column is not a crash');
});

test('merging a release PR reads as done, not as a pending release', () => {
  // The release lane sits after the resolved branch on purpose: merging one is
  // how the release happens, so it should settle like anything else rather than
  // accumulate in a tab forever.
  const merged = openPr({
    state: 'MERGED',
    labels: '["release"]',
    resolved_at: '2026-06-02T00:00:00Z',
  });
  assert.equal(computeState(merged, null).state, 'done');
});

test('an explicit mark still wins over the release lane', () => {
  const s = computeState(openPr({ labels: '["release"]' }), {
    outcome: 'ignored',
    marked_at_activity: '2026-06-02T00:00:00Z',
  });
  assert.equal(s.state, 'done', 'triage the owner performed by hand outranks a category rule');
});

test('a snooze still wins over the release lane', () => {
  const until = new Date(Date.now() + 86400000).toISOString();
  const s = computeState(openPr({ labels: '["release"]' }), { snoozed_until: until });
  assert.equal(s.state, 'snoozed');
});
