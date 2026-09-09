/**
 * Regression tests for feed paging.
 *
 * The feed is the surface used to check that the poller is doing its job, so a
 * pager that repeats or drops rows while ingestion writes underneath it is
 * worse than no pager: it makes the audit view lie in exactly the direction
 * that hides a coverage problem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, owner, seedItem } from './d1.mjs';
import { handleApi } from '../src/api.mjs';

const call = (env, path) =>
  handleApi(new Request(`https://x.test${path}`), env, {}, owner);

function seedComment(env, itemId, ghId, at) {
  env.raw.prepare(`INSERT INTO comments (gh_id,item_id,author,author_is_bot,created_at,body,first_seen_at)
    VALUES (?,?,'alice',0,?,'hi',?)`).run(ghId, itemId, at, at);
}

/** Item opened long ago, so the `opened` event sorts below every comment. */
function seedThread(env, times) {
  const id = seedItem(env, { created_at: '2020-01-01T00:00:00Z' });
  times.forEach((at, i) => seedComment(env, id, `C_${i}`, at));
  return id;
}

test('paging by cursor does not repeat rows when new activity arrives', async () => {
  const env = makeEnv();
  const id = seedThread(env, [
    '2026-06-01T01:00:00Z',
    '2026-06-01T02:00:00Z',
    '2026-06-01T03:00:00Z',
    '2026-06-01T04:00:00Z',
  ]);

  const first = await call(env, '/api/feed?limit=2');
  assert.deepEqual(first.body.events.map((e) => e.gh_id), ['C_3', 'C_2']);
  assert.ok(first.body.next_cursor, 'a page with more behind it must say where it ended');

  // The poller runs between the two requests. With numeric offsets this shifts
  // every later row down by one and page two repeats C_2.
  seedComment(env, id, 'C_new', '2026-06-01T09:00:00Z');

  const second = await call(env, `/api/feed?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
  assert.deepEqual(second.body.events.map((e) => e.gh_id), ['C_1', 'C_0'],
    'the second page continues from where the first ended, not from a row count');
});

test('paging reaches every event exactly once', async () => {
  const env = makeEnv();
  seedThread(env, [
    '2026-06-01T01:00:00Z',
    '2026-06-01T02:00:00Z',
    '2026-06-01T03:00:00Z',
  ]);

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const res = await call(env, `/api/feed?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    seen.push(...res.body.events.map((e) => e.gh_id));
    if (!res.body.has_more) break;
    cursor = res.body.next_cursor;
  }

  // Three comments plus the `opened` event for the item itself.
  assert.deepEqual(seen, ['C_2', 'C_1', 'C_0', 'o/r#issue#1']);
  assert.equal(new Set(seen).size, seen.length, 'no event may appear on two pages');
});

test('events sharing a timestamp still page cleanly', async () => {
  const env = makeEnv();
  const at = '2026-06-01T01:00:00Z';
  seedThread(env, [at, at, at]);

  const first = await call(env, '/api/feed?limit=2');
  const second = await call(env, `/api/feed?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
  const seen = [...first.body.events, ...second.body.events].map((e) => e.gh_id);

  assert.deepEqual(seen, ['C_2', 'C_1', 'C_0', 'o/r#issue#1'],
    'a tie in the sort key needs a second key, or paging loops on it');
});

test('a malformed cursor returns the first page rather than nothing', async () => {
  const env = makeEnv();
  seedThread(env, ['2026-06-01T01:00:00Z']);
  const res = await call(env, '/api/feed?limit=5&cursor=garbage');
  assert.equal(res.body.events.length, 2);
});
