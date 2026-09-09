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
web/app.js       the board (no innerHTML, strict CSP)
web/markdown.js  markdown -> DOM nodes, for text written by strangers
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
| `done` | closed, answered, or marked by you/jdx-bot — until someone comments after it was resolved |
| `release` | a release cut nobody is waiting on — no tab, reachable at `?state=release` |
| `chore` | opened by automation — dependency bumps and the like |
| `draft` | somebody else's draft: the author has said it is not ready |
| `snoozed` | hidden until a date |

`done` also covers `dismissed` — the neutral outcome behind the "off the board"
button. It asserts nothing about why, and like every other outcome it lasts
until a *person* turns up, which is what separates it from an ignore.

`release`, `chore` and `draft` all yield when somebody is actually waiting, so
none of them can hide a request. For `release` that exception is the only way
back onto the board: it has no tab, because with the exception in place the lane
holds only work nobody is waiting on, and a badge counting that is a badge worth
ignoring. A person commenting on a release cut puts it in the inbox reading as
their comment; CI output and review bots leave it where it is. `draft` yields only to an outstanding mention
rather than to any comment: being tagged is a request, a comment on a draft is
work in progress out loud.

The load-bearing detail is `last_human_at`: activity by a non-owner, non-bot
account. It is *preferred* over the last actor of any kind, because otherwise a
CodeRabbit or Greptile review comment would mask the contributor who is actually
waiting on you. Bots are detected by GraphQL `__typename == 'Bot'` plus a list
for automation running under plain user accounts (`src/config.mjs`).

Purely automated items — renovate, dependabot, release cuts — are **not** inbox
work. They are open PRs somebody has to merge, but nobody is waiting on a reply,
and left in the inbox they are most of the volume: a hand-cleared inbox went from
6 items to 12 in ninety minutes, nine of them put there by a bot. Dependency PRs
go to `chore`, release cuts to `release`. Within the inbox, `priority()` still
keeps bands that cannot overlap — automation scores at most 10, a person always
at least 20 — so a question asked this morning never sorts below a Dependency
Dashboard.

A mark sticks until something new arrives after it.

`done` is not permanent. People keep talking on closed threads — "this broke
again in 2.1", "how do I do the thing you mentioned" — and that is precisely the
traffic GitHub notifications used to surface. A closed, merged, or answered item
returns to `needs_you` when someone comments **after** `resolved_at` and the
owner has not replied since. Without that timestamp the question is unanswerable,
which is why ingest records it.

## Mentions

Being tagged is someone asking for you specifically rather than leaving a message
the queue happens to contain, so it is tracked apart from ordinary activity and
sorts above everything else in the inbox.

- `@you` is matched strictly: `ship@you.dev` is not a mention and `@yourhandle2`
  is a different account (`mentionsOwner` in `src/config.mjs`).
- A mention counts as outstanding only until you reply — answering it clears it.
- Ingest runs a small extra `mentions:<owner>` search **without** the `user:`
  scope. Your own repos are already covered by the main window; this exists for
  the other case, being tagged in somebody else's project, which is the one class
  of miss that is completely invisible once notifications are off.
- That search keeps its **own** checkpoint (`mentions_ingest_at`) and reports its
  own truncation. Sharing `last_ingest_at` meant the checkpoint advanced on the
  strength of the main sweep, so anything the mention window did not reach was
  skipped rather than retried.
- Dismissal works here like everywhere: marking or snoozing a mention removes it
  from the list, not only from the badge.

## Feed

`/api/feed` and the **Feed** tab are the audit surface: every comment and every
opened thread, newest first, filterable by repo and kind.

It deliberately shows what triage hides — bot traffic, closed threads, things
already marked. The inbox answers "what needs me"; the feed answers "what has
actually been happening", which is how you check the poller is doing its job
before trusting it instead of GitHub's own notifications.

### Coverage is measured, not assumed

A feed built from the ingest stream can only show what that stream collected; on
its own it cannot demonstrate that nothing was missed. The truncation flags do
not close that gap either, since they are derived from the same paging that did
the losing — they report that a loop stopped early, not whether anything was
actually lost.

So every search window also reads GitHub's own `issueCount` for that window, and
each run records what GitHub said existed against what it came away with:

```json
"coverage": {
  "expected": 812, "fetched": 812,
  "comments_missing": 0, "threads_incomplete": 0,
  "abandoned": [], "shortfall": 0
}
```

Those numbers do not come from our paging, which is what makes them worth
anything. A non-zero `shortfall` is shown on the board, and it catches a failure
mode nobody anticipated rather than only the ones that were.

`issueCount` counts threads, so it is only half the question. A thread can be
collected whole as far as the search is concerned while its comment connection
— bounded, because the sweep reads many threads — quietly omitted the tail, and
any mention inside it. So each thread also carries GitHub's own comment and
reply totals against what is stored, and `shortfall` is both gaps. Threads with
a gap are paged to the end, a few per run, by a drain pass that runs after the
sweep.

### Windows resume; they are not stepped over

