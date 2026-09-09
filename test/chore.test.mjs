/**
 * Regression tests for "automation never creates inbox work".
 *
 * The measurement that produced this change: a hand-cleared inbox went from 6
 * items to 12 in ninety minutes, and nine of the twelve were there because a
 * bot had spoken. Two were items the owner had marked done an hour earlier.
 * An inbox that refills itself is one nobody trusts enough to empty, so these
 * tests are less about any single classification than about that property
 * holding under the traffic these repositories actually get.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeState } from '../src/state.mjs';

/** A dependency PR nobody has touched: the shape most of the volume takes. */
const renovate = (over = {}) => ({
  id: 'o/r#pr#1',
  kind: 'pr',
  state: 'OPEN',
  title: 'chore(deps): update rust crate keepass to v0.13.25',
  author: 'renovate',
  author_is_bot: 1,
  labels: '[]',
  created_at: '2026-06-01T00:00:00Z',
  last_actor: 'renovate',
  last_actor_at: '2026-06-01T00:00:00Z',
  last_owner_at: null,
  ...over,
});

/** A contributor's PR that review bots have since commented on. */
const contributor = (over = {}) => ({
  ...renovate(),
  title: 'fix: handle empty config',
  author: 'alice',
  author_is_bot: 0,
  last_human_at: '2026-06-01T00:00:00Z',
  last_human_actor: 'alice',
  ...over,
});

test('a dependency PR is a chore, not an inbox item', () => {
  const s = computeState(renovate(), null);
  assert.equal(s.state, 'chore');
  assert.match(s.reason, /renovate/);
});

test('a chore yields to a person, on the same terms a release does', () => {
  // "This bump breaks the macOS build" belongs in the inbox no matter who
  // opened the PR.
  const s = computeState(renovate({
    last_human_at: '2026-06-02T00:00:00Z',
    last_human_actor: 'alice',
    last_actor: 'alice',
    last_actor_at: '2026-06-02T00:00:00Z',
  }), null);
  assert.equal(s.state, 'needs_you');
  // The owner has never spoken on it, so the reason is "no reply yet" rather
  // than naming alice — that wording is reserved for a reply *after* the owner.
  assert.match(s.reason, /no reply yet/);
});

test('a chore the owner already answered goes back to being a chore', () => {
  const s = computeState(renovate({
    last_human_at: '2026-06-02T00:00:00Z',
    last_human_actor: 'alice',
    last_owner_at: '2026-06-03T00:00:00Z',
  }), null);
  assert.equal(s.state, 'chore');
});

test('review-bot chatter does not pull a contributor PR back to the inbox', () => {
  // Socket, Greptile and CodeRabbit comment on essentially every PR here. The
  // owner having answered is what settles it; a bot talking afterwards is not
  // the contributor coming back.
  const answered = contributor({
    last_owner_at: '2026-06-02T00:00:00Z',
    last_actor: 'socket-security',
    last_actor_at: '2026-06-03T00:00:00Z',
    last_actor_is_bot: 1,
  });
  const s = computeState(answered, null);
  assert.equal(s.state, 'awaiting_them');
  assert.match(s.reason, /you spoke last/);
});

test('a mark is not undone by a bot, and is undone by a person', () => {
  // The largest single source of the refill: marking something done records the
  // activity it was cleared at, and any later activity used to reverse that.
  // Socket posting a scan report an hour later was overturning the owner's own
  // decision.
  const marked = { outcome: 'closed', marked_at_activity: '2026-06-01T00:00:00Z' };

  const botSpoke = computeState(contributor({
    last_actor: 'socket-security',
    last_actor_at: '2026-06-02T00:00:00Z',
    last_actor_is_bot: 1,
    last_human_at: '2026-06-01T00:00:00Z',
  }), marked);
  assert.equal(botSpoke.state, 'done', 'a robot may not overturn a decision the owner made');

  const personSpoke = computeState(contributor({
    last_human_at: '2026-06-02T00:00:00Z',
    last_human_actor: 'alice',
  }), marked);
  assert.equal(personSpoke.state, 'needs_you', 'but a person turning up still reopens it');
  assert.match(personSpoke.reason, /alice/);
});

