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

test('nothing puts a release PR back in the inbox, not even a person', () => {
  // The reverse of what this asserted before, on the owner's explicit
  // instruction — given three times and escalating — that they do not want to
  // see release PRs at all.
  //
  // The cost is real and is recorded here rather than in a commit message
  // nobody will read again: a contributor commenting "this bump breaks the
  // macOS build", or tagging the owner directly, will not reach the inbox or
  // the Mentions badge, because both require `needs_you`. The feed still shows
  // it. Restoring the old behaviour is `&& !personWaiting` on one line of
  // computeState.
  const asked = openPr({
    labels: '["release"]',
    last_actor: 'alice',
    last_actor_at: '2026-06-02T00:00:00Z',
    last_human_at: '2026-06-02T00:00:00Z',
    last_human_actor: 'alice',
    last_owner_at: '2026-06-01T12:00:00Z',
    last_mention_at: '2026-06-02T00:00:00Z',
    last_mention_actor: 'alice',
  });
  assert.equal(computeState(asked, null).state, 'release');
});

test('a release PR the owner already answered goes back to being a chore', () => {
  const answered = openPr({
    labels: '["release"]',
    last_human_at: '2026-06-02T00:00:00Z',
    last_human_actor: 'alice',
    last_owner_at: '2026-06-03T00:00:00Z',
    last_actor: 'jdx',
    last_actor_at: '2026-06-03T00:00:00Z',
  });
  assert.equal(computeState(answered, null).state, 'release');
});

test('bot chatter on a release PR does not pull it into the inbox', () => {
  // Greptile and friends comment on release PRs constantly. Only a person
  // counts as somebody waiting.
  const noisy = openPr({
    labels: '["release"]',
    last_actor: 'greptile-apps',
    last_actor_at: '2026-06-05T00:00:00Z',
    last_actor_is_bot: 1,
  });
  assert.equal(computeState(noisy, null).state, 'release');
});

test('the owner cutting their own release is still a release', () => {
  // Live: three of the four release PRs sitting in the inbox were opened by the
  // owner, not by a release bot. Running the owner rule first put every one of
  // them back where the lane exists to stop them going.
  const mine = openPr({ author: 'jdx', author_is_bot: 0, labels: '["release"]' });
  assert.equal(computeState(mine, null, 'jdx').state, 'release');

  // And without a label, which is the case a label-only rule misses. jdx/mise-
  // action, hk and mr-boxington-action carried `release`; mr-boxington#415,
  // titled just "chore: release", carried none.
  const unlabelled = openPr({
    author: 'jdx', author_is_bot: 0, labels: '[]', title: 'chore: release',
  });
  assert.equal(computeState(unlabelled, null, 'jdx').state, 'release');
});

test('a contributor writing about a release is not filed away', () => {
  // The gate admits a release bot and the owner, and nobody else. Neither of
  // those is waiting on a review; a contributor is.
  const theirs = openPr({
    author: 'alice', author_is_bot: 0, labels: '[]', title: 'release: cut 2.0 by hand',
    last_human_at: '2026-06-01T00:00:00Z', last_human_actor: 'alice',
  });
  assert.equal(computeState(theirs, null, 'jdx').state, 'needs_you');
});

test('the same holds for a release the owner cut themselves', () => {
  const asked = openPr({
    author: 'jdx',
    author_is_bot: 0,
    labels: '["release"]',
    last_owner_at: '2026-06-01T00:00:00Z',
    last_human_at: '2026-06-02T00:00:00Z',
    last_human_actor: 'alice',
  });
  assert.equal(computeState(asked, null, 'jdx').state, 'release');
});