A window that runs out of pages keeps its bounds and its cursor, and the next
run continues from there. The checkpoint does not advance until the window is
actually finished. Advancing it by a second to guarantee forward motion — which
is what this used to do — permanently skips any result sharing the boundary
timestamp that the page budget did not reach.

GitHub search stops at 1000 results, so some windows cannot be paged to the end
by anybody. After `MAX_WINDOW_PAGES` the window is abandoned so it cannot block
every later poll behind it; it is named in `coverage.abandoned` and its
remainder stays counted in `shortfall`. Giving up is a thing the board says out
loud, not a thing it does quietly.

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

**5. The browser builds nodes, never HTML.** No `innerHTML`, `insertAdjacentHTML`
or any other string-to-markup API exists in `web/` — a test asserts that by
grepping the sources, because it is the property everything else depends on.
Every value reaches the DOM via `textContent` or a text node.

Bodies and comments *are* rendered as markdown, by `web/markdown.js`. It parses
to a plain-data tree and builds elements from that tree, so raw HTML in a body
is never handed to an HTML parser: `<img onerror=…>` is displayed as those
characters. Link destinations pass a scheme allowlist (`http`, `https`,
`mailto`) evaluated after control characters are stripped, so `javascript:`,
`data:` and `java\nscript:` render as text rather than as a link. Markdown
images become links, not `<img>`: a remote image in a stranger's issue is a read
receipt for the maintainer's IP. `test/markdown-hostile.test.mjs` is the payload
suite.

CSP is unchanged and unweakened — `default-src 'none'` with same-origin scripts
and styles — which kills tracking-pixel and beacon exfiltration even if the
rendering ever regressed. The Worker sets those headers on assets and API
responses alike, so there is no `_headers` file to drift out of sync.

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
npx wrangler secret put OWNER_EMAIL              # the one address allowed to approve
```

`OWNER_EMAIL` is a secret only to keep a personal address out of a public
repository. It is not a credential: the approve gate compares it against a
signed Access claim, so knowing the address grants nothing.

The `.pem` GitHub gives you is PKCS#1. WebCrypto only imports PKCS#8, so
`src/gh.mjs` wraps it at runtime — no `openssl` step needed.

**3. Cloudflare Access** — create a self-hosted application for the hostname
you will serve the board on.

`wrangler.toml` sets `workers_dev = false` and `preview_urls = false`, so that
Access hostname is the only route in. Both default to *enabled* when absent,
which publishes the board on `<name>.<subdomain>.workers.dev` — a hostname the
Access application does not sit in front of.

- Policy 1, `Allow`: emails ending in your domain, or the single owner email.
- Policy 2, `Service Auth`: the service token jdx-bot will use.
- Copy the **Application Audience (AUD)** tag and your team domain into
  `[vars]` in `wrangler.toml`. Both are public identifiers, not secrets.

**4. Deploys** — add `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, D1: Edit)
to the repository's Actions secrets. `.github/workflows/deploy.yml` then applies
migrations and deploys on every push to `main`. Fork PRs cannot read that
secret and the workflow does not run on `pull_request`.

## Tests

```sh
npm test
```

`node --test` against in-memory SQLite with the real migrations applied and a
stubbed `fetch`. The handlers under test are the actual ones — every concurrency
bug found so far lived in the exact SQL, so a double that accepted statements
without running them would have proved nothing.

Coverage is deliberately narrow: the races and coverage gaps that fail
*silently*. Stale-revision approval, two concurrent approvals posting once,
an edit reporting its own revision, a truncated search window resuming instead
of skipping tied results, comments beyond the tail being counted and then
fetched, closed-thread reactivation ordering, feed pages that must not repeat
rows while ingestion writes underneath them, and ambiguous GitHub write
outcomes. They run on pull requests and need no secrets.

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
GET  /api/items?state=&repo=&kind=&q=&mentions=&limit=&offset=
GET  /api/feed?repo=&kind=&mentions=&humans=&limit=&cursor=   raw activity, newest first
                                         cursor: `next_cursor` from the previous page
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
· `d` off the board · `s` snooze 7d · `u` undo · `/` search

## What happened to the node prototype

`server.mjs`, `ingest.mjs` and `lib/` — the original `node:sqlite` version — are
gone as of this PR. Two reasons, and the first is the serious one.

It authenticated by trusting an `x-triaghe-actor` request header, which is only
safe while nothing can reach the port. Its own header comment recommended
exposing it with `tailscale serve`, and doing that hands owner identity to any
caller who omits the header: enough to approve a pending draft and post it to
GitHub under the App credential. A fallback that is one documented step away
from impersonation is not a fallback.

It had also stopped working. It serves `web/`, and the browser client now
expects `{items, total}` from `/api/items`, revision-bound approval, and the
draft-request routes — none of which the prototype implements. The README
claimed it still ran; that had quietly become false.

Keeping it as insurance against an unproven Worker was the argument for
retaining it, and that argument does not survive contact with `git`: the last
commit containing it is a `git checkout` away, and nothing about deleting it
from `HEAD` removes that option.
