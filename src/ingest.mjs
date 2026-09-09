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
import { all, first, getMeta, log, setMeta } from './db.mjs';
import { graphql } from './gh.mjs';
import { isBot, isOwner, mentionsOwner, ownerLogin, searchScope } from './config.mjs';

const ITEM_BODY_MAX = 8000;
const COMMENT_BODY_MAX = 2000;
/**
 * How many comments each poll reads per thread.
 *
 * This used to be 10 and doubled as the storage limit, so ten bot comments
 * could bury the owner's reply and the thread would read as unanswered. Reading
 * is now wider than any display slice, and storage is not a slice at all —
 * comments are keyed by node id and accumulate.
 */
const ACTIVITY_TAIL = 50;
/**
 * Replies read per discussion comment during the sweep.
 *
 * Deliberately small, and no longer load-bearing. The sweep's job is to notice
 * that a thread has more activity than it read; `drainThreads` is what actually
 * goes and gets it. Widening this instead would only move the cliff.
 */
const REPLY_TAIL = 3;
const WINDOW_DAYS = 7;
const BATCH = 25;

/**
 * Total pages one search window may ever consume across runs before it is
 * abandoned. A window that cannot drain inside this budget is a window GitHub
 * will not let us page to the end of (search caps at 1000 results), so the
 * honest move is to stop, record the loss in coverage, and let the checkpoint
 * move rather than block every later window behind it forever.
 */
const MAX_WINDOW_PAGES = 40;

/** Per-run budget for the thread drain: at most 9 GraphQL calls. */
const DRAIN_THREADS = 3;
const DRAIN_PAGES = 3;

const COMMENT_FIELDS = 'id author { login __typename } createdAt body';

const SEARCH_QUERY = `
query($q: String!, $type: SearchType!, $after: String) {
  search(query: $q, type: $type, first: 25, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue {
        id number title url body state createdAt updatedAt locked closedAt
        author { login __typename } authorAssociation
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        comments(last: ${ACTIVITY_TAIL}) { totalCount nodes { ${COMMENT_FIELDS} } }
      }
      ... on PullRequest {
        id number title url body state createdAt updatedAt locked isDraft closedAt
        author { login __typename } authorAssociation
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        comments(last: ${ACTIVITY_TAIL}) { totalCount nodes { ${COMMENT_FIELDS} } }
        reviews(last: 20) { nodes { author { login __typename } createdAt } }
      }
      ... on Discussion {
        id number title url body createdAt updatedAt locked isAnswered answerChosenAt
        author { login __typename } authorAssociation
        repository { nameWithOwner }
        category { name }
        comments(last: ${ACTIVITY_TAIL}) {
          totalCount
          nodes {
            ${COMMENT_FIELDS}
            replies(last: ${REPLY_TAIL}) { totalCount nodes { ${COMMENT_FIELDS} } }
          }
        }
      }
    }
  }
}`;

/**
 * One thread, paged properly.
 *
 * The sweep reads a bounded tail of each thread because it reads many threads.
 * This reads one thread to the end, and is aimed only at the threads the sweep
 * has already reported a gap on.
 */
const THREAD_QUERY = `
query($id: ID!, $after: String) {
  node(id: $id) {
    __typename
    ... on Issue {
      comments(first: 100, after: $after) {
        totalCount pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} }
      }
    }
    ... on PullRequest {
      comments(first: 100, after: $after) {
        totalCount pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} }
      }
    }
    ... on Discussion {
      comments(first: 25, after: $after) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          ${COMMENT_FIELDS}
          replies(first: 100) { totalCount nodes { ${COMMENT_FIELDS} } }
        }
      }
    }
  }
}`;

const trunc = (s, n) => (s == null ? null : s.length > n ? s.slice(0, n) : s);

const safeJson = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

/**
 * Search bounds at second precision.
 *
 * These were calendar days, which quietly capped what a window could ever
 * drain. GitHub's `updated:` qualifier accepts full timestamps; with days, a
 * checkpoint advanced to 14:20 still produced a query starting at 00:00, so a
 * day holding more results than the page budget refetched the same prefix on
 * every poll and never reached the rest. Timestamps make an advanced checkpoint
 * actually narrow the next window.
 */