test('an item automation opened and closed is done, not a chore', () => {
  // The chore lane sits after the resolved branch for the same reason the
  // release lane does: merging one is the point, so a merged one should settle.
  const s = computeState(renovate({ state: 'MERGED', resolved_at: '2026-06-02T00:00:00Z' }), null);
  assert.equal(s.state, 'done');
});

test('the owner\'s own PR no longer reads as automated', () => {
  // The old wording was "automated (jdx) — needs a merge or a close" on the
  // owner's own pull requests: it named the author while describing the actor,
  // so it was wrong twice over.
  const mine = contributor({
    author: 'jdx',
    author_is_bot: 0,
    last_human_at: null,
    last_human_actor: null,
    last_owner_at: '2026-06-01T00:00:00Z',
    last_actor: 'coderabbitai',
    last_actor_at: '2026-06-02T00:00:00Z',
    last_actor_is_bot: 1,
  });
  const s = computeState(mine, null);
  assert.doesNotMatch(s.reason, /automated \(jdx\)/);
  assert.match(s.reason, /coderabbitai/, 'the reason names who actually spoke');
});

test('the owner\'s own open PR is inbox work', () => {
  // Stated rather than derived. After the change above nothing else would put
  // it here: only CI and review bots speak on most of them, and a bot speaking
  // now means nothing. It is the one inbox entry that is not somebody waiting —
  // it is the owner's own unfinished work.
  const mine = renovate({
    author: 'jdx',
    author_is_bot: 0,
    title: 'perf(history): rebuild index metadata with gix',
    last_owner_at: '2026-06-01T00:00:00Z',
    last_actor: 'coderabbitai',
    last_actor_at: '2026-06-02T00:00:00Z',
    last_actor_is_bot: 1,
  });
  const s = computeState(mine, null, 'jdx');
  assert.equal(s.state, 'needs_you');
  assert.match(s.reason, /your PR/);
});

test('a draft of the owner\'s says so', () => {
  const draft = renovate({ author: 'jdx', author_is_bot: 0, is_draft: 1 });
  assert.match(computeState(draft, null, 'jdx').reason, /your draft/);
});

test('the owner\'s merged PR is done, not still open', () => {
  const merged = renovate({
    author: 'jdx',
    author_is_bot: 0,
    state: 'MERGED',
    resolved_at: '2026-06-02T00:00:00Z',
  });
  assert.equal(computeState(merged, null, 'jdx').state, 'done',
    'the lane has to drain, or it is just another list that grows');
});

test('a person waiting on the owner\'s PR outranks "still open"', () => {
  const asked = renovate({
    author: 'jdx',
    author_is_bot: 0,
    last_owner_at: '2026-06-01T00:00:00Z',
    last_human_at: '2026-06-02T00:00:00Z',
    last_human_actor: 'alice',
  });
  const s = computeState(asked, null, 'jdx');
  assert.equal(s.state, 'needs_you');
  assert.match(s.reason, /alice/, 'a question on your own PR still reads as the question');
});

test('an issue the owner opened is not treated as work in flight', () => {
  // Deliberately PRs only. An issue somebody opens on their own repository is
  // usually a note to themselves; an open PR is unfinished work.
  const note = renovate({
    author: 'jdx', author_is_bot: 0, kind: 'issue', last_owner_at: '2026-06-01T00:00:00Z',
  });
  assert.notEqual(computeState(note, null, 'jdx').state, 'needs_you');
});

test('someone else\'s PR is not the owner\'s to finish', () => {
  const theirs = renovate({
    author: 'alice',
    author_is_bot: 0,
    last_owner_at: '2026-06-02T00:00:00Z',
    last_actor: 'socket-security',
    last_actor_at: '2026-06-03T00:00:00Z',
    last_actor_is_bot: 1,
    last_human_at: '2026-06-01T00:00:00Z',
    last_human_actor: 'alice',
  });
  assert.equal(computeState(theirs, null, 'jdx').state, 'awaiting_them');
});
