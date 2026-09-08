#!/usr/bin/env node
/**
 * gh-inbox API + dashboard. Binds to loopback; expose over the tailnet with
 * `tailscale serve`. See README for the security model.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { open, log } from './lib/db.mjs';
import { computeState, priority } from './lib/state.mjs';
import { ROOT, PORT, OWNER_LOGIN } from './lib/config.mjs';
import { postComment } from './lib/post.mjs';
import { scanUntrusted } from './lib/scan.mjs';

const db = open();

/**
 * No remote origins at all: scripts, styles and images are same-origin only.
 * Untrusted issue/discussion text therefore cannot phone home through an
 * <img> beacon or a stylesheet, even if the client rendering ever slipped.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type,
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(buf);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const OUTCOMES = new Set(['ignored', 'responded', 'pr_opened', 'closed', 'waiting']);

function decorate(item, triage, draftCount) {
  const s = computeState(item, triage);
  return {
    ...item,
    labels: JSON.parse(item.labels || '[]'),
    triage_state: s.state,
    triage_reason: s.reason,
    outcome: triage?.outcome ?? null,
    note: triage?.note ?? null,
    marked_by: triage?.marked_by ?? null,
    marked_at: triage?.marked_at ?? null,
    snoozed_until: triage?.snoozed_until ?? null,
    priority: priority(item, s.state),
    pending_drafts: draftCount ?? 0,
  };
}

const LIST_SQL = `
SELECT i.*, t.outcome, t.note, t.marked_by, t.marked_at, t.marked_at_activity, t.snoozed_until,
       (SELECT COUNT(*) FROM drafts d WHERE d.item_id = i.id AND d.status = 'pending') AS pending_drafts
FROM items i LEFT JOIN triage t ON t.item_id = i.id`;

function listItems(params) {
  const rows = db.prepare(LIST_SQL).all();
  const wanted = params.get('state');
  const repo = params.get('repo');
  const kind = params.get('kind');
  const q = (params.get('q') || '').toLowerCase();

  let out = rows.map((r) => decorate(r, r, r.pending_drafts));
  if (wanted && wanted !== 'all') out = out.filter((i) => i.triage_state === wanted);
  if (repo) out = out.filter((i) => i.repo === repo);
  if (kind) out = out.filter((i) => i.kind === kind);
  if (q) out = out.filter((i) => i.title.toLowerCase().includes(q) || (i.author || '').toLowerCase().includes(q));

  out.sort((a, b) => b.priority - a.priority || Date.parse(b.last_human_at || b.updated_at) - Date.parse(a.last_human_at || a.updated_at));
  return out;
}

function itemDetail(id) {
  const row = db.prepare(`${LIST_SQL} WHERE i.id = ?`).get(id);
  if (!row) return null;
  const comments = db.prepare('SELECT * FROM comments WHERE item_id = ? ORDER BY seq').all(id);
  return {
    item: {
      ...decorate(row, row, row.pending_drafts),
      injection_flags: scanUntrusted(row.title, row.body, ...comments.map((c) => c.body)),
    },
    comments,
    drafts: db.prepare('SELECT * FROM drafts WHERE item_id = ? ORDER BY id DESC').all(id)
      .map((d) => ({ ...d, flags: JSON.parse(d.flags || '[]') })),
  };
}

function mark(id, { outcome, note, actor }) {
  const item = db.prepare('SELECT last_human_at FROM items WHERE id = ?').get(id);
  if (!item) return { error: 'unknown item' };
  if (outcome && !OUTCOMES.has(outcome)) return { error: 'bad outcome' };
  const now = new Date().toISOString();
  if (!outcome) {
    db.prepare('DELETE FROM triage WHERE item_id = ?').run(id);
    log(actor, 'unmark', id, null);
  } else {
    db.prepare(`
      INSERT INTO triage (item_id, outcome, marked_by, marked_at, marked_at_activity, note)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET outcome=excluded.outcome, marked_by=excluded.marked_by,
        marked_at=excluded.marked_at, marked_at_activity=excluded.marked_at_activity,
        note=COALESCE(excluded.note, triage.note), snoozed_until=NULL`)
      .run(id, outcome, actor, now, item.last_human_at ?? now, note ?? null);
    log(actor, 'mark', id, { outcome, note });
  }
  return itemDetail(id);
}

function snooze(id, days, actor) {
  const until = new Date(Date.now() + Number(days || 7) * 86400000).toISOString();
  db.prepare(`
    INSERT INTO triage (item_id, snoozed_until, marked_by, marked_at)
    VALUES (?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET snoozed_until=excluded.snoozed_until,
      marked_by=excluded.marked_by, marked_at=excluded.marked_at`)
    .run(id, until, actor, new Date().toISOString());
  log(actor, 'snooze', id, { until });
  return itemDetail(id);
}

function stats() {
  const rows = db.prepare(LIST_SQL).all().map((r) => decorate(r, r, r.pending_drafts));
  const by = (fn) => rows.reduce((a, r) => { const k = fn(r); a[k] = (a[k] || 0) + 1; return a; }, {});
  return {
    total: rows.length,
    by_state: by((r) => r.triage_state),
    by_repo: by((r) => r.repo),
    inbox: rows.filter((r) => r.triage_state === 'needs_you').length,
    pending_drafts: db.prepare("SELECT COUNT(*) c FROM drafts WHERE status='pending'").get().c,
    last_ingest: db.prepare("SELECT value FROM meta WHERE key='last_ingest_at'").get()?.value ?? null,
    owner: OWNER_LOGIN,
    repos: [...new Set(rows.map((r) => r.repo))].sort(),
  };
}

async function api(req, res, url) {
  const p = url.pathname;
  const actor = req.headers['x-gh-inbox-actor'] === 'agent' ? 'jdx-bot' : OWNER_LOGIN;

  if (req.method === 'GET' && p === '/api/stats') return send(res, 200, stats());
  if (req.method === 'GET' && p === '/api/items') return send(res, 200, listItems(url.searchParams));

  const itemMatch = p.match(/^\/api\/items\/(.+)$/);
  if (itemMatch) {
    const id = decodeURIComponent(itemMatch[1]).replace(/\/(mark|snooze|draft)$/, '');
    if (req.method === 'GET') {
      const d = itemDetail(id);
      return d ? send(res, 200, d) : send(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && p.endsWith('/mark')) {
      const body = await readJson(req);
      const r = mark(id, { ...body, actor });
      return r?.error ? send(res, 400, r) : send(res, 200, r);
    }
    if (req.method === 'POST' && p.endsWith('/snooze')) {
      const body = await readJson(req);
      return send(res, 200, snooze(id, body.days, actor));
    }
    if (req.method === 'POST' && p.endsWith('/draft')) {
      const body = await readJson(req);
      if (!body.body?.trim()) return send(res, 400, { error: 'empty draft' });
      const info = db.prepare(`
        INSERT INTO drafts (item_id, kind, body, rationale, confidence, flags, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, body.kind || 'comment', body.body, body.rationale ?? null,
             body.confidence ?? null, JSON.stringify(body.flags ?? []), actor, new Date().toISOString());
      log(actor, 'draft.create', id, { draft_id: Number(info.lastInsertRowid) });
      return send(res, 200, itemDetail(id));
    }
  }

  const draftMatch = p.match(/^\/api\/drafts\/(\d+)\/(approve|reject|edit)$/);
  if (draftMatch && req.method === 'POST') {
    const draftId = Number(draftMatch[1]);
    const action = draftMatch[2];
    const body = await readJson(req);
    const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
    if (!draft) return send(res, 404, { error: 'no such draft' });

    if (action === 'edit') {
      if (draft.status !== 'pending') return send(res, 409, { error: `draft is ${draft.status}` });
      db.prepare('UPDATE drafts SET body = ? WHERE id = ?').run(String(body.body ?? ''), draftId);
      log(actor, 'draft.edit', draft.item_id, { draft_id: draftId });
      return send(res, 200, itemDetail(draft.item_id));
    }

    if (action === 'reject') {
      db.prepare("UPDATE drafts SET status='rejected', decided_by=?, decided_at=? WHERE id=?")
        .run(actor, new Date().toISOString(), draftId);
      log(actor, 'draft.reject', draft.item_id, { draft_id: draftId });
      return send(res, 200, itemDetail(draft.item_id));
    }

    // approve == the only path that talks to GitHub.
    if (actor !== OWNER_LOGIN) return send(res, 403, { error: 'only the owner can approve' });
    if (draft.status !== 'pending') return send(res, 409, { error: `draft is ${draft.status}` });
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(draft.item_id);
    try {
      const url2 = await postComment(item, draft.body);
      db.prepare("UPDATE drafts SET status='posted', decided_by=?, decided_at=?, posted_at=?, result_url=? WHERE id=?")
        .run(actor, new Date().toISOString(), new Date().toISOString(), url2, draftId);
      log(actor, 'draft.posted', draft.item_id, { draft_id: draftId, url: url2 });
      mark(draft.item_id, { outcome: 'responded', actor });
    } catch (e) {
      db.prepare("UPDATE drafts SET status='failed', error=? WHERE id=?").run(String(e.message), draftId);
      log(actor, 'draft.failed', draft.item_id, { draft_id: draftId, error: String(e.message) });
      return send(res, 502, { error: String(e.message) });
    }
    return send(res, 200, itemDetail(draft.item_id));
  }

  if (req.method === 'GET' && p === '/api/events') {
    return send(res, 200, db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 200').all());
  }
  return send(res, 404, { error: 'no route' });
}

async function static_(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, 'web', rel);
  if (!file.startsWith(join(ROOT, 'web'))) return send(res, 403, 'forbidden', 'text/plain');
  try {
    const buf = await readFile(file);
    return send(res, 200, buf, MIME[extname(file)] ?? 'application/octet-stream');
  } catch {
    return send(res, 404, 'not found', 'text/plain');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return await static_(res, url.pathname);
  } catch (e) {
    return send(res, 500, { error: String(e.message) });
  }
}).listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`gh-inbox on http://127.0.0.1:${PORT} (owner: ${OWNER_LOGIN})\n`);
});
