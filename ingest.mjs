#!/usr/bin/env node
/**
 * Poll GitHub -> SQLite. No model runs in this path.
 *
 * Everything fetched here is untrusted text. It is only ever stored as a bound
 * SQLite parameter. It is never executed, shell-interpolated, or fetched from.
 *
 *   node ingest.mjs            # incremental since the last successful run
 *   node ingest.mjs --days 90  # re-scan a window (upserts, keeps triage marks)
 */
import { open, log, getMeta, setMeta } from './lib/db.mjs';
import { graphql } from './lib/gh.mjs';
import { SEARCH_SCOPE, OWNER_LOGIN, isBot, isOwner } from './lib/config.mjs';

const ITEM_BODY_MAX = 8000;
const COMMENT_BODY_MAX = 2000;
const COMMENT_TAIL = 10;

const COMMENT_FIELDS = `author { login __typename } createdAt body`;

const SEARCH_QUERY = `
query($q: String!, $type: SearchType!, $after: String) {
  search(query: $q, type: $type, first: 25, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue {
        id number title url body state createdAt updatedAt locked
        author { login __typename } authorAssociation
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        comments(last: ${COMMENT_TAIL}) { totalCount nodes { ${COMMENT_FIELDS} } }
      }
      ... on PullRequest {
        id number title url body state createdAt updatedAt locked isDraft
        author { login __typename } authorAssociation
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        comments(last: ${COMMENT_TAIL}) { totalCount nodes { ${COMMENT_FIELDS} } }
        reviews(last: 5) { nodes { author { login __typename } createdAt } }
      }
      ... on Discussion {
        id number title url body createdAt updatedAt locked isAnswered
        author { login __typename } authorAssociation
        repository { nameWithOwner }
        category { name }
        comments(last: ${COMMENT_TAIL}) {
          totalCount
          nodes { ${COMMENT_FIELDS} replies(last: 3) { nodes { ${COMMENT_FIELDS} } } }
        }
      }
    }
  }
}`;

const trunc = (s, n) => (s == null ? null : s.length > n ? s.slice(0, n) : s);
const iso = (d) => new Date(d).toISOString().slice(0, 10);