const stamp = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

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
async function searchWindow(env, type, since, until, maxPages, { asc = false, scope, after: resumeFrom = null } = {}) {
  const sort = asc ? 'sort:updated-asc' : 'sort:updated-desc';
  const q = `${scope ?? searchScope(env)} updated:${stamp(since)}..${stamp(until)} ${sort}`;
  const out = [];
  let after = resumeFrom;
  let pages = 0;
  let complete = false;
  // What GitHub says the window contains, read from the first page. This is the
  // only number in the pipeline that does not come from our own paging, which is
  // what makes it usable as an independent check: "I stopped early" is a claim
  // about our loop, "GitHub had 60 and I hold 50" is a claim about the data.
  let expected = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await graphql(env, SEARCH_QUERY, { q, type, after });
    pages++;
    if (expected == null) expected = data.search.issueCount ?? null;
    out.push(...data.search.nodes.filter(Boolean));
    if (!data.search.pageInfo.hasNextPage) { complete = true; after = null; break; }
    after = data.search.pageInfo.endCursor;
  }

  let oldest = null;
  let newest = null;
  for (const n of out) {
    if (!n?.updatedAt) continue;
    if (!oldest || Date.parse(n.updatedAt) < Date.parse(oldest)) oldest = n.updatedAt;
    if (!newest || Date.parse(n.updatedAt) > Date.parse(newest)) newest = n.updatedAt;
  }
  return { nodes: out, complete, oldest, newest, expected, fetched: out.length, after, pages };
}

/**
 * A search window that survives running out of pages.
 *
 * The previous shape restarted every window from its first page and, when a
 * truncated window could not advance its own boundary, stepped the checkpoint
 * forward by a second to guarantee progress. That is a silent skip: results
 * sharing the boundary timestamp, beyond the page budget, fall outside the next
 * window and are never fetched again. Cross-repository mentions were the worst
 * case, because nothing else covers them.
 *
 * So progress comes from the cursor instead of from the clock. A window that
 * stops early keeps its bounds pinned and records where paging stopped; the
 * next run continues from there and the checkpoint does not move until the
 * window is genuinely finished. Search cursors are positional over a window
 * whose upper bound is in the past, and anything updated after that bound has
 * left the window rather than shifted inside it, so resuming lands where it
 * left off.
 *
 * The cost is latency, not correctness: while a window drains, newer activity
 * waits behind it. `MAX_WINDOW_PAGES` bounds that wait, and giving up is
 * recorded rather than hidden.
 */
async function runWindow(env, name, type, since, until, maxPages, opts = {}) {
  const key = `resume:${name}:${type}`;
  const saved = safeJson(await getMeta(env, key));
  const from = saved ? new Date(saved.since) : since;
  const to = saved ? new Date(saved.until) : until;

  const res = await searchWindow(env, type, from, to, maxPages,
    { ...opts, after: saved?.after ?? null });

  // `expected` is GitHub's count for the whole window, so what we hold has to
  // be counted across every run that has paged it, not just this one.
  const fetched = (saved?.fetched ?? 0) + res.fetched;
  const pages = (saved?.pages ?? 0) + res.pages;
  const stalled = !res.complete && pages >= MAX_WINDOW_PAGES;

  if (res.complete || stalled) {
    await setMeta(env, key, '');
  } else {
    await setMeta(env, key, JSON.stringify({
      since: from.toISOString(), until: to.toISOString(),
      after: res.after, fetched, pages,
    }));
  }

  return {
    nodes: res.nodes,
    complete: res.complete,
    stalled,
    since: from,
    until: to,
    expected: res.expected ?? fetched,
    fetched,
  };
}

/**
 * Flatten a node's comments (including discussion replies) into one sorted list.
 *
 * Returns two views. `activity` is everything fetched and drives who-owes-whom.
 * `store` is every real comment we can key by node id, and is what gets written.
 *
 * Storage is no longer a tail. Comments are keyed by GitHub's id and upserted,
 * so each poll adds what it saw and leaves the rest alone; the record only ever
 * grows. Review stubs carry no id and no body — they inform activity and are
 * not rows.
 */
function commentTail(node) {
  const flat = [];
  let topFetched = 0;
  let replyExpected = 0;
  let replyFetched = 0;
  for (const c of node.comments?.nodes ?? []) {
    if (!c) continue;
    topFetched++;
    flat.push(c);
    replyExpected += c.replies?.totalCount ?? 0;
    for (const r of c.replies?.nodes ?? []) {
      if (!r) continue;
      replyFetched++;
      flat.push({ ...r, parentId: c.id });
    }
  }
  for (const r of node.reviews?.nodes ?? []) {
    if (r?.createdAt) flat.push({ author: r.author, createdAt: r.createdAt, body: null, review: true });
  }
  flat.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return {
    activity: flat,
    store: flat.filter((c) => !c.review && c.id),
    // What GitHub says this thread holds, from its own counts. Replies can only
    // be counted for parents we actually read, so while top-level comments are
    // missing this is a floor rather than the truth — which is exactly why the
    // drain pages every parent before the gap is trusted to be zero.
    coverage: { expected: (node.comments?.totalCount ?? topFetched) + replyExpected,
      fetched: topFetched + replyFetched },
  };
}

