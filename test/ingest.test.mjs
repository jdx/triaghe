/**
 * Regression tests for coverage guarantees.
 *
 * These are the failures that matter most once this replaces GitHub
 * notifications, because they are all silent: nothing errors, the board simply
 * knows less than it claims to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, APP } from './d1.mjs';
import { ingestOnce } from '../src/ingest.mjs';
import { graphql } from '../src/gh.mjs';

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/**
 * A GitHub search double. Records the `updated:` range and the paging cursor of
 * every request, so a test can assert that the poller actually moved — either
 * to a new window, or further into the one it had not finished.
 *
 * `threadFor` and `replyFor` answer the two queries the drain pass uses. Left
 * out, a thread reads as having no comment connection at all, which is how the
 * search tests stay about searching.
 */
function searchDouble(pagesFor, threadFor, replyFor) {
  const queries = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('access_tokens')) {
      return new Response(JSON.stringify({ token: 't', expires_at: '2099-01-01T00:00:00Z' }),
        { status: 201, headers: { 'content-type': 'application/json' } });
    }
    const { query, variables } = JSON.parse(init.body);
    if (/on DiscussionComment/.test(query)) {
      const replies = replyFor ? replyFor(variables) : null;
      return json({ data: { node: replies ? { replies } : null } });
    }
    if (/node\(id:/.test(query)) {
      const comments = threadFor ? threadFor(variables) : null;
      return json({ data: { node: comments ? { __typename: 'Discussion', comments } : null } });
    }
    queries.push({ q: variables.q, after: variables.after ?? null });
    const { nodes, hasNextPage, issueCount } = pagesFor(variables);
    return json({
      data: {
        search: {
          issueCount: issueCount ?? nodes.length,
          pageInfo: { hasNextPage, endCursor: `c${queries.length}` },
          nodes,
        },
      },
    });
  };
  return queries;
}

const node = (n, updatedAt) => ({
  __typename: 'Issue',
  id: `I_${n}`,
  number: n,
  title: `item ${n}`,
  url: `https://github.test/${n}`,
  body: '',
  state: 'OPEN',
  createdAt: updatedAt,
  updatedAt,
  locked: false,
  author: { login: 'alice', __typename: 'User' },
  authorAssociation: 'NONE',
  repository: { nameWithOwner: 'o/r' },
  labels: { nodes: [] },
  comments: { totalCount: 0, nodes: [] },
});

const comment = (id, at, body = '') => ({
  id, createdAt: at, body, author: { login: 'alice', __typename: 'User' },
});

const meta = (env, key) =>
  env.raw.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;

const setCheckpoint = (env, at) =>
  env.raw.prepare("INSERT INTO meta (key,value) VALUES ('last_ingest_at',?)").run(at);

test('a truncated window resumes rather than stepping over what it did not read', async () => {
  const env = makeEnv(APP);
  setCheckpoint(env, '2026-06-01T00:00:00Z');

  // Every result shares one timestamp and there is always another page: the
  // exact shape that used to make the checkpoint jump a second forward and
  // leave the rest of that second unfetched forever.
  const at = '2026-06-01T12:00:00Z';
  const queries = searchDouble(() => ({
    issueCount: 500, nodes: [node(1, at)], hasNextPage: true,
  }));

  const report = await ingestOnce(env, {});
  assert.equal(report.incremental_truncated, true, 'overflow must be reported');
  assert.equal(meta(env, 'last_ingest_at'), '2026-06-01T00:00:00Z',
    'the checkpoint must not pass a window whose results were not all read');

  const resume = JSON.parse(meta(env, 'resume:incremental:ISSUE'));
  assert.ok(resume.after, 'paging position must be kept so the next run can continue');

  // Progress now comes from the cursor, not from moving the clock past data.
  const before = queries.length;
  await ingestOnce(env, {});
  assert.equal(queries[before].q, queries[0].q, 'the window stays pinned while it drains');
  assert.ok(queries[before].after, 'and the next poll continues paging it');
});

test('a window that completes advances the checkpoint and drops its resume state', async () => {
  const env = makeEnv(APP);
  setCheckpoint(env, '2026-06-01T00:00:00Z');
  searchDouble(({ q }) => {
    const base = /updated:(\S+)\.\./.exec(q)[1];
    return { nodes: [node(1, new Date(Date.parse(base) + 60_000).toISOString())], hasNextPage: false };
  });

  await ingestOnce(env, {});
  assert.notEqual(meta(env, 'last_ingest_at'), '2026-06-01T00:00:00Z');
  assert.equal(meta(env, 'resume:incremental:ISSUE'), '');
});

