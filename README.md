# triaghe

A triage board for inbound work on your GitHub projects: new discussions,
issues and PRs from other people, with your own activity and bot noise filtered
out. You and jdx-bot read and write the same board.

Runs on Cloudflare Workers + D1, behind Cloudflare Access. Zero runtime
dependencies — no framework, no ORM, no npm packages in the deployed bundle.

```
src/index.mjs    Worker entry: fetch + scheduled
src/ingest.mjs   GitHub GraphQL -> D1        (no model ever runs here)
src/access.mjs   Cloudflare Access JWT verification
src/api.mjs      JSON API
src/post.mjs     the only code that writes to GitHub
web/             the board (no innerHTML, strict CSP)
```

## Why not something off the shelf

`mise`, `hk` and `fnox` have issues effectively disabled — **Discussions are the
main intake channel**. GitHub Projects cannot hold discussions; its schema is
`ProjectV2ItemContent = DraftIssue | Issue | PullRequest`. A Projects board
would miss most of the real inbound. Octobox is notification-shaped, which is
the model that already doesn't work. gh-dash is terminal-only with no shared
state.

Measured over 14 days: ~733 items authored by the owner and ~167 from
`renovate`/`dependabot`, against roughly 100 from outside humans. The value here
is subtraction.

## Triage states

Computed in `src/state.mjs` — pure, deterministic, no model.

| state | meaning |
|---|---|
| `needs_you` | something arrived from outside more recently than you replied |
| `awaiting_them` | you spoke last |
| `done` | closed, answered, or marked by you/jdx-bot |
| `snoozed` | hidden until a date |

The load-bearing detail is `last_human_at`: activity by a non-owner, non-bot
account. It is *preferred* over the last actor of any kind, because otherwise a
CodeRabbit or Greptile review comment would mask the contributor who is actually
waiting on you. Bots are detected by GraphQL `__typename == 'Bot'` plus a list
for automation running under plain user accounts (`src/config.mjs`).

Purely automated items — renovate, dependabot, release PRs — **are** inbox work.
They are open PRs on your repos and somebody has to merge them. They do not
accrue urgency with age the way a person's unanswered question does, so
`priority()` puts them in a band that cannot overlap the human one: automation
scores at most 10, a person always scores at least 20. That is ordering only.
They stay fully visible and fully counted.

A mark sticks until something new arrives after it.

## Security model

Everything from GitHub is hostile input. Discussions are open to anyone.

**1. Ingest runs no model.** It is a fetch loop that writes bound D1 parameters.
Content is never executed, shell-interpolated, or used to build a request.
Poisoned text cannot influence anything on the way in.

**2. Nothing is fetched or executed from content.** No following links, no
cloning branches, no running repro scripts from a bug report. If you want a
repro run, ask for it explicitly and it happens in a throwaway worktree — never
as part of triage.

**3. The drafting agent is sandboxed by capability, not by instruction.** When
jdx-bot drafts a reply it runs with no write, exec, or network tools. Its only
output is a row in `drafts`. Content is passed as clearly-fenced untrusted data.

**4. Only the owner approves, and that is enforced cryptographically.**
`POST /api/drafts/:id/approve` is the only path that writes to GitHub. It
requires a verified Cloudflare Access JWT whose `email` claim equals
`OWNER_EMAIL`. jdx-bot reaches the API through an Access **service token**, and
a service token's JWT carries `common_name` and *no* email claim — so the agent
cannot reach the approve path even if its credentials leak. This replaced an
`x-triaghe-actor` header, which was fine on loopback and would have been a hole
on the internet: it let the caller choose its own privilege level.

Approve posts `drafts.body` **verbatim** and never reads the item body, so no
instruction inside a discussion can reach the write path. The worst a
fully-injected draft can do is produce text that sat on the board for a human to
read first.

**5. The browser renders untrusted text as text.** No `innerHTML` anywhere in
`web/app.js` — every value reaches the DOM via `textContent`. Markdown is *not*
rendered: bodies display as preformatted text, so no links or images from
content are ever live. CSP is `default-src 'none'` with same-origin scripts and
styles, which kills tracking-pixel and beacon exfiltration even if the rendering
ever regressed. The Worker sets those headers on assets and API responses alike,
so there is no `_headers` file to drift out of sync.

**6. Injection heuristics are a hint, not a boundary.** `src/scan.mjs` flags
instruction-override phrasing, fake chat delimiters, pipe-to-shell, credential
mentions and zero-width/bidi characters, and the board shows a warning banner.
Assume a competent attacker evades all of it — layers 1-5 are what hold.

**7. Everything is audited.** Every mark, draft, approval and post is appended
to `events` with actor and timestamp. `GET /api/events`.

