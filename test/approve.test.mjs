/**
 * Regression tests for the approve path.
 *
 * Every case here is a bug that shipped, was reproduced in review, and would be
 * invisible in normal use: they all require two actors racing, and they all fail
 * by posting the wrong thing to GitHub rather than by throwing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, owner, agent, seedItem, seedDraft, APP } from './d1.mjs';
import { handleApi } from '../src/api.mjs';

const req = (method, path, body) => new Request(`https://x.test${path}`, {
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

const call = (env, method, path, body, id = owner) =>
  handleApi(req(method, path, body), env, {}, id);

/** Swap in a postComment double by intercepting the GitHub write at fetch level. */
function countingFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init, calls.length);
  };
  return calls;
}

const okComment = () => new Response(
  JSON.stringify({ html_url: 'https://github.test/c/1' }),
  { status: 201, headers: { 'content-type': 'application/json' } },
);

/** Installation-token endpoint, then the comment create. */
const githubOk = async (url) => (url.includes('access_tokens')
  ? new Response(JSON.stringify({ token: 't', expires_at: '2099-01-01T00:00:00Z' }),
    { status: 201, headers: { 'content-type': 'application/json' } })
  : okComment());

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test('approving a revision the owner did not read is refused', async () => {
  const env = makeEnv(APP);
  const item = seedItem(env);
  const id = seedDraft(env, item);

  // The agent rewrites the draft after the owner's pane rendered revision 1.
  await call(env, 'POST', `/api/drafts/${id}/edit`, { body: 'text the owner never saw' }, agent);

  const calls = countingFetch(githubOk);
  const res = await call(env, 'POST', `/api/drafts/${id}/approve`, { expected_revision: 1 });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /changed since you read it/);
  assert.equal(calls.length, 0, 'nothing may be posted when the revision is stale');
});

test('approve requires an explicit revision', async () => {
  const env = makeEnv();
  const item = seedItem(env);
  const id = seedDraft(env, item);
  const res = await call(env, 'POST', `/api/drafts/${id}/approve`, {});
  assert.equal(res.status, 400);
});

test('only the owner may approve', async () => {
  const env = makeEnv();
  const item = seedItem(env);
  const id = seedDraft(env, item);
  const res = await call(env, 'POST', `/api/drafts/${id}/approve`, { expected_revision: 1 }, agent);
  assert.equal(res.status, 403);
});

test('two concurrent approvals post exactly once', async () => {
  const env = makeEnv(APP);
  const item = seedItem(env);
  const id = seedDraft(env, item);

  const calls = countingFetch(githubOk);

  const [a, b] = await Promise.all([
    call(env, 'POST', `/api/drafts/${id}/approve`, { expected_revision: 1 }),
    call(env, 'POST', `/api/drafts/${id}/approve`, { expected_revision: 1 }),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], 'one approval wins, the other is refused');

  const posts = calls.filter((c) => c.url.includes('/comments'));
  assert.equal(posts.length, 1, 'the comment must reach GitHub exactly once');
});

test('edit reports the revision its own UPDATE produced', async () => {
  const env = makeEnv();
  const item = seedItem(env);
  const id = seedDraft(env, item);

  const first = await call(env, 'POST', `/api/drafts/${id}/edit`, { body: 'owner-reviewed edit' });
  assert.equal(first.body.edited_revision, 2);

  // An agent edit lands afterwards. The owner's approval still names revision 2
  // and must therefore be refused, rather than silently approving revision 3.
  await call(env, 'POST', `/api/drafts/${id}/edit`, { body: 'unreviewed replacement' }, agent);

  const calls = countingFetch(githubOk);
  const res = await call(env, 'POST', `/api/drafts/${id}/approve`,
    { expected_revision: first.body.edited_revision });

  assert.equal(res.status, 409);
  assert.equal(calls.length, 0);
});

test('a draft that is no longer pending cannot be edited', async () => {
  const env = makeEnv();
  const item = seedItem(env);
  const id = seedDraft(env, item);
  await call(env, 'POST', `/api/drafts/${id}/reject`, {});
  const res = await call(env, 'POST', `/api/drafts/${id}/edit`, { body: 'too late' });
  assert.equal(res.status, 409);
});

test('a posted draft cannot be rejected afterwards', async () => {
  const env = makeEnv(APP);
  const item = seedItem(env);
  const id = seedDraft(env, item);

  countingFetch(githubOk);
  const approved = await call(env, 'POST', `/api/drafts/${id}/approve`, { expected_revision: 1 });
  assert.equal(approved.status, 200);

  // A stale tab clicking discard must not record a rejection for a draft that
  // is already on GitHub.
  const res = await call(env, 'POST', `/api/drafts/${id}/reject`, {});
  assert.equal(res.status, 409);

  const row = env.raw.prepare('SELECT status FROM drafts WHERE id=?').get(id);
  assert.equal(row.status, 'posted');
});

test('queue completion must name a draft belonging to its own item', async () => {
  const env = makeEnv();
  const mine = seedItem(env);
  const other = seedItem(env, { id: 'o/r#issue#2', number: 2 });
  const foreign = seedDraft(env, other);

  await call(env, 'POST', `/api/items/${encodeURIComponent(mine)}/draft-request`, {});
  const reqId = Number(env.raw.prepare('SELECT id FROM draft_requests WHERE item_id=?').get(mine).id);
  await call(env, 'POST', `/api/draft-requests/${reqId}/claim`, {}, agent);

  const missing = await call(env, 'POST', `/api/draft-requests/${reqId}/complete`, {}, agent);
  assert.equal(missing.status, 400, 'a success with no draft_id closes the request for nothing');

  const wrong = await call(env, 'POST', `/api/draft-requests/${reqId}/complete`,
    { draft_id: foreign }, agent);
  assert.equal(wrong.status, 400, 'a draft on another item is not this request being done');

  const still = env.raw.prepare('SELECT status FROM draft_requests WHERE id=?').get(reqId);
  assert.equal(still.status, 'claimed', 'the request must stay open, not silently close');
});
