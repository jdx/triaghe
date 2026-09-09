/**
 * Regression tests for taking things off the board, and for drafts.
 *
 * Both exist for the same reason: a board is only worth opening if what is on
 * it is what you actually have to deal with. One is the owner saying "not
 * this"; the other is the author saying "not yet".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeState } from '../src/state.mjs';
import { makeEnv, owner, seedItem } from './d1.mjs';
import { handleApi } from '../src/api.mjs';

const post = (env, path, body) =>
  handleApi(new Request(`https://x.test${path}`, { method: 'POST', body: JSON.stringify(body) }),
    env, {}, owner);

const get = (env, path) => handleApi(new Request(`https://x.test${path}`), env, {}, owner);

const draftPr = (over = {}) => ({
  id: 'o/r#pr#1',
  kind: 'pr',
  state: 'OPEN',
  title: 'wip: try something',
  author: 'alice',
  author_is_bot: 0,
  is_draft: 1,
  labels: '[]',
  created_at: '2026-06-01T00:00:00Z',
  last_actor: 'alice',
  last_actor_at: '2026-06-01T00:00:00Z',
  last_human_at: '2026-06-01T00:00:00Z',
  last_human_actor: 'alice',
  last_owner_at: null,
  ...over,
});

/* ---------- off the board ---------- */

test('dismissed takes an item off the board', async () => {
  const env = makeEnv();
  const id = seedItem(env);
  const res = await post(env, `/api/items/${encodeURIComponent(id)}/mark`, { outcome: 'dismissed' });
  assert.equal(res.status, 200);

  const inbox = await get(env, '/api/items?state=needs_you');
  assert.equal(inbox.body.items.length, 0);
});

test('dismissed is a dismissal, not an ignore', () => {
  // The distinction the owner asked for: it comes back when something happens,
  // rather than being a decision that has to be revisited by hand.
  const marked = { outcome: 'dismissed', marked_at_activity: '2026-06-01T00:00:00Z' };
  const item = {
    ...draftPr({ is_draft: 0 }),
    last_human_at: '2026-06-05T00:00:00Z',
    last_human_actor: 'alice',
  };
  const s = computeState(item, marked, 'jdx');
  assert.equal(s.state, 'needs_you');
  assert.match(s.reason, /alice/);
});

test('dismissed survives bot chatter, like every other outcome', () => {
  const marked = { outcome: 'dismissed', marked_at_activity: '2026-06-01T00:00:00Z' };
  const noisy = draftPr({
    is_draft: 0,
    last_actor: 'socket-security',
    last_actor_at: '2026-06-05T00:00:00Z',
    last_actor_is_bot: 1,
  });
  assert.equal(computeState(noisy, marked, 'jdx').state, 'done');
});

test('dismissing a mention clears it from the Mentions list and the badge', async () => {
  // The failure this repeats: an outcome that stops the badge counting an item
  // but leaves it in the list makes the board contradict itself.
  const env = makeEnv();
  const id = seedItem(env);
  env.raw.prepare(`UPDATE items SET last_mention_at=?, last_mention_actor='alice',
    last_human_at=?, last_human_actor='alice' WHERE id=?`)
    .run('2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', id);

  await post(env, `/api/items/${encodeURIComponent(id)}/mark`, { outcome: 'dismissed' });

  const stats = await get(env, '/api/stats');
  const list = await get(env, '/api/items?state=all&mentions=1');
  assert.equal(stats.body.mentions, 0);
  assert.equal(list.body.items.length, 0);
});

/* ---------- drafts ---------- */

test('somebody else\'s draft is not on the board', () => {
  assert.equal(computeState(draftPr(), null, 'jdx').state, 'draft');
});

test('marking it ready brings it back, and re-drafting removes it again', () => {
  // No state of ours to keep in step: is_draft is refreshed on every poll, so
  // this follows GitHub in both directions on its own.
  const ready = draftPr({ is_draft: 0 });
  assert.equal(computeState(ready, null, 'jdx').state, 'needs_you');
  assert.equal(computeState({ ...ready, is_draft: 1 }, null, 'jdx').state, 'draft');
});

test('a draft that tags the owner still reaches the inbox', () => {
  // "Never show me drafts" and "someone is trying to reach me" can both be
  // true. Both the Mentions filter and the badge require needs_you, so an
  // unconditional draft lane would make tagging the owner from a draft the one
  // reliable way to be invisible.
  const asked = draftPr({
    last_mention_at: '2026-06-02T00:00:00Z',
    last_mention_actor: 'alice',
  });
  assert.equal(computeState(asked, null, 'jdx').state, 'needs_you');
});

test('an ordinary comment on a draft is not enough to surface it', () => {
  // Being tagged is a request; a comment is work in progress out loud.
  const chatty = draftPr({
    last_human_at: '2026-06-05T00:00:00Z',
    last_human_actor: 'alice',
    last_actor_at: '2026-06-05T00:00:00Z',
  });
  assert.equal(computeState(chatty, null, 'jdx').state, 'draft');
});

test('a mention the owner already answered does not keep a draft visible', () => {
  const answered = draftPr({
    last_mention_at: '2026-06-02T00:00:00Z',
    last_mention_actor: 'alice',
    last_owner_at: '2026-06-03T00:00:00Z',
  });
  assert.equal(computeState(answered, null, 'jdx').state, 'draft');
});

test('the owner\'s own draft is still theirs to finish', () => {
  // Excluded by name rather than by branch order. Relying on the owner check
  // above to run first was wrong the moment somebody commented: that branch
  // yields to a person waiting, and the draft lane then swallowed the item.
  const mine = draftPr({
    author: 'jdx', last_human_at: null, last_human_actor: null, last_actor: 'jdx',
  });
  const s = computeState(mine, null, 'jdx');
  assert.equal(s.state, 'needs_you');
  assert.match(s.reason, /your draft/);

  // And a person waiting on it still reads as that person, not as a draft.
  const asked = draftPr({ author: 'jdx', last_owner_at: '2026-06-01T00:00:00Z',
    last_human_at: '2026-06-02T00:00:00Z', last_human_actor: 'alice' });
  const s2 = computeState(asked, null, 'jdx');
  assert.equal(s2.state, 'needs_you');
  assert.match(s2.reason, /alice/);
});

test('a merged draft is done, not a draft', () => {
  const merged = draftPr({ state: 'MERGED', resolved_at: '2026-06-02T00:00:00Z' });
  assert.equal(computeState(merged, null, 'jdx').state, 'done');
});
