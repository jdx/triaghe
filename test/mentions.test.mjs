/**
 * Regression tests for mention coverage and dismissal.
 *
 * All three of these disagree with something the UI already shows — a badge, a
 * list, a feed — which is the failure mode that erodes trust fastest: the board
 * contradicting itself rather than being wrong in one place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, owner, seedItem } from './d1.mjs';
import { handleApi } from '../src/api.mjs';
import { mentionsOwner } from '../src/config.mjs';

const call = (env, path) =>
  handleApi(new Request(`https://x.test${path}`), env, {}, owner);

const post = (env, path, body) =>
  handleApi(new Request(`https://x.test${path}`, { method: 'POST', body: JSON.stringify(body) }),
    env, {}, owner);

/** An item somebody tagged the owner in, and nobody has answered. */
function seedMention(env, over = {}) {
  const id = seedItem(env, over);
  env.raw.prepare(`UPDATE items SET last_mention_at=?, last_mention_actor='alice',
    last_human_at=?, last_human_actor='alice', body_mentions_owner=? WHERE id=?`)
    .run('2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', over.body_mentions_owner ?? 1, id);
  return id;
}

test('@ matching is strict at both edges', () => {
  assert.equal(mentionsOwner('hey @jdx look', 'jdx'), true);
  assert.equal(mentionsOwner('thanks @JDX!', 'jdx'), true);
  assert.equal(mentionsOwner('ship@jdx.dev', 'jdx'), false, 'an address is not a mention');
  assert.equal(mentionsOwner('@jdxcode is someone else', 'jdx'), false);
  assert.equal(mentionsOwner('no tag here', 'jdx'), false);
});

test('an outstanding mention appears in the Mentions list and the badge', async () => {
  const env = makeEnv();
  seedMention(env);

  const list = await call(env, '/api/items?state=all&mentions=1');
  assert.equal(list.body.items.length, 1);

  const stats = await call(env, '/api/stats');
  assert.equal(stats.body.mentions, 1);
});

test('marking a mention responded removes it from the list, not just the badge', async () => {
  const env = makeEnv();
  const id = seedMention(env);

  await post(env, `/api/items/${encodeURIComponent(id)}/mark`, { outcome: 'responded' });

  const stats = await call(env, '/api/stats');
  const list = await call(env, '/api/items?state=all&mentions=1');

  assert.equal(stats.body.mentions, 0, 'badge stops counting it');
  assert.equal(list.body.items.length, 0,
    'and the list must agree — otherwise dismissal appears not to work');
});

test('snoozing a mention removes it from the list too', async () => {
  const env = makeEnv();
  const id = seedMention(env);
  await post(env, `/api/items/${encodeURIComponent(id)}/snooze`, { days: 7 });
  const list = await call(env, '/api/items?state=all&mentions=1');
  assert.equal(list.body.items.length, 0);
});

test('a mention in the opening post reaches the mentions feed', async () => {
  const env = makeEnv();
  seedMention(env, { body_mentions_owner: 1 });

  const feed = await call(env, '/api/feed?mentions=1');
  assert.equal(feed.body.events.length, 1,
    'an item opened with "Hi @you" showed in Mentions but had no feed event');
  assert.equal(feed.body.events[0].event, 'opened');
});

test('an opening post without a mention stays out of the mentions feed', async () => {
  const env = makeEnv();
  seedMention(env, { body_mentions_owner: 0 });
  const feed = await call(env, '/api/feed?mentions=1');
  assert.equal(feed.body.events.length, 0);
});

test('ignored is rejected without dismissing the mention', async () => {
  const env = makeEnv();
  const id = seedMention(env);
  const result = await post(env, `/api/items/${encodeURIComponent(id)}/mark`, { outcome: 'ignored' });
  assert.equal(result.status, 400);
  const list = await call(env, '/api/items?state=all&mentions=1');
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].outcome, null);
});
