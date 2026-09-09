/**
 * JSON API. Every handler receives an already-verified Access identity; none of
 * them re-derive privilege from a header.
 */
import { all, first, log, run } from './db.mjs';
import { computeState, priority } from './state.mjs';
import { scanUntrusted } from './scan.mjs';
import { postComment } from './post.mjs';
import { ingestOnce, ingestStatus } from './ingest.mjs';
import { ownerLogin } from './config.mjs';

/**
 * `dismissed` is the neutral one, and the reason it exists is that the others
 * all assert *why*: you responded, you opened a PR, you closed it. Most of what
 * comes off a board is none of those — it is "not this, not now" — and being
 * made to claim a reason you did not have is what stops people clearing a queue
 * at all. It settles exactly like the rest: a person arriving afterwards brings
 * it straight back, which is what makes it a dismissal rather than an ignore.
 */
const OUTCOMES = new Set(['responded', 'pr_opened', 'closed', 'waiting', 'dismissed']);

/**
 * The list view never selects `body`. With a few thousand items the bodies are
 * megabytes of untrusted text that the board does not display until you open
 * something — pulling them per request would dominate both D1 read units and
 * the response size.
 */
const LIST_COLUMNS = `
  i.id, i.repo, i.kind, i.number, i.title, i.url, i.author, i.author_is_bot,
  i.author_assoc, i.state, i.is_answered, i.is_draft, i.locked, i.labels,
  i.category, i.comment_count, i.created_at, i.updated_at, i.last_actor,
  i.last_actor_is_bot, i.last_actor_at, i.last_owner_at, i.last_human_at,
  i.last_human_actor, i.resolved_at, i.last_mention_at, i.last_mention_actor`;

const TRIAGE_COLUMNS = `
  t.outcome, t.note, t.marked_by, t.marked_at, t.marked_at_activity, t.snoozed_until`;

/**
 * Exactly what computeState reads, and nothing else. /api/stats runs on every
 * board refresh alongside /api/items; selecting the full LIST_COLUMNS here made
 * the cheapest request in the app scan the same width as the most expensive one.
 *
 * Keep this in step with computeState, and treat a mismatch as a bug rather than
 * a cost saving. Release detection added `kind`, `title`, `labels` and
 * `author_is_bot`; without them stats silently counted release PRs as inbox
 * while /api/items filed them under Releases, so the badge disagreed with the
 * list it was counting. `is_draft` arrived the same way, with the owner's own
 * open PRs.
 */
const STATE_COLUMNS = `
  i.state, i.is_answered, i.resolved_at, i.last_actor, i.last_actor_at,
  i.last_owner_at, i.last_human_at, i.last_human_actor, i.last_mention_at,
  i.kind, i.title, i.labels, i.author, i.author_is_bot, i.is_draft,
  t.outcome, t.marked_at_activity, t.snoozed_until`;

const PENDING_DRAFTS =
  "(SELECT COUNT(*) FROM drafts d WHERE d.item_id = i.id AND d.status = 'pending') AS pending_drafts";

const OPEN_REQUESTS = `(SELECT COUNT(*) FROM draft_requests r
   WHERE r.item_id = i.id AND r.status IN ('pending','claimed')) AS open_requests`;

const listSql = (where) => `
SELECT ${LIST_COLUMNS}, ${TRIAGE_COLUMNS}, ${PENDING_DRAFTS}, ${OPEN_REQUESTS}
FROM items i LEFT JOIN triage t ON t.item_id = i.id
${where}`;

function decorate(row, owner) {
  const s = computeState(row, row, owner);
  return {
    ...row,
    labels: JSON.parse(row.labels || '[]'),
    triage_state: s.state,
    triage_reason: s.reason,
    outcome: row.outcome ?? null,
    note: row.note ?? null,
    marked_by: row.marked_by ?? null,
    marked_at: row.marked_at ?? null,
    last_mention_at: row.last_mention_at ?? null,
    last_mention_actor: row.last_mention_actor ?? null,
    resolved_at: row.resolved_at ?? null,
    snoozed_until: row.snoozed_until ?? null,
    priority: priority(row, s.state),
    pending_drafts: row.pending_drafts ?? 0,
    open_requests: row.open_requests ?? 0,
  };
}

