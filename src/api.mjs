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

const OUTCOMES = new Set(['ignored', 'responded', 'pr_opened', 'closed', 'waiting']);

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
  i.last_human_actor`;

const TRIAGE_COLUMNS = `
  t.outcome, t.note, t.marked_by, t.marked_at, t.marked_at_activity, t.snoozed_until`;

const PENDING_DRAFTS =
  "(SELECT COUNT(*) FROM drafts d WHERE d.item_id = i.id AND d.status = 'pending') AS pending_drafts";

const OPEN_REQUESTS = `(SELECT COUNT(*) FROM draft_requests r
   WHERE r.item_id = i.id AND r.status IN ('pending','claimed')) AS open_requests`;

const listSql = (where) => `
SELECT ${LIST_COLUMNS}, ${TRIAGE_COLUMNS}, ${PENDING_DRAFTS}, ${OPEN_REQUESTS}
FROM items i LEFT JOIN triage t ON t.item_id = i.id
${where}`;

function decorate(row) {
  const s = computeState(row, row);
  return {
    ...row,
    labels: JSON.parse(row.labels || '[]'),
    triage_state: s.state,
    triage_reason: s.reason,
    outcome: row.outcome ?? null,
    note: row.note ?? null,
    marked_by: row.marked_by ?? null,
    marked_at: row.marked_at ?? null,
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
  let out = rows.map(decorate);
  if (wanted && wanted !== 'all') out = out.filter((i) => i.triage_state === wanted);

  out.sort((a, b) =>
    b.priority - a.priority
    || Date.parse(b.last_human_at || b.updated_at) - Date.parse(a.last_human_at || a.updated_at));

  const limit = Math.min(Number(params.get('limit') || 200), 500);
  const offset = Number(params.get('offset') || 0);
  return { total: out.length, items: out.slice(offset, offset + limit) };
}

async function itemDetail(env, id) {
  const row = await first(env, `${listSql('WHERE i.id = ?')} LIMIT 1`, id);
  if (!row) return null;

  const [full, comments, drafts, requests] = await Promise.all([
    first(env, 'SELECT body, body_truncated, node_id FROM items WHERE id = ?', id),
    all(env, 'SELECT * FROM comments WHERE item_id = ? ORDER BY seq', id),
    all(env, 'SELECT * FROM drafts WHERE item_id = ? ORDER BY id DESC', id),
    all(env, 'SELECT * FROM draft_requests WHERE item_id = ? ORDER BY id DESC LIMIT 5', id),
  ]);

  return {
    item: {
      ...decorate(row),
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

  if (action === 'cancel') {
    await run(env, "UPDATE draft_requests SET status='cancelled', completed_at=? WHERE id=?",
      now, requestId);
    await log(env, identity.actor, 'draft.request.cancel', req.item_id, { request_id: requestId });
    return { status: 200, body: await itemDetail(env, req.item_id) };
  }

  // complete: either a draft landed, or the drafter is reporting why it did not.
  // A failure must be recorded rather than leaving the request claimed forever,
  // because a stuck 'claimed' row looks identical to an agent that is still
  // thinking.
  const failed = !!body.error;
  await run(env, `
    UPDATE draft_requests SET status=?, completed_at=?, draft_id=?, error=? WHERE id=?`,
    failed ? 'failed' : 'done', now, body.draft_id ?? null, body.error ?? null, requestId);
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
  const until = new Date(Date.now() + Number(days || 7) * 86400000).toISOString();
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
  // Counts only — no bodies, no titles. This is the request the board makes
  // most often, so it stays as cheap as possible.
  const [byState, byRepo, pending, ingest] = await Promise.all([
    all(env, `
      SELECT ${LIST_COLUMNS}, ${TRIAGE_COLUMNS}
      FROM items i LEFT JOIN triage t ON t.item_id = i.id`),
    all(env, 'SELECT repo, COUNT(*) AS c FROM items GROUP BY repo ORDER BY c DESC'),
    first(env, "SELECT COUNT(*) AS c FROM drafts WHERE status='pending'"),
    ingestStatus(env),
  ]);

  const counts = {};
  for (const r of byState) {
    const s = computeState(r, r).state;
    counts[s] = (counts[s] || 0) + 1;
  }

  return {
    total: byState.length,
    by_state: counts,
    inbox: counts.needs_you ?? 0,
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
    await run(env, 'UPDATE drafts SET body = ? WHERE id = ?', String(body.body ?? ''), draftId);
    await log(env, identity.actor, 'draft.edit', draft.item_id, { draft_id: draftId });
    return { status: 200, body: await itemDetail(env, draft.item_id) };
  }

  if (action === 'reject') {
    await run(env, "UPDATE drafts SET status='rejected', decided_by=?, decided_at=? WHERE id=?",
      identity.actor, new Date().toISOString(), draftId);
    await log(env, identity.actor, 'draft.reject', draft.item_id, { draft_id: draftId });
    return { status: 200, body: await itemDetail(env, draft.item_id) };
  }

  // approve == the only path in this project that talks to GitHub.
  // canApprove comes from a verified Access JWT carrying the owner's email. A
  // service token cannot produce that claim, so the agent cannot reach here.
  if (!identity.canApprove) {
    return { status: 403, body: { error: 'only the owner can approve a post' } };
  }
  if (draft.status !== 'pending') return { status: 409, body: { error: `draft is ${draft.status}` } };

  const item = await first(env, 'SELECT * FROM items WHERE id = ?', draft.item_id);
  const now = new Date().toISOString();
  try {
    const url = await postComment(env, item, draft.body);
    await run(env,
      "UPDATE drafts SET status='posted', decided_by=?, decided_at=?, posted_at=?, result_url=? WHERE id=?",
      identity.actor, now, now, url, draftId);
    await log(env, identity.actor, 'draft.posted', draft.item_id, { draft_id: draftId, url });
    await mark(env, draft.item_id, { outcome: 'responded', actor: identity.actor });
  } catch (e) {
    await run(env, "UPDATE drafts SET status='failed', error=? WHERE id=?", String(e.message), draftId);
    await log(env, identity.actor, 'draft.failed', draft.item_id,
      { draft_id: draftId, error: String(e.message) });
    return { status: 502, body: { error: String(e.message) } };
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
      return { status: 200, body: await snooze(env, id, b.days, identity.actor) };
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