function toRow(node, owner) {
  const kind = node.__typename === 'PullRequest' ? 'pr'
    : node.__typename === 'Discussion' ? 'discussion' : 'issue';
  const repo = node.repository.nameWithOwner;
  const id = `${repo}#${kind}#${node.number}`;
  const author = node.author?.login ?? null;
  const { activity, store, coverage } = commentTail(node);

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

  // Being tagged is a direct request for attention, so it is tracked
  // separately from ordinary inbound activity. The opening post counts: people
  // open an issue and tag you in the first paragraph.
  let lastMentionAt = null;
  let lastMentionActor = null;
  const noteMention = (who, at, text) => {
    if (!at || isOwner(who, owner) || !mentionsOwner(text, owner)) return;
    if (!lastMentionAt || Date.parse(at) > Date.parse(lastMentionAt)) {
      lastMentionAt = at;
      lastMentionActor = who ?? null;
    }
  };
  const bodyMentions = !isOwner(author, owner) && mentionsOwner(node.body, owner);
  noteMention(author, node.createdAt, node.body);
  for (const c of store) noteMention(c.author?.login, c.createdAt, c.body);

  // When GitHub considered this finished. Needed to answer "did someone turn up
  // after it was closed?", which is exactly the case that used to vanish.
  const resolvedAt = node.answerChosenAt ?? node.closedAt ?? null;

  return {
    tail: store,
    coverage,
    mentions: { at: lastMentionAt, actor: lastMentionActor },
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
      resolvedAt, lastMentionAt, lastMentionActor, bodyMentions ? 1 : 0,
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
  last_actor_at, last_owner_at, last_human_at, last_human_actor,
  resolved_at, last_mention_at, last_mention_actor, body_mentions_owner,
  first_seen_at, fetched_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    ELSE items.last_human_actor END,
  -- resolved_at tracks GitHub directly: reopening a thread clears it, and that
  -- is the correct answer rather than something to preserve.
  resolved_at=excluded.resolved_at, body_mentions_owner=excluded.body_mentions_owner,
  last_mention_at=CASE
    WHEN excluded.last_mention_at IS NULL THEN items.last_mention_at
    WHEN items.last_mention_at IS NULL THEN excluded.last_mention_at
    ELSE MAX(items.last_mention_at, excluded.last_mention_at) END,
  last_mention_actor=CASE
    WHEN excluded.last_mention_at IS NULL THEN items.last_mention_actor
    WHEN items.last_mention_at IS NULL OR excluded.last_mention_at >= items.last_mention_at
      THEN excluded.last_mention_actor
    ELSE items.last_mention_actor END`;

// Keyed on GitHub's node id, so re-seeing a comment updates it in place instead
// of requiring the whole tail to be deleted and rebuilt. `first_seen_at` is
// preserved on conflict: it records when this poller learned of the comment,
// which is the only honest answer to "would I have missed this?".
const UPSERT_COMMENT = `
INSERT INTO comments (gh_id, item_id, author, author_is_bot, created_at, body, mentions_owner, parent_gh_id, first_seen_at)
VALUES (?,?,?,?,?,?,?,?,?)
ON CONFLICT(gh_id) DO UPDATE SET
  body=excluded.body, author=excluded.author, author_is_bot=excluded.author_is_bot,
  mentions_owner=excluded.mentions_owner, parent_gh_id=excluded.parent_gh_id`;

/**
 * How far this thread is from complete, measured rather than assumed.
 *
 * `comment_total` only ever grows: a poll that read a narrow slice of a busy
 * thread must not be able to talk the expected count down. The gap is that
 * total against the rows actually stored, and because the comment upserts run
 * earlier in the same batch, the count already includes everything just read.
 * SQLite evaluates every SET expression against the pre-update row, so both
 * uses of `comment_total` below mean the same number.
 */
const UPDATE_GAP = `
UPDATE items SET
  comment_total = MAX(comment_total, ?),
  comment_gap = MAX(MAX(comment_total, ?)
    - (SELECT COUNT(*) FROM comments WHERE item_id = items.id), 0)
WHERE id = ?`;

/**
 * The same number, written by something that actually knows it.
 *
 * The sweep may only ratchet the expected total upwards, because it reads a
 * slice. A completed drain read the whole thread, so it sets the total outright
 * — otherwise a deleted comment leaves the ratcheted total permanently above
 * what exists, and the thread is redrained on every poll for a gap that can
 * never close.
 */
const SET_GAP = `
UPDATE items SET
  comment_total = ?,
  comment_gap = MAX(? - (SELECT COUNT(*) FROM comments WHERE item_id = items.id), 0)
WHERE id = ?`;

/** Bind one comment row, top-level or reply. */
const bindComment = (stmt, c, itemId, owner, now) => stmt.bind(
  c.id, itemId, c.author?.login ?? null,
  isBot(c.author?.login, c.author?.__typename) ? 1 : 0,
  c.createdAt ?? null, trunc(c.body, COMMENT_BODY_MAX),
  !isOwner(c.author?.login, owner) && mentionsOwner(c.body, owner) ? 1 : 0,
  c.parentId ?? null, now,
);

/** Run a list of prepared statements in D1-sized chunks. */
async function runBatched(env, stmts) {
  for (let i = 0; i < stmts.length; i += BATCH) {
    await env.DB.batch(stmts.slice(i, i + BATCH));
  }
}

async function persist(env, nodes) {
  const owner = ownerLogin(env);
  const now = new Date().toISOString();
  const upsert = env.DB.prepare(UPSERT);
  const upComment = env.DB.prepare(UPSERT_COMMENT);
  const upGap = env.DB.prepare(UPDATE_GAP);

  const stmts = [];
  let seen = 0;
  for (const node of nodes) {
    if (!node.repository) continue;
    seen++;
    const { id, values, tail, coverage } = toRow(node, owner);
    stmts.push(upsert.bind(...values, now, now));
    for (const c of tail) stmts.push(bindComment(upComment, c, id, owner, now));
    stmts.push(upGap.bind(coverage.expected, coverage.expected, id));
  }

  // D1 caps how much one batch may carry, so chunk. Every statement here is now
  // an idempotent upsert keyed on its own id, so a chunk boundary is just a
  // pause: a failure mid-run leaves earlier chunks applied and the next poll
  // re-applies the rest. That was not true while comments were rebuilt by
  // deleting the tail first.
  await runBatched(env, stmts);
  return seen;
}

/**
 * Go back for the comments the sweep could not reach.
 *
 * The sweep reads a tail of each thread, so a thread that gains more than
 * `ACTIVITY_TAIL` comments, or a discussion comment that gains more than
 * `REPLY_TAIL` replies, between two polls loses the oldest of them permanently:
 * the next poll reads the same tail from a newer end. Nothing errored, and the
 * feed — documented as containing every comment — quietly did not.
 *
 * This pass takes the threads with the largest known gap and pages their
 * comment connection to the end, a few threads per run. Storage is keyed on
 * GitHub's node id and upserted, so re-reading is free and a partial drain is
 * just a pause: the cursor is kept and the gap stays visible until the thread
 * is actually whole.
 */
async function drainThreads(env, report) {
  const owner = ownerLogin(env);
  const now = new Date().toISOString();
  const upComment = env.DB.prepare(UPSERT_COMMENT);
  const setGap = env.DB.prepare(SET_GAP);

  const gapped = await all(env, `
    SELECT id, node_id FROM items
    WHERE comment_gap > 0 AND node_id IS NOT NULL
    ORDER BY comment_gap DESC LIMIT ?`, DRAIN_THREADS);

  for (const item of gapped) {
    const key = `thread:${item.id}`;
    const saved = safeJson(await getMeta(env, key));
    let after = saved?.after ?? null;
    // Replies belong to individual parents, so they can only be tallied as they
    // are read and have to survive a paused drain. The top-level total is a
    // property of the thread and arrives whole on every page.
    let replies = saved?.replies ?? 0;
    let topTotal = 0;
    let complete = false;
    let unreachable = false;
    const stmts = [];

    for (let page = 0; page < DRAIN_PAGES; page++) {
      const data = await graphql(env, THREAD_QUERY, { id: item.node_id, after });
      const conn = data.node?.comments;
      // A node that no longer exposes comments — deleted, transferred, or a
      // kind this query has no fragment for — is a gap that can never be
      // closed. Zero it rather than let the drain pick the same thread every
      // run forever, and record nothing as missing, because nothing is.
      if (!conn) { complete = true; unreachable = true; after = null; break; }
      topTotal = conn.totalCount ?? 0;
      for (const c of conn.nodes ?? []) {
        if (!c?.id) continue;
        stmts.push(bindComment(upComment, c, item.id, owner, now));
        replies += c.replies?.totalCount ?? 0;
        for (const r of c.replies?.nodes ?? []) {
          if (r?.id) stmts.push(bindComment(upComment, { ...r, parentId: c.id }, item.id, owner, now));
        }
      }
      if (!conn.pageInfo?.hasNextPage) { complete = true; after = null; break; }
      after = conn.pageInfo.endCursor;
    }

    report.drained += stmts.length;
    // The expected total is only trustworthy once every parent has been read,
    // so the gap is recomputed at the end of a drain and left alone until then.
    if (unreachable) {
      stmts.push(env.DB.prepare('UPDATE items SET comment_gap = 0 WHERE id = ?').bind(item.id));
    } else if (complete) {
      stmts.push(setGap.bind(topTotal + replies, topTotal + replies, item.id));
    }
    await runBatched(env, stmts);
    await setMeta(env, key, complete ? '' : JSON.stringify({ after, replies }));

    if (!complete) report.threads_draining++;
  }
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
    incremental: 0, backfill: 0, mentions: 0, backfill_to: null, done: false,
    incremental_truncated: false, backfill_truncated: false, mentions_truncated: false,
    // GitHub's own count for every window this run touched, against what we
    // actually came away with. Independent of our paging: it is the difference
    // between "my loop finished" and "I hold what exists".
    expected: 0, fetched: 0,
    // Comments recovered by the drain, and threads it has not finished paging.
    drained: 0, threads_draining: 0,
    // Windows abandoned after exhausting their total page budget. Naming them
    // matters: this is the one place the poller knowingly moves past data it
    // never read.
    abandoned: [],
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
  //    A window that stops early is resumed on the next run from the cursor it
  //    stopped at, so the checkpoint stays where it is until the window is
  //    finished. Holding it back is the point: advancing past a window we only
  //    partly read is how results get skipped, and no later window returns for
  //    them.
  let hold = false;
  let truncated = false;
  let windowEnd = now;
  for (const type of ['ISSUE', 'DISCUSSION']) {
    const w = await runWindow(env, 'incremental', type, since, now, maxPages, { asc: true });
    report.expected += w.expected;
    report.fetched += w.fetched;
    report.incremental += await persist(env, w.nodes);
    if (w.complete) continue;
    truncated = true;
    if (w.stalled) {
      report.abandoned.push(`incremental:${type}`);
      // Give up on this window and let the clock move: its shortfall is already
      // in the coverage numbers, and blocking every future poll behind it would
      // trade a known gap for an unbounded one.
      if (w.until < windowEnd) windowEnd = w.until;
    } else {
      hold = true;
    }
  }
  report.incremental_truncated = truncated;
  if (!hold) await setMeta(env, 'last_ingest_at', windowEnd.toISOString());

  // 1b. Mentions anywhere, not just on the owner's own repos.
  //
  //     `user:jdx` already covers everything in his repositories, so this window
  //     exists purely for the other case: being tagged in somebody else's
  //     project. That is a GitHub notification with no other replacement, and
  //     it is the one class of miss that is completely invisible once
  //     notifications are off. Kept deliberately small — it is a safety net,
  //     not a second inbox.
  //     It keeps its own checkpoint. Riding `last_ingest_at` meant the shared
  //     checkpoint had already jumped forward on the strength of the
  //     owner-repository search, so anything this window did not reach was
  //     skipped rather than retried — and a failure here after that write had
  //     the same effect. Its truncation is reported separately too, because
  //     "mentions may be incomplete" is a different statement from "the main
  //     sweep may be incomplete".
  const owner = ownerLogin(env);
  const mentionSince = new Date(await getMeta(env, 'mentions_ingest_at', since.toISOString()));
  let mentionHold = false;
  let mentionEnd = now;
  for (const type of ['ISSUE', 'DISCUSSION']) {
    const w = await runWindow(env, 'mentions', type, mentionSince, now, 2,
      { asc: true, scope: `mentions:${owner}` });
    report.expected += w.expected;
    report.fetched += w.fetched;
    report.mentions += await persist(env, w.nodes);
    if (w.complete) continue;
    report.mentions_truncated = true;
    if (w.stalled) {
      report.abandoned.push(`mentions:${type}`);
      if (w.until < mentionEnd) mentionEnd = w.until;
    } else {
      mentionHold = true;
    }
  }
  if (!mentionHold) await setMeta(env, 'mentions_ingest_at', mentionEnd.toISOString());

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
    let backfillHold = false;
    let reached = from;
    for (const type of ['ISSUE', 'DISCUSSION']) {
      const w = await runWindow(env, 'backfill', type, from, cursor, 20);
      report.expected += w.expected;
      report.fetched += w.fetched;
      report.backfill += await persist(env, w.nodes);
      if (w.complete) continue;
      report.backfill_truncated = true;
      if (w.stalled) {
        report.abandoned.push(`backfill:${type}`);
        if (w.since > reached) reached = w.since;
      } else {
        backfillHold = true;
      }
    }
    // Walking backwards, the same rule: a window still draining keeps the
    // cursor where it is rather than stepping past its unread remainder.
    if (!backfillHold) {
      await setMeta(env, 'backfill_cursor', reached.toISOString());
      report.backfill_to = reached.toISOString();
    } else {
      report.backfill_to = cursor.toISOString();
    }
  } else {
    report.done = true;
  }

  // 3. Close the gaps inside threads the sweep only skimmed. A failure here is
  //    not a failed poll: the sweep's work is already committed, and the gaps
  //    it recorded stay recorded for the next run to pick up.
  try {
    await drainThreads(env, report);
  } catch (e) {
    report.drain_error = String(e?.message ?? e);
  }

  // Coverage gaps are the failure mode that quietly destroys trust in the board,
  // so the last run's shortfall is persisted for the UI rather than only logged.
  await setMeta(env, 'last_truncated',
    report.incremental_truncated || report.backfill_truncated ? now.toISOString() : '');
  await setMeta(env, 'mentions_truncated_at', report.mentions_truncated ? now.toISOString() : '');

  // The coverage check the feed could not previously make about itself.
  //
  // Truncation flags say a loop stopped early; they cannot say whether anything
  // was actually lost, because they are derived from the same paging that did
  // the losing. `issueCount` comes from GitHub, so comparing it against what we
  // hold answers the real question — and answers it even for a failure mode
  // nobody anticipated, which is the point of an independent check rather than
  // a wider net.
  //
  // `issueCount` counts threads, so on its own it can only ever see half the
  // question. A thread arrives complete as far as the search is concerned while
  // its bounded comment connection quietly omitted the tail, which is the case
  // that let coverage report a clean sync over a feed missing events. The
  // stored per-thread gap is the other half, and the shortfall is both.
  const gaps = await first(env, `
    SELECT COALESCE(SUM(comment_gap), 0) AS missing, COUNT(*) AS threads
    FROM items WHERE comment_gap > 0`);
  report.comments_missing = gaps?.missing ?? 0;
  report.threads_incomplete = gaps?.threads ?? 0;
  report.shortfall = Math.max(report.expected - report.fetched, 0) + report.comments_missing;
  await setMeta(env, 'last_coverage', JSON.stringify({
    at: now.toISOString(),
    expected: report.expected,
    fetched: report.fetched,
    comments_missing: report.comments_missing,
    threads_incomplete: report.threads_incomplete,
    abandoned: report.abandoned,
    shortfall: report.shortfall,
  }));
  await log(env, 'ingest', 'poll', null, report);
  return report;
}

/** Small helpers the API surfaces so the board can show ingest health. */
export async function ingestStatus(env) {
  const [lastIngest, cursor, truncated, mentionsTruncated, mentionsAt, coverageRaw, count] = await Promise.all([
    getMeta(env, 'last_ingest_at'),
    getMeta(env, 'backfill_cursor'),
    getMeta(env, 'last_truncated'),
    getMeta(env, 'mentions_truncated_at'),
    getMeta(env, 'mentions_ingest_at'),
    getMeta(env, 'last_coverage'),
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
    // Reported apart from the main sweep: the cross-repository mention search
    // is the stream with no other safety net once notifications are off.
    mentions_ingest: mentionsAt || null,
    mentions_truncated: mentionsTruncated || null,
    // The one number that is not self-reported: GitHub's count for the windows
    // the last run touched, against what it came away with.
    coverage: safeJson(coverageRaw),
    items: count?.c ?? 0,
  };
}