test('a window that can never drain is abandoned out loud, not silently', async () => {
  const env = makeEnv(APP);
  setCheckpoint(env, '2026-06-01T00:00:00Z');
  searchDouble(() => ({ issueCount: 5000, nodes: [node(1, '2026-06-01T12:00:00Z')], hasNextPage: true }));

  // GitHub search stops at 1000 results, so some windows cannot be paged to the
  // end no matter how many runs try. Holding the checkpoint forever would trade
  // a bounded gap for a permanent stall, so the poller gives up — and says so.
  let report;
  for (let run = 0; run < 12; run++) {
    report = await ingestOnce(env, {});
    if (report.abandoned.length) break;
  }
  assert.ok(report.abandoned.includes('incremental:ISSUE'),
    'abandoning a window must be reported, not inferred from a moving checkpoint');
  assert.notEqual(meta(env, 'last_ingest_at'), '2026-06-01T00:00:00Z',
    'and the checkpoint moves once it has been abandoned');
  assert.ok(report.shortfall > 0, 'what was left behind is still counted as missing');
});

test('search bounds are second-precision, not day-precision', async () => {
  const env = makeEnv(APP);
  const queries = searchDouble(() => ({ nodes: [], hasNextPage: false }));
  await ingestOnce(env, {});
  assert.ok(queries.length > 0);
  assert.match(queries[0].q, /updated:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\.\./,
    'a day-granular bound cannot express partial progress within a busy day');
});

test('truncation is recorded where the board can see it', async () => {
  const env = makeEnv(APP);
  searchDouble(({ q }) => {
    const base = /updated:(\S+)\.\./.exec(q)[1];
    return { nodes: [node(1, new Date(Date.parse(base) + 60_000).toISOString())], hasNextPage: true };
  });
  await ingestOnce(env, {});
  const row = env.raw.prepare("SELECT value FROM meta WHERE key='last_truncated'").get();
  assert.ok(row?.value, 'a shortfall the operator cannot see is the same as no shortfall');
});

test('a GraphQL write with a lost response is uncertain, not failed', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('access_tokens')) {
      return new Response(JSON.stringify({ token: 't', expires_at: '2099-01-01T00:00:00Z' }),
        { status: 201, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('connection reset');
  };

  await assert.rejects(
    () => graphql(APP, 'mutation { addDiscussionComment { id } }', {}, { write: true, retries: 0 }),
    (e) => e.uncertain === true,
    'a dropped mutation may have been applied; retrying it duplicates the reply',
  );
});

test('a GraphQL read with a lost response is not uncertain', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('access_tokens')) {
      return new Response(JSON.stringify({ token: 't', expires_at: '2099-01-01T00:00:00Z' }),
        { status: 201, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('connection reset');
  };

  await assert.rejects(
    () => graphql(APP, 'query { viewer { login } }', {}, { retries: 0 }),
    (e) => e.uncertain === false,
    'reads are freely retryable and must not be flagged ambiguous',
  );
});

test('a shortfall against GitHub own count is measured, not inferred', async () => {
  const env = makeEnv(APP);
  // GitHub says 60; the page budget lets us take 25. The truncation flag would
  // say "we stopped early"; only issueCount can say "10 rows exist that we do
  // not hold".
  searchDouble(({ q }) => {
    const base = /updated:(\S+)\.\./.exec(q)[1];
    const t = Date.parse(base) + 60_000;
    return {
      issueCount: 60,
      nodes: [node(1, new Date(t).toISOString())],
      hasNextPage: true,
    };
  });

  const report = await ingestOnce(env, {});
  assert.ok(report.shortfall > 0, 'the gap between what exists and what we hold must be reported');
  assert.ok(report.expected > report.fetched);

  const row = env.raw.prepare("SELECT value FROM meta WHERE key='last_coverage'").get();
  const cov = JSON.parse(row.value);
  assert.equal(cov.shortfall, cov.expected - cov.fetched);
});

test('a fully covered window reports no shortfall', async () => {
  const env = makeEnv(APP);
  searchDouble(({ q }) => {
    const base = /updated:(\S+)\.\./.exec(q)[1];
    return {
      issueCount: 1,
      nodes: [node(1, new Date(Date.parse(base) + 60_000).toISOString())],
      hasNextPage: false,
    };
  });
  const report = await ingestOnce(env, {});
  assert.equal(report.shortfall, 0);
});

/**
 * A thread the search returns whole, whose comment connection it does not.
 *
 * `issueCount` counts threads, so this is the case that satisfied every
 * coverage check the poller had while the feed was missing comments.
 */
const busyThread = (fetched, totalCount) => ({
  ...node(1, '2026-06-01T12:00:00Z'),
  comments: {
    totalCount,
    nodes: fetched.map((n) => comment(`C_${n}`, `2026-06-01T0${n}:00:00Z`)),
  },
});

