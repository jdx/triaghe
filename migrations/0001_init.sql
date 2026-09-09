-- triaghe schema for D1. All content from GitHub is UNTRUSTED input.
-- Nothing in this database is ever executed, interpolated into a shell, or
-- rendered as HTML.
--
-- Differences from the original node:sqlite schema: no PRAGMA lines. D1 manages
-- journal mode itself and enforces foreign keys by default, so setting them here
-- would fail the migration.

CREATE TABLE IF NOT EXISTS items (
  id                 TEXT PRIMARY KEY,     -- "jdx/mise#discussion#12985"
  node_id            TEXT,                 -- GraphQL node id, needed to reply to discussions
  repo               TEXT NOT NULL,        -- "jdx/mise"
  kind               TEXT NOT NULL,        -- issue | pr | discussion
  number             INTEGER NOT NULL,
  title              TEXT NOT NULL,
  url                TEXT NOT NULL,
  author             TEXT,                 -- null when the account was deleted
  author_is_bot      INTEGER NOT NULL DEFAULT 0,
  author_assoc       TEXT,                 -- OWNER | MEMBER | CONTRIBUTOR | NONE ...
  body               TEXT,                 -- truncated; UNTRUSTED
  body_truncated     INTEGER NOT NULL DEFAULT 0,
  state              TEXT,                 -- OPEN | CLOSED | MERGED
  is_answered        INTEGER,              -- discussions only
  is_draft           INTEGER NOT NULL DEFAULT 0,
  locked             INTEGER NOT NULL DEFAULT 0,
  labels             TEXT,                 -- JSON array of strings
  category           TEXT,                 -- discussion category
  comment_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  -- derived from the comment tail, recomputed on every ingest
  last_actor         TEXT,
  last_actor_is_bot  INTEGER NOT NULL DEFAULT 0,
  last_actor_at      TEXT,
  last_owner_at      TEXT,                 -- last time TRIAGHE_OWNER spoke on this item
  -- Last activity by a real person who is not the owner. This, not last_actor,
  -- is what decides whether something is waiting on you: a bot reviewer piling
  -- onto a contributor's PR must not mask the contributor's original ask.
  last_human_at      TEXT,
  last_human_actor   TEXT,
  first_seen_at      TEXT NOT NULL,
  fetched_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS items_updated    ON items(updated_at DESC);
CREATE INDEX IF NOT EXISTS items_repo       ON items(repo);
CREATE INDEX IF NOT EXISTS items_kind       ON items(kind);
CREATE INDEX IF NOT EXISTS items_last_human ON items(last_human_at DESC);

-- Comment tail, kept only to compute state and to give a drafting agent context.
CREATE TABLE IF NOT EXISTS comments (
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,          -- 0 = oldest of the retained tail
  author        TEXT,
  author_is_bot INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT,
  body          TEXT,                      -- truncated; UNTRUSTED
  PRIMARY KEY (item_id, seq)
);

-- Human/agent triage marks. Separate table so a re-ingest never clobbers them.
CREATE TABLE IF NOT EXISTS triage (
  item_id            TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  outcome            TEXT,                 -- ignored | responded | pr_opened | closed | waiting
  marked_by          TEXT,                 -- "jdx" | "jdx-bot"
  marked_at          TEXT,
  -- an item reopens when new outside activity lands after it was marked
  marked_at_activity TEXT,                 -- items.last_human_at at the time of marking
  snoozed_until      TEXT,
  note               TEXT
);

-- Draft-and-hold. Nothing here has reached GitHub until status = 'posted'.
CREATE TABLE IF NOT EXISTS drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,              -- comment | pr | close
  body         TEXT NOT NULL,              -- exact text that would be posted
  rationale    TEXT,                       -- why the drafter suggests this; never posted
  confidence   TEXT,                       -- low | medium | high
  flags        TEXT,                       -- JSON array, e.g. ["instruction-override"]
  created_by   TEXT NOT NULL,              -- "jdx-bot"
  created_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected|posted|failed
  decided_by   TEXT,
  decided_at   TEXT,
  posted_at    TEXT,
  result_url   TEXT,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS drafts_item   ON drafts(item_id);
CREATE INDEX IF NOT EXISTS drafts_status ON drafts(status);

-- Append-only audit of everything that mutates state or touches GitHub.
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  item_id TEXT,
  detail  TEXT
);

CREATE INDEX IF NOT EXISTS events_at ON events(id DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
