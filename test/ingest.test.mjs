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

/**
 * A GitHub search double. Records every `updated:` range it is asked for, so a
 * test can assert that the window actually moved rather than only that some
 * results came back.
 */
function searchDouble(pagesFor) {
  const queries = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('access_tokens')) {
      return new Response(JSON.stringify({ token: 't', expires_at: '2099-01-01T00:00:00Z' }),
        { status: 201, headers: { 'content-type': 'application/json' } });
    }
    const { variables } = JSON.parse(init.body);
    queries.push(variables.q);
    const { nodes, hasNextPage, issueCount } = pagesFor(variables);
    return new Response(JSON.stringify({
      data: {
        search: {
          issueCount: issueCount ?? nodes.length,
          pageInfo: { hasNextPage, endCursor: 'c' },
          nodes,
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
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

test('an exhausted window still advances its checkpoint', async () => {
  const env = makeEnv(APP);
  // Always claims another page: the page budget, not the data, ends the loop.
  const queries = searchDouble(({ q }) => {
    const base = /updated:(\S+)\.\./.exec(q)[1];
    const t = Date.parse(base) + 60_000;
    return { nodes: [node(1, new Date(t).toISOString())], hasNextPage: true };
  });

  const first = await ingestOnce(env, {});
  assert.equal(first.incremental_truncated, true, 'overflow must be reported');
  const after = env.raw.prepare("SELECT value FROM meta WHERE key='last_ingest_at'").get();
  assert.ok(after?.value, 'checkpoint must be written');

  // The second poll must ask a *different* question. Day-granular bounds made
  // it ask the same one forever, so a busy day could never be drained.
  const before = queries.length;
  await ingestOnce(env, {});
  assert.notEqual(queries[before], queries[0], 'the window must move between polls');
});

test('search bounds are second-precision, not day-precision', async () => {
  const env = makeEnv(APP);
  const queries = searchDouble(() => ({ nodes: [], hasNextPage: false }));
  await ingestOnce(env, {});
  assert.ok(queries.length > 0);
  assert.match(queries[0], /updated:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\.\./,
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
