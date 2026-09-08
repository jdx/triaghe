/**
 * Poll GitHub -> D1. No model runs in this path.
 *
 * Everything fetched here is untrusted text. It is only ever stored as a bound
 * D1 parameter. It is never executed, shell-interpolated, or fetched from.
 *
 * Bounded work per invocation. A cron tick does one incremental window (which
 * is normally a handful of items) plus at most one 7-day backfill window, so a
 * cold database fills in over a few hours instead of one run trying to pull
 * three months and dying against the CPU limit.
 */
import { first, getMeta, log, setMeta } from './db.mjs';
import { graphql } from './gh.mjs';
import { isBot, isOwner, ownerLogin, searchScope } from './config.mjs';

const ITEM_BODY_MAX = 8000;
const COMMENT_BODY_MAX = 2000;
const COMMENT_TAIL = 10;
const WINDOW_DAYS = 7;
const BATCH = 25;

const COMMENT_FIELDS = 'author { login __typename } createdAt body';

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
const day = (d) => new Date(d).toISOString().slice(0, 10);

async function searchWindow(env, type, since, until, maxPages) {
  const q = `${searchScope(env)} updated:${day(since)}..${day(until)} sort:updated-desc`;
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await graphql(env, SEARCH_QUERY, { q, type, after });
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

function toRow(node, owner) {
  const kind = node.__typename === 'PullRequest' ? 'pr'
    : node.__typename === 'Discussion' ? 'discussion' : 'issue';
  const repo = node.repository.nameWithOwner;
  const id = `${repo}#${kind}#${node.number}`;
  const author = node.author?.login ?? null;
  const tail = commentTail(node);

  // Who spoke last, and when did the owner last speak? Fall back to the opening
  // post so an untouched item still has a last actor.
  let lastActor = author;
  let lastActorAt = node.createdAt;
  let lastActorType = node.author?.__typename;
  for (const c of tail) {
    if (!c.createdAt) continue;
    lastActor = c.author?.login ?? null;
    lastActorAt = c.createdAt;
    lastActorType = c.author?.__typename;
  }

  let lastOwnerAt = isOwner(author, owner) ? node.createdAt : null;
  for (const c of tail) {
    if (isOwner(c.author?.login, owner)
      && (!lastOwnerAt || Date.parse(c.createdAt) > Date.parse(lastOwnerAt))) {
      lastOwnerAt = c.createdAt;
    }
  }

  // The opening post counts as human activity, so a PR nobody has answered
  // still registers even when a review bot commented after it.
  const human = (login, type) => login && !isOwner(login, owner) && !isBot(login, type);
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
    tail,
    id,
    values: [
      id, node.id ?? null, repo, kind, node.number, node.title, node.url,
      author, isBot(author, node.author?.__typename) ? 1 : 0, node.authorAssociation ?? null,
      trunc(node.body, ITEM_BODY_MAX), (node.body?.length ?? 0) > ITEM_BODY_MAX ? 1 : 0,
      node.state ?? 'OPEN',
      node.isAnswered == null ? null : node.isAnswered ? 1 : 0,
      node.isDraft ? 1 : 0, node.locked ? 1 : 0,
      JSON.stringify((node.labels?.nodes ?? []).map((l) => l.name)),
      node.category?.name ?? null, node.comments?.totalCount ?? 0,
      node.createdAt, node.updatedAt,
      lastActor, isBot(lastActor, lastActorType) ? 1 : 0, lastActorAt,
      lastOwnerAt, lastHumanAt, lastHumanActor,
    ],
  };
}

// Positional rather than named parameters: D1 does not support the `$name`
// binding style the node:sqlite version used.
const UPSERT = `
INSERT INTO items (
  id, node_id, repo, kind, number, title, url, author, author_is_bot, author_assoc,
  body, body_truncated, state, is_answered, is_draft, locked, labels, category,
  comment_count, created_at, updated_at, last_actor, last_actor_is_bot,
  last_actor_at, last_owner_at, last_human_at, last_human_actor, first_seen_at, fetched_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  node_id=excluded.node_id, title=excluded.title, body=excluded.body,
  body_truncated=excluded.body_truncated, state=excluded.state,
  is_answered=excluded.is_answered, is_draft=excluded.is_draft,
  locked=excluded.locked, labels=excluded.labels, comment_count=excluded.comment_count,
  updated_at=excluded.updated_at, last_actor=excluded.last_actor,
  last_actor_is_bot=excluded.last_actor_is_bot, last_actor_at=excluded.last_actor_at,
  last_owner_at=excluded.last_owner_at, last_human_at=excluded.last_human_at,
  last_human_actor=excluded.last_human_actor, author_assoc=excluded.author_assoc,
  fetched_at=excluded.fetched_at`;

