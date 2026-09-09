/**
 * triaghe client.
 *
 * Hard rule: every value that came from GitHub reaches the DOM through
 * textContent or a text node. There is no innerHTML anywhere in this file, so
 * untrusted issue and discussion bodies cannot introduce markup, script, or a
 * remote image beacon. The CSP is the backstop, not the primary defence.
 *
 * Bodies and comments are markdown, rendered by `markdown.js`, which holds to
 * the same rule: it produces a data tree and builds elements from it, never an
 * HTML string.
 */
import { renderMarkdown } from './markdown.js';

const $ = (sel) => document.querySelector(sel);
const state = {
  tab: 'needs_you',
  repo: null,
  kind: null,
  q: '',
  items: [],
  cursor: 0,
  detail: null,
  stats: { by_state: {}, repos: [] },
  limit: 200,
  offset: 0,
  total: 0,
  events: [],
  feedHasMore: false,
  feedHumansOnly: false,
  // The feed pages by cursor rather than offset, because ingestion writes to it
  // while it is being read and an offset would slide underneath. `feedTrail` is
  // how "newer" works without one: the cursor of each page already visited.
  feedCursor: null,
  feedNextCursor: null,
  feedTrail: [],
  // Draft text the owner has typed but not yet approved, keyed by draft id.
  // The 60s auto-refresh rebuilds the detail pane from server state; without
  // this, it silently replaced whatever was half-written in the textarea.
  draftEdits: new Map(),
};

const TABS = [
  ['needs_you', 'Inbox'],
  ['mentions', 'Mentions'],
  ['awaiting_them', 'Waiting'],
  ['release', 'Releases'],
  ['chore', 'Chores'],
  ['snoozed', 'Snoozed'],
  ['done', 'Done'],
  ['all', 'All'],
  ['feed', 'Feed'],
];

// Tabs that are views over activity rather than over the triage queue.
const MENTIONS_TAB = 'mentions';
const FEED_TAB = 'feed';

const OUTCOME_LABEL = {
  responded: 'responded', pr_opened: 'PR opened', ignored: 'ignored',
  closed: 'closed', waiting: 'waiting',
};

/* ---------- tiny DOM helpers (text-only by construction) ---------- */

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}

function link(href, text, className) {
  const a = el('a', className, text);
  // Only ever link out to github.com; never render a URL found inside content.
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer nofollow';
  return a;
}

function relTime(iso) {
  if (!iso) return '';
  const secs = (Date.now() - Date.parse(iso)) / 1000;
  const steps = [[60, 's'], [60, 'm'], [24, 'h'], [30, 'd'], [12, 'mo']];
  let v = secs, unit = 's';
  for (const [size, u] of steps) {
    if (v < size) { unit = u; break; }
    v /= size; unit = u;
  }
  return `${Math.floor(v)}${unit} ago`;
}

/* ---------- api ---------- */

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `http ${res.status}`);
  }
  return res.json();
}

async function refresh() {
  if (state.tab === FEED_TAB) return refreshFeed();
  const params = new URLSearchParams({
    // Mentions is a filter over every state, not a state of its own: a tag on
    // a thread you are already waiting on still counts as being tagged.
    state: state.tab === MENTIONS_TAB ? 'all' : state.tab,
    limit: String(state.limit),
    offset: String(state.offset),
  });
  if (state.tab === MENTIONS_TAB) params.set('mentions', '1');
  if (state.repo) params.set('repo', state.repo);
  if (state.kind) params.set('kind', state.kind);
  if (state.q) params.set('q', state.q);
  // /api/items is paginated server-side, so it returns { total, items } rather
  // than a bare array.
  const [page, stats] = await Promise.all([
    api(`/api/items?${params}`),
    api('/api/stats'),
  ]);
  state.items = page.items;
  state.total = page.total;
  // A filter change can shrink the result set under the current offset; without
  // this the board shows an empty page and no way back.
  if (state.offset && !page.items.length && page.total) {
    state.offset = 0;
    return refresh();
  }
  state.stats = stats;
  state.cursor = Math.min(state.cursor, Math.max(state.items.length - 1, 0));
  render();
}