test('comments the sweep could not reach are counted, not assumed present', async () => {
  const env = makeEnv(APP);
  // The search is complete: GitHub says one thread, we hold one thread. The
  // thread says it has 8 comments and we read 2.
  searchDouble(
    () => ({ issueCount: 1, nodes: [busyThread([1, 2], 8)], hasNextPage: false }),
    // The drain cannot finish inside its page budget either, so the gap stands.
    () => ({ totalCount: 8, pageInfo: { hasNextPage: true, endCursor: 'p' }, nodes: [] }),
  );

  const report = await ingestOnce(env, {});
  assert.equal(report.expected, report.fetched, 'the search itself missed nothing');
  assert.equal(report.comments_missing, 6, 'but six comments exist that we do not hold');
  assert.equal(report.threads_incomplete, 1);
  assert.ok(report.shortfall >= 6,
    'coverage must not report a clean sync over a thread it only skimmed');

  const cov = JSON.parse(meta(env, 'last_coverage'));
  assert.equal(cov.comments_missing, 6, 'and the board has to be able to see it');
});

test('the drain fetches the comment tail the sweep skipped', async () => {
  const env = makeEnv(APP);
  const tail = [3, 4, 5, 6, 7, 8];
  searchDouble(
    () => ({ issueCount: 1, nodes: [busyThread([1, 2], 8)], hasNextPage: false }),
    () => ({
      totalCount: 8,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [1, 2, ...tail].map((n) => comment(`C_${n}`, `2026-06-01T0${n}:00:00Z`)),
    }),
  );

  const report = await ingestOnce(env, {});
  assert.equal(report.comments_missing, 0, 'the gap must close once the thread is paged');

  const stored = env.raw.prepare('SELECT gh_id FROM comments ORDER BY gh_id').all();
  assert.deepEqual(stored.map((r) => r.gh_id), [1, 2, ...tail].map((n) => `C_${n}`),
    'a comment that arrived between two polls is not lost to the next tail read');
});

test('a reply tail longer than one page is paged, not refetched', async () => {
  const env = makeEnv(APP);
  const parent = {
    ...comment('C_1', '2026-06-01T01:00:00Z'),
    replies: { totalCount: 3, pageInfo: { hasNextPage: false }, nodes: [] },
  };

  // 250 replies under one comment: more than a single reply page holds, so the
  // drain has to carry a cursor for the parent as well as for the thread.
  const reply = (n) => comment(`R_${n}`, '2026-06-01T02:00:00Z');
  const pages = {
    null: { nodes: [reply(1)], pageInfo: { hasNextPage: true, endCursor: 'r1' } },
    r1: { nodes: [reply(2)], pageInfo: { hasNextPage: true, endCursor: 'r2' } },
    r2: { nodes: [reply(3)], pageInfo: { hasNextPage: false, endCursor: null } },
  };
  const asked = [];

  searchDouble(
    () => ({
      issueCount: 1,
      nodes: [{ ...node(1, '2026-06-01T12:00:00Z'), comments: { totalCount: 1, nodes: [parent] } }],
      hasNextPage: false,
    }),
    () => ({
      totalCount: 1,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        ...comment('C_1', '2026-06-01T01:00:00Z'),
        replies: { totalCount: 3, pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
      }],
    }),
    ({ after }) => { asked.push(after); return pages[after ?? 'null']; },
  );

  // First run pages the thread and starts the reply tail; later runs continue
  // from the parent's own cursor instead of asking for page one again.
  let report;
  for (let run = 0; run < 4; run++) report = await ingestOnce(env, {});

  assert.deepEqual(asked.slice(0, 3), [null, 'r1', 'r2'],
    'each run must continue the reply tail rather than refetch its first page');
  assert.equal(report.comments_missing, 0, 'and the gap closes once the tail is in');

  const stored = env.raw.prepare("SELECT gh_id FROM comments WHERE parent_gh_id='C_1' ORDER BY gh_id").all();
  assert.deepEqual(stored.map((r) => r.gh_id), ['R_1', 'R_2', 'R_3']);
});

test('discussion replies count toward the thread total', async () => {
  const env = makeEnv(APP);
  const parent = {
    ...comment('C_1', '2026-06-01T01:00:00Z'),
    replies: { totalCount: 9, nodes: [comment('R_1', '2026-06-01T02:00:00Z')] },
  };
  searchDouble(
    () => ({
      issueCount: 1,
      nodes: [{ ...node(1, '2026-06-01T12:00:00Z'), comments: { totalCount: 1, nodes: [parent] } }],
      hasNextPage: false,
    }),
    () => ({ totalCount: 1, pageInfo: { hasNextPage: true, endCursor: 'p' }, nodes: [] }),
  );

  const report = await ingestOnce(env, {});
  // One top-level comment plus nine replies is ten; we read two of them.
  assert.equal(report.comments_missing, 8,
    'a reply beyond the reply tail is activity the feed would never show');

  const reply = env.raw.prepare("SELECT parent_gh_id FROM comments WHERE gh_id='R_1'").get();
  assert.equal(reply.parent_gh_id, 'C_1', 'a reply has to be distinguishable from a comment');
});