const INSERT_COMMENT =
  'INSERT INTO comments (item_id, seq, author, author_is_bot, created_at, body) VALUES (?,?,?,?,?,?)';

async function persist(env, nodes) {
  const owner = ownerLogin(env);
  const now = new Date().toISOString();
  const stmts = [];
  const upsert = env.DB.prepare(UPSERT);
  const delComments = env.DB.prepare('DELETE FROM comments WHERE item_id = ?');
  const insComment = env.DB.prepare(INSERT_COMMENT);

  for (const node of nodes) {
    if (!node.repository) continue;
    const { id, values, tail } = toRow(node, owner);
    stmts.push(upsert.bind(...values, now, now));
    stmts.push(delComments.bind(id));
    tail.forEach((c, i) => stmts.push(insComment.bind(
      id, i, c.author?.login ?? null,
      isBot(c.author?.login, c.author?.__typename) ? 1 : 0,
      c.createdAt ?? null, trunc(c.body, COMMENT_BODY_MAX),
    )));
  }

  // D1 caps how much one batch may carry, so chunk. Each chunk is its own
  // transaction; a failure mid-run leaves earlier chunks applied, which is fine
  // because every write is an idempotent upsert.
  for (let i = 0; i < stmts.length; i += BATCH) {
    await env.DB.batch(stmts.slice(i, i + BATCH));
  }
  return stmts.length ? nodes.length : 0;
}

/**
 * One unit of ingest work.
 *
 * `full` runs the incremental window with generous paging — used by the manual
 * refresh button. The scheduled path keeps paging tight so a busy window cannot
 * stretch a cron run past its budget; anything it misses is picked up by the
 * next tick, because the window always overlaps.
 */
export async function ingestOnce(env, { full = false } = {}) {
  const now = new Date();
  const maxPages = full ? 20 : 6;
  const backfillDays = Number(env.BACKFILL_DAYS || 90);
  const report = { incremental: 0, backfill: 0, backfill_to: null, done: false };

  // 1. Incremental: everything updated since the last successful run, with an
  //    hour of overlap. Upserts are idempotent so overlap costs nothing.
  const last = await getMeta(env, 'last_ingest_at');
  const since = last
    ? new Date(Date.parse(last) - 3600_000)
    : new Date(now.getTime() - WINDOW_DAYS * 86400000);

  for (const type of ['ISSUE', 'DISCUSSION']) {
    const nodes = await searchWindow(env, type, since, now, maxPages);
    report.incremental += await persist(env, nodes);
  }
  await setMeta(env, 'last_ingest_at', now.toISOString());

  // 2. Backfill: one older window per run, walking backwards from first launch
  //    until we have `backfillDays` of history.
  const floor = new Date(now.getTime() - backfillDays * 86400000);
  const cursor = new Date(await getMeta(env, 'backfill_cursor', since.toISOString()));

  if (cursor > floor) {
    const from = new Date(Math.max(cursor.getTime() - WINDOW_DAYS * 86400000, floor.getTime()));
    for (const type of ['ISSUE', 'DISCUSSION']) {
      const nodes = await searchWindow(env, type, from, cursor, 20);
      report.backfill += await persist(env, nodes);
    }
    await setMeta(env, 'backfill_cursor', from.toISOString());
    report.backfill_to = from.toISOString();
  } else {
    report.done = true;
  }

  await log(env, 'ingest', 'poll', null, report);
  return report;
}

/** Small helpers the API surfaces so the board can show ingest health. */
export async function ingestStatus(env) {
  const [lastIngest, cursor, count] = await Promise.all([
    getMeta(env, 'last_ingest_at'),
    getMeta(env, 'backfill_cursor'),
    first(env, 'SELECT COUNT(*) AS c FROM items'),
  ]);
  return {
    last_ingest: lastIngest,
    backfill_cursor: cursor,
    backfill_complete: cursor
      ? Date.parse(cursor) <= Date.now() - Number(env.BACKFILL_DAYS || 90) * 86400000
      : false,
    items: count?.c ?? 0,
  };
}