/**
 * The feed is the audit view: raw activity, newest first, no triage filtering.
 * It exists to answer "is the poller actually seeing things", so it shows bot
 * traffic and closed threads that the inbox deliberately hides.
 */
async function refreshFeed() {
  const params = new URLSearchParams({ limit: String(state.limit) });
  if (state.feedCursor) params.set('cursor', state.feedCursor);
  if (state.repo) params.set('repo', state.repo);
  if (state.kind) params.set('kind', state.kind);
  if (state.feedHumansOnly) params.set('humans', '1');

  const [page, stats] = await Promise.all([
    api(`/api/feed?${params}`),
    api('/api/stats'),
  ]);
  state.events = page.events;
  state.feedHasMore = page.has_more;
  state.feedNextCursor = page.next_cursor ?? null;
  state.stats = stats;
  render();
}

/** Any change to what is being listed starts both pagers over. */
function resetPaging() {
  state.offset = 0;
  state.feedCursor = null;
  state.feedNextCursor = null;
  state.feedTrail = [];
}

/* ---------- render ---------- */

function renderTabs() {
  const nav = $('#tabs');
  nav.replaceChildren();
  for (const [key, label] of TABS) {
    const count = key === FEED_TAB ? null
      : key === MENTIONS_TAB ? (state.stats.mentions ?? 0)
      : key === 'all' ? state.stats.total
      : (state.stats.by_state?.[key] ?? 0);
    const b = el('button', key === state.tab ? 'tab active' : 'tab');
    b.append(el('span', null, label));
    if (count != null) b.append(el('span', 'count', count));
    b.onclick = () => { state.tab = key; state.cursor = 0; resetPaging(); refresh(); };
    nav.append(b);
  }
}