**8. The GitHub credential is an App, not a PAT.** What sits in Cloudflare is an
RSA key that mints one-hour installation tokens, with permissions pinned to
issues, discussions and pull requests. A full compromise of the Worker cannot
push code, merge, or touch a repo the App is not installed on. Revoking is one
click and disturbs no human's account.

## Setup

These steps need the repository owner; the rest is automated.

**1. Cloudflare D1**

```sh
npx wrangler d1 create triaghe        # paste database_id into wrangler.toml
npx wrangler d1 migrations apply triaghe --remote
```

**2. GitHub App** — create at `https://github.com/settings/apps/new`.

- Repository permissions: **Issues** read+write, **Pull requests** read+write,
  **Discussions** read+write, **Metadata** read.
- Subscribe to events: none (this polls).
- Install it on **All repositories**. Ingest searches `user:jdx`; anything the
  App is not installed on is invisible to it.

```sh
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_INSTALLATION_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste the .pem, BEGIN line included
```

The `.pem` GitHub gives you is PKCS#1. WebCrypto only imports PKCS#8, so
`src/gh.mjs` wraps it at runtime — no `openssl` step needed.

**3. Cloudflare Access** — create a self-hosted application for
`inbox.jdx.dev`.

- Policy 1, `Allow`: emails ending in your domain, or the single owner email.
- Policy 2, `Service Auth`: the service token jdx-bot will use.
- Copy the **Application Audience (AUD)** tag and your team domain into
  `[vars]` in `wrangler.toml`. Both are public identifiers, not secrets.

**4. Deploys** — add `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, D1: Edit)
to the repository's Actions secrets. `.github/workflows/deploy.yml` then applies
migrations and deploys on every push to `main`. Fork PRs cannot read that
secret and the workflow does not run on `pull_request`.

## Local development

```sh
npm install
npx wrangler d1 migrations apply triaghe --local
echo 'DEV_IDENTITY=owner' > .dev.vars    # or 'agent' to test the approve gate
npx wrangler dev
```

`DEV_IDENTITY` only works when the request hostname is `localhost` or
`127.0.0.1`. The deployed Worker is routable solely as its Access hostname, so
that branch is unreachable in production.

## API

```
GET  /api/whoami                         verified identity + whether it may approve
GET  /api/stats
GET  /api/items?state=&repo=&kind=&q=&limit=&offset=
GET  /api/items/:id                      detail + comments + drafts + injection flags
POST /api/items/:id/mark    {outcome, note}   outcome:null clears
POST /api/items/:id/snooze  {days}
POST /api/items/:id/draft-request  {note}     queue a draft for jdx-bot
POST /api/items/:id/draft   {kind, body, rationale, confidence, flags}
GET  /api/draft-requests?status=pending       the drafting queue
POST /api/draft-requests/:id/claim            atomic; two pollers cannot both take one
POST /api/draft-requests/:id/complete  {draft_id} | {error}
POST /api/draft-requests/:id/cancel
POST /api/drafts/:id/edit   {body}
POST /api/drafts/:id/reject
POST /api/drafts/:id/approve             owner email only; the only GitHub write
POST /api/ingest                         manual refresh
GET  /api/events
```

`:id` is `owner/repo#kind#number`, URL-encoded. The list view never selects item
bodies; they load only when you open something.

## Drafting is on demand

Nothing is drafted automatically. You press **ask jdx-bot to draft** on an item,
which writes a row to `draft_requests`; jdx-bot polls the queue, claims one,
writes a draft, and reports back. The draft then waits on the board for you to
edit, approve or discard.

The queue is a table rather than a webhook for two reasons: the agent runs on a
machine that is not always reachable, and a request still sitting unclaimed is
visible evidence that nothing picked it up. A dropped webhook is silent. A
partial unique index allows at most one open request per item, so a double click
cannot produce two drafts of the same reply.

There are deliberately **no notifications**. No email, no Discord ping, no
badge. The board is the signal — the whole point was to stop being interrupted
by GitHub. If that turns out to be too quiet, a daily digest is the smallest
thing to add.

## Ingest scheduling

The cron trigger runs every 15 minutes and does bounded work: one incremental
window since the last successful run (with an hour of overlap, since upserts are
idempotent) plus at most one 7-day backfill window. A cold database fills in
`BACKFILL_DAYS` of history over a few hours rather than one run trying to pull
three months and dying against the CPU limit.

## Keyboard

`j`/`k` move · `enter` detail · `o` open on GitHub · `r` responded · `p` PR opened
· `x` ignore · `s` snooze 7d · `u` undo · `/` search

## The node prototype

`server.mjs`, `ingest.mjs` and `lib/` are the original `node:sqlite` version
that runs on loopback. It still works and is kept until the deployed Worker has
been used in anger. It has no Access layer — it binds `127.0.0.1` and trusts an
`x-triaghe-actor` header, which is only safe because nothing can reach it.
Delete it once the Worker is proven.
