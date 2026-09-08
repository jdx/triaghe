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
/** How many comments we store and show. */
const COMMENT_TAIL = 10;
/**
 * How many we *read* to decide who owes whom.
 *
 * These were the same number, which meant ten bot comments could push the
 * owner's reply out of view and out of the activity calculation at once — the
 * board then said "no reply yet" about a thread the owner had already answered.
 * The display excerpt is a UI choice; the activity window is a correctness one.
 */
const ACTIVITY_TAIL = 50;
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
        comments(last: ${ACTIVITY_TAIL}) { totalCount nodes { ${COMMENT_FIELDS} } }
      }
      ... on PullRequest {
        id number title url body state createdAt updatedAt locked isDraft
        author { login __typename } authorAssociation
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        comments(last: ${ACTIVITY_TAIL}) { totalCount nodes { ${COMMENT_FIELDS} } }
        reviews(last: 20) { nodes { author { login __typename } createdAt } }
      }
      ... on Discussion {
        id number title url body createdAt updatedAt locked isAnswered
        author { login __typename } authorAssociation
        repository { nameWithOwner }
        category { name }
        comments(last: ${ACTIVITY_TAIL}) {
          totalCount
          nodes { ${COMMENT_FIELDS} replies(last: 3) { nodes { ${COMMENT_FIELDS} } } }
        }
      }
    }
  }
}`;

const trunc = (s, n) => (s == null ? null : s.length > n ? s.slice(0, n) : s);
const day = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * One search window, paged up to `maxPages`.
 *
 * Reports whether it actually reached the end, plus the oldest and newest
 * `updatedAt` it saw. Callers need all three: stopping early is fine, but only
 * if the checkpoint they then write reflects what was really covered.
 *
 * `asc` decides which end of the window is guaranteed complete when paging
 * stops early. Ascending covers a contiguous prefix [since, newest]; descending
 * covers a contiguous suffix [oldest, until].
 */
async function searchWindow(env, type, since, until, maxPages, { asc = false } = {}) {
  const sort = asc ? 'sort:updated-asc' : 'sort:updated-desc';
  const q = `${searchScope(env)} updated:${day(since)}..${day(until)} ${sort}`;
  const out = [];
  let after = null;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const data = await graphql(env, SEARCH_QUERY, { q, type, after });
    out.push(...data.search.nodes.filter(Boolean));
    if (!data.search.pageInfo.hasNextPage) { complete = true; break; }
    after = data.search.pageInfo.endCursor;
  }

  let oldest = null;
  let newest = null;
  for (const n of out) {
    if (!n?.updatedAt) continue;
    if (!oldest || Date.parse(n.updatedAt) < Date.parse(oldest)) oldest = n.updatedAt;
    if (!newest || Date.parse(n.updatedAt) > Date.parse(newest)) newest = n.updatedAt;
  }
  return { nodes: out, complete, oldest, newest };
}

/**
 * Flatten a node's comments (including discussion replies) into one sorted list.
 *
 * Returns two views. `activity` is everything fetched and drives who-owes-whom.
 * `display` is the last few real comments and is what gets stored and shown.
 * Review stubs carry no body, so they inform activity but are kept out of the
 * display tail — they used to evict up to five real comments from both the
 * board and the drafting agent's only context.
 */
function commentTail(node) {
  const flat = [];
  for (const c of node.comments?.nodes ?? []) {
    if (!c) continue;
    flat.push(c);
    for (const r of c.replies?.nodes ?? []) if (r) flat.push(r);
  }
  for (const r of node.reviews?.nodes ?? []) {
    if (r?.createdAt) flat.push({ author: r.author, createdAt: r.createdAt, body: null, review: true });
  }
  flat.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return { activity: flat, display: flat.filter((c) => !c.review).slice(-COMMENT_TAIL) };
}

function toRow(node, owner) {
  const kind = node.__typename === 'PullRequest' ? 'pr'
    : node.__typename === 'Discussion' ? 'discussion' : 'issue';
  const repo = node.repository.nameWithOwner;
  const id = `${repo}#${kind}#${node.number}`;
  const author = node.author?.login ?? null;
  const { activity, display } = commentTail(node);

  // Who spoke last, and when did the owner last speak? Fall back to the opening
  // post so an untouched item still has a last actor.
  let lastActor = author;
  let lastActorAt = node.createdAt;
  let lastActorType = node.author?.__typename;
  for (const c of activity) {
    if (!c.createdAt) continue;
    lastActor = c.author?.login ?? null;
    lastActorAt = c.createdAt;
    lastActorType = c.author?.__typename;
  }

  let lastOwnerAt = isOwner(author, owner) ? node.createdAt : null;
  for (const c of activity) {
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
  for (const c of activity) {
    if (!c.createdAt || !human(c.author?.login, c.author?.__typename)) continue;
    if (!lastHumanAt || Date.parse(c.createdAt) > Date.parse(lastHumanAt)) {
      lastHumanAt = c.createdAt;
      lastHumanActor = c.author.login;
    }
  }

  return {
    tail: display,
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
  author_assoc=excluded.author_assoc, fetched_at=excluded.fetched_at,
  -- Activity timestamps only ever move forward. Each poll sees a bounded window
  -- of comments, so a thread that accumulates chatter can stop showing an older
  -- owner reply; taking excluded.* unconditionally would then "forget" that the
  -- owner had answered and put a resolved thread back in the inbox. Anything we
  -- have ever observed stays observed.
  last_owner_at=CASE
    WHEN excluded.last_owner_at IS NULL THEN items.last_owner_at
    WHEN items.last_owner_at IS NULL THEN excluded.last_owner_at
    ELSE MAX(items.last_owner_at, excluded.last_owner_at) END,
  last_human_at=CASE
    WHEN excluded.last_human_at IS NULL THEN items.last_human_at
    WHEN items.last_human_at IS NULL THEN excluded.last_human_at
    ELSE MAX(items.last_human_at, excluded.last_human_at) END,
  last_human_actor=CASE
    WHEN excluded.last_human_at IS NULL THEN items.last_human_actor
    WHEN items.last_human_at IS NULL OR excluded.last_human_at >= items.last_human_at
      THEN excluded.last_human_actor
    ELSE items.last_human_actor END`;

const INSERT_COMMENT =
  'INSERT INTO comments (item_id, seq, author, author_is_bot, created_at, body) VALUES (?,?,?,?,?,?)';

async function persist(env, nodes) {
  const owner = ownerLogin(env);
  const now = new Date().toISOString();
  const stmts = [];
  const upsert = env.DB.prepare(UPSERT);
  const delComments = env.DB.prepare('DELETE FROM comments WHERE item_id = ?');
  const insComment = env.DB.prepare(INSERT_COMMENT);

  // One group per item. The group is the atomic unit: its DELETE and the
  // re-INSERTs that replace those rows must land in the same transaction.
  const groups = [];
  for (const node of nodes) {
    if (!node.repository) continue;
    const { id, values, tail } = toRow(node, owner);
    const g = [upsert.bind(...values, now, now), delComments.bind(id)];
    tail.forEach((c, i) => g.push(insComment.bind(
      id, i, c.author?.login ?? null,
      isBot(c.author?.login, c.author?.__typename) ? 1 : 0,
      c.createdAt ?? null, trunc(c.body, COMMENT_BODY_MAX),
    )));
    groups.push(g);
  }

  // D1 caps how much one batch may carry, so chunk — but only on group
  // boundaries. Chunking the flat statement list could put "DELETE this item's
  // comments" in one transaction and its replacements in the next, and a
  // failure between them erased the comment tail for good. "Every write is an
  // idempotent upsert" was true of the items table and never true of this pair.
  let chunk = [];
  for (const g of groups) {
    if (chunk.length && chunk.length + g.length > BATCH) {
      await env.DB.batch(chunk);
      chunk = [];
    }
    chunk.push(...g);
  }
  if (chunk.length) await env.DB.batch(chunk);
  return groups.length;
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
  const report = {
    incremental: 0, backfill: 0, backfill_to: null, done: false,
    incremental_truncated: false, backfill_truncated: false,
  };

  // 1. Incremental: everything updated since the last successful run, with an
  //    hour of overlap. Upserts are idempotent so overlap costs nothing.
  const last = await getMeta(env, 'last_ingest_at');
  const since = last
    ? new Date(Date.parse(last) - 3600_000)
    : new Date(now.getTime() - WINDOW_DAYS * 86400000);

  //    Paged oldest-first on purpose. Newest-first looks natural but leaves the
  //    hole in the wrong place: stopping at the page cap covers [X, now] and
  //    skips [since, X), and no later window ever goes back for it. Ascending
  //    means whatever we finish is a contiguous prefix, so the checkpoint can
  //    advance to the newest item actually stored and lose nothing.
  let covered = now;
  let truncated = false;
  for (const type of ['ISSUE', 'DISCUSSION']) {
    const { nodes, complete, newest } = await searchWindow(env, type, since, now, maxPages, { asc: true });
    report.incremental += await persist(env, nodes);
    if (complete) continue;
    truncated = true;
    // Trust only up to the oldest stopping point across types: another type may
    // have run out of pages earlier than this one.
    const edge = newest ? new Date(newest) : since;
    if (edge < covered) covered = edge;
  }
  report.incremental_truncated = truncated;
  await setMeta(env, 'last_ingest_at', covered.toISOString());

  // 2. Backfill: one older window per run, walking backwards from first launch
  //    until we have `backfillDays` of history.
  const floor = new Date(now.getTime() - backfillDays * 86400000);
  const cursor = new Date(await getMeta(env, 'backfill_cursor', since.toISOString()));

  if (cursor > floor) {
    const from = new Date(Math.max(cursor.getTime() - WINDOW_DAYS * 86400000, floor.getTime()));
    // Backfill walks backwards, so descending paging is already contiguous from
    // `cursor` down. When it stops early the cursor may only retreat as far as
    // the oldest item actually stored — moving it to `from` regardless was what
    // stranded the unread remainder of an overflowing window.
    let reached = from;
    for (const type of ['ISSUE', 'DISCUSSION']) {
      const { nodes, complete, oldest } = await searchWindow(env, type, from, cursor, 20);
      report.backfill += await persist(env, nodes);
      if (complete) continue;
      report.backfill_truncated = true;
      const edge = oldest ? new Date(oldest) : cursor;
      if (edge > reached) reached = edge;
    }
    await setMeta(env, 'backfill_cursor', reached.toISOString());
    report.backfill_to = reached.toISOString();
  } else {
    report.done = true;
  }

  // Coverage gaps are the failure mode that quietly destroys trust in the board,
  // so the last run's shortfall is persisted for the UI rather than only logged.
  await setMeta(env, 'last_truncated',
    report.incremental_truncated || report.backfill_truncated ? now.toISOString() : '');
  await log(env, 'ingest', 'poll', null, report);
  return report;
}

/** Small helpers the API surfaces so the board can show ingest health. */
export async function ingestStatus(env) {
  const [lastIngest, cursor, truncated, count] = await Promise.all([
    getMeta(env, 'last_ingest_at'),
    getMeta(env, 'backfill_cursor'),
    getMeta(env, 'last_truncated'),
    first(env, 'SELECT COUNT(*) AS c FROM items'),
  ]);
  const backfillDays = Number(env.BACKFILL_DAYS || 90);
  return {
    last_ingest: lastIngest,
    backfill_cursor: cursor,
    backfill_complete: cursor
      ? Date.parse(cursor) <= Date.now() - backfillDays * 86400000
      : false,
    // The board promises to be the inbox, so the edges of what it knows are
    // part of the answer: how far back history goes, and whether the last poll
    // ran out of pages before it ran out of results.
    backfill_days: backfillDays,
    horizon: new Date(Date.now() - backfillDays * 86400000).toISOString(),
    last_truncated: truncated || null,
    items: count?.c ?? 0,
  };
}