function renderFacets() {
  const repos = $('#repos');
  repos.replaceChildren();
  const mk = (label, active, onclick) => {
    const li = el('li');
    const b = el('button', active ? 'facet-btn active' : 'facet-btn', label);
    b.onclick = onclick;
    li.append(b);
    return li;
  };
  repos.append(mk('all repos', !state.repo, () => { state.repo = null; resetPaging(); refresh(); }));
  for (const r of state.stats.repos ?? []) {
    repos.append(mk(r.replace(/^.*\//, ''), state.repo === r, () => { state.repo = r; resetPaging(); refresh(); }));
  }

  const kinds = $('#kinds');
  kinds.replaceChildren();
  kinds.append(mk('all', !state.kind, () => { state.kind = null; resetPaging(); refresh(); }));
  for (const k of ['discussion', 'issue', 'pr']) {
    kinds.append(mk(k, state.kind === k, () => { state.kind = k; resetPaging(); refresh(); }));
  }
}

function renderFeed() {
  const list = $('#list');
  list.replaceChildren();

  const bar = el('div', 'feedbar');
  const toggle = el('button', state.feedHumansOnly ? 'facet-btn active' : 'facet-btn',
    state.feedHumansOnly ? 'people only' : 'everything');
  toggle.onclick = () => {
    state.feedHumansOnly = !state.feedHumansOnly;
    resetPaging();
    refresh();
  };
  bar.append(el('span', 'dim', 'showing'), toggle);
  list.append(bar);

  if (!state.events.length) {
    list.append(el('p', 'empty', 'No activity recorded yet.'));
    return;
  }

  for (const e of state.events) {
    const row = el('article', 'row feedrow' + (e.mentions_owner ? ' mention' : ''));
    row.onclick = () => openDetail(e.item_id);

    const top = el('div', 'row-top');
    top.append(el('span', 'age', relTime(e.at)));
    top.append(el('span', `kind ${e.item_kind}`, e.item_kind === 'pr' ? 'PR' : e.item_kind));
    top.append(el('span', 'repo', e.repo.replace(/^.*\//, '')));
    top.append(el('span', 'num', `#${e.number}`));
    top.append(el('span', 'title', e.title));
    row.append(top);

    const bot = el('div', 'row-bot');
    bot.append(el('span', 'who', e.actor || 'unknown'));
    bot.append(el('span', 'why', e.event === 'opened' ? 'opened this' : 'commented'));
    if (e.mentions_owner) bot.append(el('span', 'badge mention', 'mentioned you'));
    if (e.actor_is_bot) bot.append(el('span', 'badge label', 'bot'));
    row.append(bot);

    // One line of the comment, as plain text like everywhere else.
    if (e.body) {
      row.append(el('p', 'dim feedbody', e.body.replace(/\s+/g, ' ').slice(0, 220)));
    }
    list.append(row);
  }

  const pager = el('div', 'pager');
  const prev = el('button', 'oc muted', '← newer');
  prev.disabled = !state.feedTrail.length;
  prev.onclick = () => { state.feedCursor = state.feedTrail.pop() ?? null; refresh(); };
  const next = el('button', 'oc muted', 'older →');
  next.disabled = !state.feedHasMore || !state.feedNextCursor;
  next.onclick = () => {
    state.feedTrail.push(state.feedCursor);
    state.feedCursor = state.feedNextCursor;
    refresh();
  };
  pager.append(prev, el('span', 'dim', `page ${state.feedTrail.length + 1}`), next);
  list.append(pager);
}

function renderList() {
  if (state.tab === FEED_TAB) return renderFeed();
  const list = $('#list');
  list.replaceChildren();

  if (!state.items.length) {
    list.append(el('p', 'empty', 'Nothing here.'));
    return;
  }

  state.items.forEach((it, i) => {
    const row = el('article', 'row' + (i === state.cursor ? ' cursor' : ''));
    row.tabIndex = 0;
    row.onclick = () => { state.cursor = i; openDetail(it.id); };

    const top = el('div', 'row-top');
    top.append(el('span', `kind ${it.kind}`, it.kind === 'pr' ? 'PR' : it.kind));
    top.append(el('span', 'repo', it.repo.replace(/^.*\//, '')));
    top.append(el('span', 'num', `#${it.number}`));
    const title = el('span', 'title', it.title);
    top.append(title);
    row.append(top);

    const bot = el('div', 'row-bot');
    bot.append(el('span', 'who', it.last_human_actor || it.author || 'unknown'));
    bot.append(el('span', 'why', it.triage_reason));
    bot.append(el('span', 'age', relTime(it.last_human_at || it.updated_at)));
    if (it.last_mention_at
      && (!it.last_owner_at || Date.parse(it.last_mention_at) > Date.parse(it.last_owner_at))) {
      bot.append(el('span', 'badge mention', `@ ${it.last_mention_actor || 'mentioned you'}`));
    }
    if (it.pending_drafts) bot.append(el('span', 'badge draft', `${it.pending_drafts} draft`));
    if (it.open_requests) bot.append(el('span', 'badge queued', 'draft queued'));
    if (it.outcome) bot.append(el('span', 'badge done', OUTCOME_LABEL[it.outcome] ?? it.outcome));
    for (const l of it.labels.slice(0, 3)) bot.append(el('span', 'badge label', l));
    row.append(bot);

    list.append(row);
  });

  const active = list.querySelector('.cursor');
  if (active) active.scrollIntoView({ block: 'nearest' });

  // The API has always paginated; the board never exposed it, so anything past
  // the first page was unreachable without narrowing the filters.
  const shown = state.offset + state.items.length;
  if (state.total > state.items.length) {
    const pager = el('div', 'pager');
    const prev = el('button', 'oc muted', '← previous');
    prev.disabled = state.offset === 0;
    prev.onclick = () => {
      state.offset = Math.max(0, state.offset - state.limit);
      state.cursor = 0;
      refresh();
    };
    const next = el('button', 'oc muted', 'next →');
    next.disabled = shown >= state.total;
    next.onclick = () => { state.offset = shown; state.cursor = 0; refresh(); };
    pager.append(prev, el('span', 'dim', `${state.offset + 1}–${shown} of ${state.total}`), next);
    list.append(pager);
  }
}

/**
 * Renders untrusted markdown.
 *
 * The `.untrusted` frame stays around the result. It used to be a `<pre>` and
 * was doing two jobs — showing the text and marking it as somebody else's words
 * — and only the first of those is replaced by rendering markdown. `repo`
 * qualifies bare `#123` references to the thread they were written in.
 */
function renderUntrusted(container, text, repo) {
  container.replaceChildren();
  if (!text) { container.append(el('p', 'dim', '(no body)')); return; }
  container.append(renderMarkdown(el('div', 'untrusted'), text, { repo }));
}

function outcomeBar(item) {
  const bar = el('div', 'outcomes');
  const add = (label, fn, cls) => {
    const b = el('button', cls ? `oc ${cls}` : 'oc', label);
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    bar.append(b);
    return b;
  };
  add('responded', () => markItem(item.id, 'responded'));
  add('PR opened', () => markItem(item.id, 'pr_opened'));
  add('closed', () => markItem(item.id, 'closed'));
  add('snooze 7d', () => snoozeItem(item.id, 7), 'muted');
  if (item.outcome) add('undo', () => markItem(item.id, null), 'muted');

  // Drafting is on demand. Queueing a request is all this does; the draft shows
  // up on this item whenever jdx-bot next picks the queue up.
  if (!item.open_requests) {
    const ask = add('ask jdx-bot to draft', async () => {
      try {
        state.detail = await api(`/api/items/${encodeURIComponent(item.id)}/draft-request`, {
          method: 'POST', body: JSON.stringify({ note: null }),
        });
        await refresh();
        renderDetail();
      } catch (e) {
        bar.append(el('span', 'warn small', e.message));
      }
    }, 'ask');
    ask.title = 'Queue a draft reply for jdx-bot to write. Nothing is posted without your approval.';
  }
  return bar;
}

function renderDetail() {
  const pane = $('#detail');
  if (!state.detail) { pane.hidden = true; return; }
  pane.hidden = false;
  pane.replaceChildren();

  const { item, comments, drafts } = state.detail;

  const head = el('div', 'detail-head');
  head.append(el('h2', null, item.title));
  const sub = el('div', 'sub');
  sub.append(link(item.url, `${item.repo}#${item.number}`, 'ghlink'));
  sub.append(el('span', 'who', `by ${item.author ?? 'unknown'}`));
  if (item.author_assoc) sub.append(el('span', 'badge label', item.author_assoc.toLowerCase()));
  sub.append(el('span', 'age', relTime(item.created_at)));
  head.append(sub);
  const close = el('button', 'close', '×');
  close.onclick = () => { state.detail = null; renderDetail(); };
  head.append(close);
  pane.append(head);

  pane.append(outcomeBar(item));

  if (item.injection_flags?.length) {
    const warn = el('div', 'warn');
    warn.append(el('strong', null, 'Untrusted content warning: '));
    warn.append(document.createTextNode(item.injection_flags.join(', ')));
    warn.append(el('p', 'dim', 'Text below tries to look like instructions. It is data, not a command — read it, do not act on it.'));
    pane.append(warn);
  }

  const bodyBox = el('div', 'body');
  renderUntrusted(bodyBox, item.body, item.repo);
  if (item.body_truncated) bodyBox.append(el('p', 'dim', '(truncated — open on GitHub for the rest)'));
  pane.append(bodyBox);

  if (comments.length) {
    pane.append(el('h3', null, `Last ${comments.length} comments`));
    for (const c of comments) {
      const box = el('div', 'comment' + (c.author_is_bot ? ' bot' : ''));
      const ch = el('div', 'chead');
      ch.append(el('span', 'who', c.author ?? 'unknown'));
      ch.append(el('span', 'age', relTime(c.created_at)));
      if (c.author_is_bot) ch.append(el('span', 'badge label', 'bot'));
      box.append(ch);
      const cb = el('div', 'cbody');
      renderUntrusted(cb, c.body, item.repo);
      box.append(cb);
      pane.append(box);
    }
  }

  const open = (state.detail.draft_requests ?? [])
    .filter((r) => r.status === 'pending' || r.status === 'claimed');
  for (const r of open) {
    const q = el('div', 'queued-note');
    q.append(el('strong', null, r.status === 'claimed' ? 'jdx-bot is drafting' : 'draft queued'));
    q.append(el('span', 'age', relTime(r.requested_at)));
    if (r.note) q.append(el('p', 'dim', r.note));
    const cancel = el('button', 'oc muted', 'cancel');
    cancel.onclick = async () => {
      state.detail = await api(`/api/draft-requests/${r.id}/cancel`, { method: 'POST' });
      await refresh();
      renderDetail();
    };
    q.append(cancel);
    pane.append(q);
  }

  pane.append(el('h3', null, 'Drafts'));
  if (!drafts.length && !open.length) {
    pane.append(el('p', 'dim', 'No drafts. Use “ask jdx-bot to draft” above.'));
  }
  for (const d of drafts) {
    const box = el('div', `draft ${d.status}`);
    const dh = el('div', 'chead');
    dh.append(el('span', 'badge label', d.kind));
    dh.append(el('span', 'badge label', d.status));
    dh.append(el('span', 'who', `by ${d.created_by}`));
    dh.append(el('span', 'age', relTime(d.created_at)));
    if (d.confidence) dh.append(el('span', 'badge label', `confidence: ${d.confidence}`));
    box.append(dh);

    for (const f of d.flags ?? []) box.append(el('div', 'warn small', `flag: ${f}`));
    if (d.rationale) box.append(el('p', 'dim', d.rationale));

    const ta = el('textarea', 'draft-body');
    // Prefer an unsaved local edit over the server copy, so a background
    // refresh cannot discard what is being typed.
    ta.value = state.draftEdits.get(d.id) ?? d.body;
    ta.readOnly = d.status !== 'pending';
    if (!ta.readOnly) {
      ta.oninput = () => {
        if (ta.value === d.body) state.draftEdits.delete(d.id);
        else state.draftEdits.set(d.id, ta.value);
      };
    }
    box.append(ta);

    if (d.status === 'pending') {
      const actions = el('div', 'outcomes');
      const approve = el('button', 'oc approve', 'approve & post');
      approve.onclick = async () => {
        approve.disabled = true;
        try {
          // Approve names the revision this pane is showing. If the drafting
          // agent rewrote the draft since it was rendered, the server refuses
          // rather than posting text nobody read.
          let revision = d.revision;
          if (ta.value !== d.body) {
            const edited = await api(`/api/drafts/${d.id}/edit`, {
              method: 'POST', body: JSON.stringify({ body: ta.value }),
            });
            state.detail = edited;
            // The revision this edit produced, reported by the UPDATE itself.
            // Reading it back off the returned snapshot would pick up an agent
            // edit that landed in between, and approve text never displayed.
            revision = edited.edited_revision ?? revision;
          }
          state.detail = await api(`/api/drafts/${d.id}/approve`, {
            method: 'POST', body: JSON.stringify({ expected_revision: revision }),
          });
          state.draftEdits.delete(d.id);
          await refresh();
          renderDetail();
        } catch (e) {
          approve.disabled = false;
          box.append(el('div', 'warn small', `post failed: ${e.message}`));
          // A stale revision means the text changed underneath: re-read it so
          // the pane shows what the server actually holds before a second try.
          if (/changed since you read it/.test(e.message)) {
            state.draftEdits.delete(d.id);
            state.detail = await api(`/api/items/${encodeURIComponent(d.item_id)}`);
            renderDetail();
          }
        }
      };
      const reject = el('button', 'oc muted', 'discard');
      reject.onclick = async () => {
        state.detail = await api(`/api/drafts/${d.id}/reject`, { method: 'POST' });
        state.draftEdits.delete(d.id);
        // Discarding changes the pending-draft count the list badge shows, so
        // it needs the same refresh the other outcome buttons do.
        await refresh();
        renderDetail();
      };
      actions.append(approve, reject);
      box.append(actions);
    }
    if (d.result_url) box.append(link(d.result_url, 'posted →', 'ghlink'));
    if (d.error) box.append(el('div', 'warn small', d.error));

    pane.append(box);
  }
}

function render() {
  renderTabs();
  renderFacets();
  renderList();
  renderDetail();
  const s = state.stats;
  const meta = $('#meta');
  meta.replaceChildren();
  meta.append(el('span', null, s.last_ingest
    ? `${s.inbox} in inbox · synced ${relTime(s.last_ingest)}`
    : 'never synced'));

  // A board that silently knows less than it claims is worse than no board, so
  // the edges of its coverage are shown rather than inferred.
  // A measured shortfall outranks the truncation flags: those say a loop
  // stopped early, this says GitHub had rows we do not hold.
  if (s.coverage?.shortfall > 0) {
    // Two different gaps, and conflating them into one subtraction made the
    // banner's own arithmetic wrong: threads the search returned and we did not
    // store, and comments inside threads we did store.
    const parts = [];
    const threads = Math.max((s.coverage.expected ?? 0) - (s.coverage.fetched ?? 0), 0);
    if (threads) parts.push(`${threads} items`);
    if (s.coverage.comments_missing) {
      parts.push(`${s.coverage.comments_missing} comments across `
        + `${s.coverage.threads_incomplete} threads`);
    }
    meta.append(el('span', 'warn small', ` · not collected: ${parts.join(', ')}`));
    if (s.coverage.abandoned?.length) {
      meta.append(el('span', 'warn small',
        ` · gave up paging ${s.coverage.abandoned.join(', ')}`));
    }
  } else if (s.last_truncated) {
    meta.append(el('span', 'warn small',
      ' · last sync hit its page limit — some updates are not in yet'));
  } else if (s.mentions_truncated) {
    // Called out separately: this is the cross-repository mention stream, the
    // one with no other safety net once GitHub notifications are off.
    meta.append(el('span', 'warn small',
      ' · mention search hit its page limit — some @mentions may be missing'));
  } else if (s.last_ingest && !s.backfill_complete && s.backfill_cursor) {
    meta.append(el('span', 'dim',
      ` · history back to ${s.backfill_cursor.slice(0, 10)}, still filling in`));
  } else if (s.horizon) {
    meta.append(el('span', 'dim', ` · history from ${s.horizon.slice(0, 10)}`));
  }
}

/* ---------- actions ---------- */

async function markItem(id, outcome) {
  const res = await api(`/api/items/${encodeURIComponent(id)}/mark`, {
    method: 'POST', body: JSON.stringify({ outcome }),
  });
  if (state.detail?.item.id === id) state.detail = res;
  await refresh();
  renderDetail();
}

async function snoozeItem(id, days) {
  const res = await api(`/api/items/${encodeURIComponent(id)}/snooze`, {
    method: 'POST', body: JSON.stringify({ days }),
  });
  if (state.detail?.item.id === id) state.detail = res;
  await refresh();
  renderDetail();
}

async function openDetail(id) {
  state.detail = await api(`/api/items/${encodeURIComponent(id)}`);
  renderDetail();
}

/* ---------- keyboard ---------- */

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (typing && e.key !== 'Escape') return;
  // The feed is a reading view over activity, not a cursor over `state.items`;
  // j/k/r there would act on whatever the last triage list happened to hold.
  if (state.tab === FEED_TAB && e.key !== 'Escape' && e.key !== '/') return;
  const cur = state.items[state.cursor];

  switch (e.key) {
    case 'j': state.cursor = Math.min(state.cursor + 1, state.items.length - 1); renderList(); break;
    case 'k': state.cursor = Math.max(state.cursor - 1, 0); renderList(); break;
    case 'Enter': if (cur) openDetail(cur.id); break;
    case 'Escape': state.detail = null; renderDetail(); document.activeElement?.blur(); break;
    case 'o': if (cur) window.open(cur.url, '_blank', 'noopener'); break;
    case 'r': if (cur) markItem(cur.id, 'responded'); break;
    case 'p': if (cur) markItem(cur.id, 'pr_opened'); break;
    case 's': if (cur) snoozeItem(cur.id, 7); break;
    case 'u': if (cur) markItem(cur.id, null); break;
    case '/': e.preventDefault(); $('#search').focus(); break;
    default: return;
  }
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => { state.q = v; state.cursor = 0; resetPaging(); refresh(); }, 200);
});

setInterval(refresh, 60_000);
refresh().catch((e) => { $('#meta').textContent = `error: ${e.message}`; });