async function searchWindow(type, since, until) {
  const q = `${SEARCH_SCOPE} updated:${iso(since)}..${iso(until)} sort:updated-desc`;
  const out = [];
  let after = null;
  for (let page = 0; page < 40; page++) {
    const data = await graphql(SEARCH_QUERY, { q, type, after });
    out.push(...data.search.nodes.filter(Boolean));
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return out;
}

/** Flatten a node's comment tail (including discussion replies) into one sorted list. */
function commentTail(node) {
  const flat = [];
  for (const c of node.comments?.nodes ?? []) {
    if (!c) continue;
    flat.push(c);
    for (const r of c.replies?.nodes ?? []) if (r) flat.push(r);
  }
  for (const r of node.reviews?.nodes ?? []) {
    if (r?.createdAt) flat.push({ author: r.author, createdAt: r.createdAt, body: null });
  }
  flat.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return flat.slice(-COMMENT_TAIL);
}

function toRow(node) {
  const kind = node.__typename === 'PullRequest' ? 'pr'
    : node.__typename === 'Discussion' ? 'discussion' : 'issue';
  const repo = node.repository.nameWithOwner;
  const id = `${repo}#${kind}#${node.number}`;
  const author = node.author?.login ?? null;
  const tail = commentTail(node);

  // Who spoke last, and when did the owner last speak? Fall back to the opening
  // post so an untouched item still has a last actor.
  let lastActor = author, lastActorAt = node.createdAt, lastActorType = node.author?.__typename;
  for (const c of tail) {
    if (c.createdAt) {
      lastActor = c.author?.login ?? null;
      lastActorAt = c.createdAt;
      lastActorType = c.author?.__typename;
    }
  }
  let lastOwnerAt = isOwner(author) ? node.createdAt : null;
  for (const c of tail) {
    if (isOwner(c.author?.login) && (!lastOwnerAt || Date.parse(c.createdAt) > Date.parse(lastOwnerAt))) {
      lastOwnerAt = c.createdAt;
    }
  }

  // The opening post counts as human activity, so a PR nobody has answered
  // still registers even when a review bot commented after it.
  const human = (login, type) => login && !isOwner(login) && !isBot(login, type);
  let lastHumanAt = human(author, node.author?.__typename) ? node.createdAt : null;
  let lastHumanActor = lastHumanAt ? author : null;
  for (const c of tail) {
    if (!c.createdAt || !human(c.author?.login, c.author?.__typename)) continue;
    if (!lastHumanAt || Date.parse(c.createdAt) > Date.parse(lastHumanAt)) {
      lastHumanAt = c.createdAt;
      lastHumanActor = c.author.login;
    }
  }

  return {
    row: {
      id, node_id: node.id, repo, kind, number: node.number, title: node.title, url: node.url,
      author, author_is_bot: isBot(author, node.author?.__typename) ? 1 : 0,
      author_assoc: node.authorAssociation ?? null,
      body: trunc(node.body, ITEM_BODY_MAX),
      body_truncated: (node.body?.length ?? 0) > ITEM_BODY_MAX ? 1 : 0,
      state: node.state ?? 'OPEN',
      is_answered: node.isAnswered == null ? null : (node.isAnswered ? 1 : 0),
      is_draft: node.isDraft ? 1 : 0,
      locked: node.locked ? 1 : 0,
      labels: JSON.stringify((node.labels?.nodes ?? []).map((l) => l.name)),
      category: node.category?.name ?? null,
      comment_count: node.comments?.totalCount ?? 0,
      created_at: node.createdAt, updated_at: node.updatedAt,
      last_actor: lastActor, last_actor_is_bot: isBot(lastActor, lastActorType) ? 1 : 0,
      last_actor_at: lastActorAt, last_owner_at: lastOwnerAt,
      last_human_at: lastHumanAt, last_human_actor: lastHumanActor,
    },
    tail,
  };
}

const UPSERT = `
INSERT INTO items (
  id, node_id, repo, kind, number, title, url, author, author_is_bot, author_assoc,
  body, body_truncated, state, is_answered, is_draft, locked, labels, category,
  comment_count, created_at, updated_at, last_actor, last_actor_is_bot,
  last_actor_at, last_owner_at, last_human_at, last_human_actor, first_seen_at, fetched_at
) VALUES (
  $id,$node_id,$repo,$kind,$number,$title,$url,$author,$author_is_bot,$author_assoc,
  $body,$body_truncated,$state,$is_answered,$is_draft,$locked,$labels,$category,
  $comment_count,$created_at,$updated_at,$last_actor,$last_actor_is_bot,
  $last_actor_at,$last_owner_at,$last_human_at,$last_human_actor,$now,$now
)
ON CONFLICT(id) DO UPDATE SET
  node_id=excluded.node_id, title=excluded.title, body=excluded.body, body_truncated=excluded.body_truncated,
  state=excluded.state, is_answered=excluded.is_answered, is_draft=excluded.is_draft,
  locked=excluded.locked, labels=excluded.labels, comment_count=excluded.comment_count,
  updated_at=excluded.updated_at, last_actor=excluded.last_actor,
  last_actor_is_bot=excluded.last_actor_is_bot, last_actor_at=excluded.last_actor_at,
  last_owner_at=excluded.last_owner_at, last_human_at=excluded.last_human_at,
  last_human_actor=excluded.last_human_actor, author_assoc=excluded.author_assoc,
  fetched_at=excluded.fetched_at`;

async function main() {
  const db = open();
  const argDays = process.argv.includes('--days')
    ? Number(process.argv[process.argv.indexOf('--days') + 1]) : null;

  const last = getMeta('last_ingest_at');
  const since = argDays
    ? new Date(Date.now() - argDays * 86400000)
    : last ? new Date(Date.parse(last) - 3600_000)   // 1h overlap, upserts are idempotent
           : new Date(Date.now() - 90 * 86400000);
  const startedAt = new Date();

  // Search caps at 1000 results per query, so walk the range in 7-day windows.
  const windows = [];
  for (let t = since.getTime(); t < startedAt.getTime(); t += 7 * 86400000) {
    windows.push([new Date(t), new Date(Math.min(t + 7 * 86400000, startedAt.getTime()))]);
  }

  const upsert = db.prepare(UPSERT);
  const delComments = db.prepare('DELETE FROM comments WHERE item_id = ?');
  const insComment = db.prepare(
    'INSERT INTO comments (item_id, seq, author, author_is_bot, created_at, body) VALUES (?,?,?,?,?,?)');

  let seen = 0;
  for (const [a, b] of windows) {
    for (const type of ['ISSUE', 'DISCUSSION']) {
      const nodes = await searchWindow(type, a, b);
      db.exec('BEGIN');
      try {
        for (const node of nodes) {
          if (!node.repository) continue;
          const { row, tail } = toRow(node);
          upsert.run({ ...row, now: new Date().toISOString() });
          delComments.run(row.id);
          tail.forEach((c, i) => insComment.run(
            row.id, i, c.author?.login ?? null, isBot(c.author?.login, c.author?.__typename) ? 1 : 0,
            c.createdAt ?? null, trunc(c.body, COMMENT_BODY_MAX)));
          seen++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      process.stderr.write(`  ${iso(a)}..${iso(b)} ${type}: ${nodes.length}\n`);
    }
  }

  setMeta('last_ingest_at', startedAt.toISOString());
  log('ingest', 'poll', null, { since: since.toISOString(), items: seen, owner: OWNER_LOGIN });
  process.stderr.write(`ingested ${seen} items since ${since.toISOString()}\n`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