async function listItems(env, params) {
  // repo / kind / q narrow in SQL. Triage state cannot: it depends on the
  // current clock and on the triage row, so it is computed after the read.
  const where = [];
  const binds = [];
  if (params.get('repo')) { where.push('i.repo = ?'); binds.push(params.get('repo')); }
  if (params.get('kind')) { where.push('i.kind = ?'); binds.push(params.get('kind')); }
  const q = (params.get('q') || '').trim();
  if (q) {
    where.push('(i.title LIKE ? COLLATE NOCASE OR i.author LIKE ? COLLATE NOCASE)');
    binds.push(`%${q}%`, `%${q}%`);
  }

  const rows = await all(
    env, listSql(where.length ? `WHERE ${where.join(' AND ')}` : ''), ...binds,
  );

  const wanted = params.get('state');
  let out = rows.map((row) => decorate(row, ownerLogin(env)));
  if (wanted && wanted !== 'all') out = out.filter((i) => i.triage_state === wanted);

  // Outstanding mentions: tagged, not since answered, and still actionable.
  //
  // The triage_state test is the load-bearing half. Without it, marking responded or
  // snoozing a mention left it sitting in the Mentions list while the badge —
  // which counts only actionable items — went down, so the tab claimed one
  // thing and the count another. Dismissal has to work here like everywhere.
  if (params.get('mentions') === '1') {
    out = out.filter((i) => isOutstandingMention(i) && i.triage_state === 'needs_you');
  }

  out.sort((a, b) =>
    b.priority - a.priority
    || Date.parse(b.last_human_at || b.updated_at) - Date.parse(a.last_human_at || a.updated_at));

  // Parse defensively: `?limit=all` used to reach Math.min(NaN, 500) and return
  // a 200 claiming `total: 812` with an empty array. A bad page argument is the
  // caller's mistake, but silently answering "there are 812, here are none" is
  // ours.
  const limit = clampInt(params.get('limit'), 200, 1, 500);
  const offset = clampInt(params.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  return { total: out.length, limit, offset, items: out.slice(offset, offset + limit) };
}

/**
 * Everything that happened, newest first.
 *
 * This is the audit surface rather than the work surface. The board answers
 * "what needs me"; the feed answers "what has actually been going on", which is
 * how you check the poller is doing its job. It deliberately shows bot activity
 * and resolved threads — the things triage filters out are exactly the things
 * you want visible when you are verifying coverage.
 */
async function feed(env, params) {
  const where = [];
  const binds = [];
  if (params.get('repo')) { where.push('repo = ?'); binds.push(params.get('repo')); }
  if (params.get('kind')) { where.push('item_kind = ?'); binds.push(params.get('kind')); }
  if (params.get('mentions') === '1') where.push('mentions_owner = 1');
  if (params.get('humans') === '1') where.push('actor_is_bot = 0');

  const limit = clampInt(params.get('limit'), 100, 1, 500);

  // Keyset, not offset.
  //
  // The feed reads a table scheduled ingestion writes to. With numeric offsets,
  // any event inserted between two page requests shifts every later offset by
  // one, so "older" hands back a row the previous page already showed. An audit
  // surface that repeats and drops rows while you page through it cannot be
  // used to check the poller, which is the only reason it exists.
  //
  // `(at, gh_id)` is unique and totally ordered, so a cursor names a position
  // in the data rather than a count of rows before it. Inserts land above the
  // cursor and leave the page you asked for exactly where it was.
  const cursor = parseCursor(params.get('cursor'));
  if (cursor) {
    where.push('(at < ? OR (at = ? AND gh_id < ?))');
    binds.push(cursor.at, cursor.at, cursor.id);
  }

  // Opening a thread is an event too, so the feed unions comments with the
  // items themselves. Both sides carry the same shape.
  const sql = `
    SELECT * FROM (
      SELECT c.created_at AS at, 'comment' AS event, c.author AS actor,
             c.author_is_bot AS actor_is_bot, c.body AS body,
             c.mentions_owner AS mentions_owner, c.gh_id AS gh_id,
             i.id AS item_id, i.repo AS repo, i.kind AS item_kind,
             i.number AS number, i.title AS title, i.url AS url
      FROM comments c JOIN items i ON i.id = c.item_id
      UNION ALL
      SELECT i.created_at AS at, 'opened' AS event, i.author AS actor,
             i.author_is_bot AS actor_is_bot, NULL AS body,
             -- The opening post's own flag, not the item's aggregate: that
             -- aggregate may refer to a later comment, which would put the
             -- wrong event in a mentions-filtered feed.
             i.body_mentions_owner AS mentions_owner, i.id AS gh_id,
             i.id AS item_id, i.repo AS repo, i.kind AS item_kind,
             i.number AS number, i.title AS title, i.url AS url
      FROM items i
    )
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY at DESC, gh_id DESC LIMIT ?`;

  const rows = await all(env, sql, ...binds, limit + 1);
  const events = rows.slice(0, limit);
  const last = events[events.length - 1];
  return {
    limit,
    // No COUNT(*) over the union on every page — the feed is scrolled, not
    // counted, so it reports only whether another page exists.
    has_more: rows.length > limit,
    next_cursor: rows.length > limit && last ? `${last.at}|${last.gh_id}` : null,
    events,
  };
}

/** `at|gh_id`, as handed back by the previous page. Anything else is page one. */
function parseCursor(raw) {
  const cut = raw ? raw.indexOf('|') : -1;
  if (cut < 1) return null;
  const at = raw.slice(0, cut);
  const id = raw.slice(cut + 1);
  return id ? { at, id } : null;
}

/**
 * A mention still waiting on the owner. Shared so the list filter and the badge
 * cannot drift apart; they disagreeing is what made dismissal look broken.
 */
function isOutstandingMention(row) {
  return !!row.last_mention_at
    && (!row.last_owner_at || Date.parse(row.last_mention_at) > Date.parse(row.last_owner_at));
}

/** Integer query params: fall back to `dflt` unless the value is a real number. */
function clampInt(raw, dflt, min, max) {
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

async function itemDetail(env, id) {
  const row = await first(env, `${listSql('WHERE i.id = ?')} LIMIT 1`, id);
  if (!row) return null;

  const [full, comments, drafts, requests] = await Promise.all([
    first(env, 'SELECT body, body_truncated, node_id FROM items WHERE id = ?', id),
    // Storage is now unbounded, so the display slice is chosen here rather than
    // by throwing older comments away at ingest. Newest 50, shown oldest-first.
    all(env, `SELECT * FROM (
        SELECT * FROM comments WHERE item_id = ? ORDER BY created_at DESC LIMIT 50
      ) ORDER BY created_at`, id),
    all(env, 'SELECT * FROM drafts WHERE item_id = ? ORDER BY id DESC', id),
    all(env, 'SELECT * FROM draft_requests WHERE item_id = ? ORDER BY id DESC LIMIT 5', id),
  ]);

  return {
    item: {
      ...decorate(row, ownerLogin(env)),
      body: full?.body ?? null,
      body_truncated: full?.body_truncated ?? 0,
      injection_flags: scanUntrusted(row.title, full?.body, ...comments.map((c) => c.body)),
    },
    comments,
    drafts: drafts.map((d) => ({ ...d, flags: JSON.parse(d.flags || '[]') })),
    draft_requests: requests,
  };
}

/**
 * Ask jdx-bot for a draft. Anyone Access lets through may queue one — a request
 * is only a note in a table, and the thing that actually reaches GitHub is
 * still gated on the owner's email at approve time.
 */
async function requestDraft(env, id, note, identity) {
  if (!(await first(env, 'SELECT 1 AS ok FROM items WHERE id = ?', id))) {
    return { status: 404, body: { error: 'unknown item' } };
  }
  try {
    const res = await run(env, `
      INSERT INTO draft_requests (item_id, requested_by, requested_at, note)
      VALUES (?,?,?,?)`,
      id, identity.actor, new Date().toISOString(), note ?? null);
    await log(env, identity.actor, 'draft.request', id,
      { request_id: res.meta?.last_row_id ?? null, note: note ?? null });
  } catch (e) {
    // The partial unique index rejects a second open request for the same item,
    // so a double click cannot produce two drafts of the same reply.
    if (/UNIQUE|constraint/i.test(String(e.message))) {
      return { status: 409, body: { error: 'a draft is already queued for this item' } };
    }
    throw e;
  }
  return { status: 200, body: await itemDetail(env, id) };
}

/**
 * The drafting agent's side of the queue: list what is waiting, claim one, then
 * report what happened. Claiming is a conditional UPDATE rather than a
 * read-then-write so two overlapping polls cannot both take the same request.
 */
async function handleQueue(env, requestId, action, body, identity) {
  const now = new Date().toISOString();

  if (action === 'claim') {
    const res = await run(env, `
      UPDATE draft_requests SET status='claimed', claimed_by=?, claimed_at=?
      WHERE id=? AND status='pending'`, identity.actor, now, requestId);
    if (!res.meta?.changes) {
      const cur = await first(env, 'SELECT status FROM draft_requests WHERE id=?', requestId);
      return cur
        ? { status: 409, body: { error: `request is ${cur.status}` } }
        : { status: 404, body: { error: 'no such request' } };
    }
    const req = await first(env, 'SELECT * FROM draft_requests WHERE id=?', requestId);
    return { status: 200, body: { request: req, detail: await itemDetail(env, req.item_id) } };
  }

  const req = await first(env, 'SELECT * FROM draft_requests WHERE id=?', requestId);
  if (!req) return { status: 404, body: { error: 'no such request' } };

  // Both transitions below are guarded on the states they may legally leave.
  // Without the guard a stale board could cancel an already-completed request,
  // flipping a finished row to 'cancelled' and orphaning the draft it produced.
  const OPEN = "status IN ('pending','claimed')";

  if (action === 'cancel') {
    const res = await run(env,
      `UPDATE draft_requests SET status='cancelled', completed_at=? WHERE id=? AND ${OPEN}`,
      now, requestId);
    if (!res.meta?.changes) return { status: 409, body: { error: `request is ${req.status}` } };
    await log(env, identity.actor, 'draft.request.cancel', req.item_id, { request_id: requestId });
    return { status: 200, body: await itemDetail(env, req.item_id) };
  }

  // complete: either a draft landed, or the drafter is reporting why it did not.
  // A failure must be recorded rather than leaving the request claimed forever,
  // because a stuck 'claimed' row looks identical to an agent that is still
  // thinking.
  const failed = !!body.error;

  // A success has to name a draft, and that draft has to belong to this
  // request's item. Completed requests leave the open queue and item detail
  // only shows drafts matching its own item_id, so a malformed agent response
  // could otherwise close the request and take the draft with it — the work
  // reported done, nothing to show for it, and no row left saying so.
  if (!failed) {
    const draftId = Number(body.draft_id);
    if (!Number.isInteger(draftId)) {
      return { status: 400, body: { error: 'completing a request requires draft_id' } };
    }
    const d = await first(env, 'SELECT item_id FROM drafts WHERE id=?', draftId);
    if (!d) return { status: 400, body: { error: 'no such draft' } };
    if (d.item_id !== req.item_id) {
      return { status: 400, body: { error: 'draft belongs to a different item' } };
    }
  }

  const res = await run(env, `
    UPDATE draft_requests SET status=?, completed_at=?, draft_id=?, error=?
    WHERE id=? AND ${OPEN}`,
    failed ? 'failed' : 'done', now, body.draft_id ?? null, body.error ?? null, requestId);
  if (!res.meta?.changes) return { status: 409, body: { error: `request is ${req.status}` } };
  await log(env, identity.actor, failed ? 'draft.request.failed' : 'draft.request.done',
    req.item_id, { request_id: requestId, draft_id: body.draft_id ?? null, error: body.error ?? null });
  return { status: 200, body: await itemDetail(env, req.item_id) };
}

async function mark(env, id, { outcome, note, actor }) {
  const item = await first(env, 'SELECT last_human_at FROM items WHERE id = ?', id);
  if (!item) return { error: 'unknown item' };
  if (outcome && !OUTCOMES.has(outcome)) return { error: 'bad outcome' };

  const now = new Date().toISOString();
  if (!outcome) {
    await run(env, 'DELETE FROM triage WHERE item_id = ?', id);
    await log(env, actor, 'unmark', id, null);
  } else {
    await run(env, `
      INSERT INTO triage (item_id, outcome, marked_by, marked_at, marked_at_activity, note)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET outcome=excluded.outcome, marked_by=excluded.marked_by,
        marked_at=excluded.marked_at, marked_at_activity=excluded.marked_at_activity,
        note=COALESCE(excluded.note, triage.note), snoozed_until=NULL`,
      id, outcome, actor, now, item.last_human_at ?? now, note ?? null);
    await log(env, actor, 'mark', id, { outcome, note: note ?? null });
  }
  return itemDetail(env, id);
}

async function snooze(env, id, days, actor) {
  // `{"days":"7d"}` used to produce new Date(NaN).toISOString(), which throws
  // RangeError and surfaced as a 500 with a raw JS message.
  const n = Number(days ?? 7);
  if (!Number.isFinite(n) || n <= 0 || n > 3650) {
    return { error: 'days must be a number between 1 and 3650' };
  }
  const until = new Date(Date.now() + n * 86400000).toISOString();
  await run(env, `
    INSERT INTO triage (item_id, snoozed_until, marked_by, marked_at)
    VALUES (?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET snoozed_until=excluded.snoozed_until,
      marked_by=excluded.marked_by, marked_at=excluded.marked_at`,
    id, until, actor, new Date().toISOString());
  await log(env, actor, 'snooze', id, { until });
  return itemDetail(env, id);
}

async function stats(env) {
  const owner = ownerLogin(env);
  // Counts only — no bodies, no titles. This is the request the board makes
  // most often, so it stays as cheap as possible.
  const [byState, byRepo, pending, ingest] = await Promise.all([
    all(env, `
      SELECT ${STATE_COLUMNS}
      FROM items i LEFT JOIN triage t ON t.item_id = i.id`),
    all(env, 'SELECT repo, COUNT(*) AS c FROM items GROUP BY repo ORDER BY c DESC'),
    first(env, "SELECT COUNT(*) AS c FROM drafts WHERE status='pending'"),
    ingestStatus(env),
  ]);

  const counts = {};
  let mentions = 0;
  for (const r of byState) {
    const s = computeState(r, r, owner).state;
    counts[s] = (counts[s] || 0) + 1;
    // Mentions worth surfacing are the ones still waiting on the owner; a tag
    // you have already replied to is not outstanding.
    if (s === 'needs_you' && isOutstandingMention(r)) mentions++;
  }

  return {
    total: byState.length,
    by_state: counts,
    inbox: counts.needs_you ?? 0,
    mentions,
    by_repo: Object.fromEntries(byRepo.map((r) => [r.repo, r.c])),
    repos: byRepo.map((r) => r.repo).sort(),
    pending_drafts: pending?.c ?? 0,
    owner: ownerLogin(env),
    ...ingest,
  };
}

async function handleDraftAction(env, draftId, action, body, identity) {
  const draft = await first(env, 'SELECT * FROM drafts WHERE id = ?', draftId);
  if (!draft) return { status: 404, body: { error: 'no such draft' } };

  if (action === 'edit') {
    if (draft.status !== 'pending') return { status: 409, body: { error: `draft is ${draft.status}` } };
    // Every edit bumps the revision. That is what lets approve tell "the text I
    // read" from "the text that is there now".
    //
    // RETURNING matters here: it hands back the revision *this* UPDATE
    // produced. Reading it from a later itemDetail snapshot instead would let
    // an agent edit landing in the gap supply its own revision to the caller,
    // which the browser would then approve without ever displaying — the exact
    // hole the revision check exists to close.
    const updated = await first(env,
      `UPDATE drafts SET body=?, revision=revision+1
       WHERE id=? AND status='pending' RETURNING revision`,
      String(body.body ?? ''), draftId);
    if (!updated) return { status: 409, body: { error: 'draft is no longer pending' } };
    await log(env, identity.actor, 'draft.edit', draft.item_id,
      { draft_id: draftId, revision: updated.revision });
    return {
      status: 200,
      body: { ...(await itemDetail(env, draft.item_id)), edited_revision: updated.revision },
    };
  }

  if (action === 'reject') {
    // Guarded on `pending` for the same reason approve is. Without it a stale
    // tab could reject a draft that has already been posted, or discard could
    // race an in-flight approval that had moved the row to `approving` — either
    // way the database and audit log would record a rejection while a comment
    // exists on GitHub.
    const res = await run(env,
      "UPDATE drafts SET status='rejected', decided_by=?, decided_at=? WHERE id=? AND status='pending'",
      identity.actor, new Date().toISOString(), draftId);
    if (!res.meta?.changes) {
      const cur = await first(env, 'SELECT status FROM drafts WHERE id=?', draftId);
      return { status: 409, body: { error: `draft is ${cur?.status ?? 'gone'}` } };
    }
    await log(env, identity.actor, 'draft.reject', draft.item_id, { draft_id: draftId });
    return { status: 200, body: await itemDetail(env, draft.item_id) };
  }

  // approve == the only path in this project that talks to GitHub.
  // canApprove comes from a verified Access JWT carrying the owner's email. A
  // service token cannot produce that claim, so the agent cannot reach here.
  if (!identity.canApprove) {
    return { status: 403, body: { error: 'only the owner can approve a post' } };
  }

  // Approval names a revision, not just a draft. Clicking approve means "post
  // the text I just read"; without the revision the server only hears "post
  // whatever is in row 41 right now", and the agent may have rewritten it since
  // the pane was rendered.
  const expected = Number(body.expected_revision);
  if (!Number.isInteger(expected)) {
    return { status: 400, body: { error: 'expected_revision is required to approve' } };
  }

  const now = new Date().toISOString();

  // One conditional UPDATE answers both questions — still pending, and still
  // the revision you read — and claims the draft in the same statement. Two
  // concurrent approvals cannot both pass it, so the comment cannot be posted
  // twice. The previous read-check-write did allow exactly that.
  const claim = await run(env, `
    UPDATE drafts SET status='approving', decided_by=?, decided_at=?
    WHERE id=? AND status='pending' AND revision=?`,
    identity.actor, now, draftId, expected);

  if (!claim.meta?.changes) {
    const cur = await first(env, 'SELECT status, revision FROM drafts WHERE id=?', draftId);
    if (!cur) return { status: 404, body: { error: 'no such draft' } };
    if (cur.status !== 'pending') return { status: 409, body: { error: `draft is ${cur.status}` } };
    return {
      status: 409,
      body: {
        error: 'this draft changed since you read it — review it again before approving',
        revision: cur.revision,
      },
    };
  }

  // Read the body *after* the claim. `edit` only touches pending rows, so from
  // here the text is frozen and what we post is what was approved.
  const claimed = await first(env, 'SELECT body FROM drafts WHERE id = ?', draftId);
  const item = await first(env, 'SELECT * FROM items WHERE id = ?', draft.item_id);

  try {
    const url = await postComment(env, item, claimed.body);
    await run(env,
      "UPDATE drafts SET status='posted', posted_at=?, result_url=? WHERE id=?",
      now, url, draftId);
    await log(env, identity.actor, 'draft.posted', draft.item_id,
      { draft_id: draftId, revision: expected, url });
    await mark(env, draft.item_id, { outcome: 'responded', actor: identity.actor });
  } catch (e) {
    // A refused request definitely posted nothing. A dropped connection or a
    // 5xx might have posted and lost the response — resolving that by retrying
    // is how you double-post. Park it as 'uncertain' and make a human look.
    const status = e?.uncertain ? 'uncertain' : 'failed';
    await run(env, 'UPDATE drafts SET status=?, error=? WHERE id=?',
      status, String(e.message), draftId);
    await log(env, identity.actor, `draft.${status}`, draft.item_id,
      { draft_id: draftId, error: String(e.message) });
    return {
      status: 502,
      body: {
        error: e?.uncertain
          ? `GitHub did not confirm this post: ${e.message}. Check the thread before retrying.`
          : String(e.message),
        outcome: status,
      },
    };
  }
  return { status: 200, body: await itemDetail(env, draft.item_id) };
}

/** Returns { status, body }. Routing only; no privilege decisions live here. */
export async function handleApi(request, env, ctx, identity) {
  const url = new URL(request.url);
  const p = url.pathname;
  const method = request.method;
  const json = async () => {
    const text = await request.text();
    if (text.length > 1_000_000) throw new Error('body too large');
    return text ? JSON.parse(text) : {};
  };

  if (method === 'GET' && p === '/api/stats') return { status: 200, body: await stats(env) };
  if (method === 'GET' && p === '/api/items') {
    return { status: 200, body: await listItems(env, url.searchParams) };
  }
  if (method === 'GET' && p === '/api/feed') {
    return { status: 200, body: await feed(env, url.searchParams) };
  }
  if (method === 'GET' && p === '/api/events') {
    return { status: 200, body: await all(env, 'SELECT * FROM events ORDER BY id DESC LIMIT 200') };
  }
  if (method === 'GET' && p === '/api/whoami') {
    return {
      status: 200,
      body: {
        actor: identity.actor,
        email: identity.email,
        can_approve: identity.canApprove,
        service_token: identity.serviceToken ?? null,
      },
    };
  }

  // Manual refresh. Cheap enough to allow either identity: it only reads from
  // GitHub and writes to our own database.
  if (method === 'POST' && p === '/api/ingest') {
    return { status: 200, body: await ingestOnce(env, { full: true }) };
  }

  // The drafting queue. GET is how jdx-bot finds work; the rest is how it
  // reports back. `draft-request` must precede `draft` in the item route's
  // alternation below, or the shorter name wins the match.
  if (method === 'GET' && p === '/api/draft-requests') {
    const status = url.searchParams.get('status') || 'pending';
    return {
      status: 200,
      body: await all(env, `
        SELECT r.*, i.repo, i.kind, i.number, i.title, i.url
        FROM draft_requests r JOIN items i ON i.id = r.item_id
        WHERE r.status = ? ORDER BY r.id LIMIT 50`, status),
    };
  }

  const queueMatch = p.match(/^\/api\/draft-requests\/(\d+)\/(claim|complete|cancel)$/);
  if (queueMatch && method === 'POST') {
    return handleQueue(env, Number(queueMatch[1]), queueMatch[2], await json(), identity);
  }

  const itemMatch = p.match(/^\/api\/items\/(.+?)(?:\/(mark|snooze|draft-request|draft))?$/);
  if (itemMatch) {
    const id = decodeURIComponent(itemMatch[1]);
    const action = itemMatch[2];

    if (method === 'GET' && !action) {
      const d = await itemDetail(env, id);
      return d ? { status: 200, body: d } : { status: 404, body: { error: 'not found' } };
    }
    if (method === 'POST' && action === 'mark') {
      const b = await json();
      const r = await mark(env, id, { ...b, actor: identity.actor });
      return r?.error ? { status: 400, body: r } : { status: 200, body: r };
    }
    if (method === 'POST' && action === 'snooze') {
      const b = await json();
      const r = await snooze(env, id, b.days, identity.actor);
      return r?.error ? { status: 400, body: r } : { status: 200, body: r };
    }
    if (method === 'POST' && action === 'draft-request') {
      const b = await json();
      return requestDraft(env, id, b.note, identity);
    }
    if (method === 'POST' && action === 'draft') {
      const b = await json();
      if (!b.body?.trim()) return { status: 400, body: { error: 'empty draft' } };
      const res = await run(env, `
        INSERT INTO drafts (item_id, kind, body, rationale, confidence, flags, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        id, b.kind || 'comment', b.body, b.rationale ?? null, b.confidence ?? null,
        JSON.stringify(b.flags ?? []), identity.actor, new Date().toISOString());
      await log(env, identity.actor, 'draft.create', id, { draft_id: res.meta?.last_row_id ?? null });
      return { status: 200, body: await itemDetail(env, id) };
    }
  }

  const draftMatch = p.match(/^\/api\/drafts\/(\d+)\/(approve|reject|edit)$/);
  if (draftMatch && method === 'POST') {
    return handleDraftAction(env, Number(draftMatch[1]), draftMatch[2], await json(), identity);
  }

  return { status: 404, body: { error: 'no route' } };
}
