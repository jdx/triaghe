-- Give comments an identity so history can accumulate.
--
-- The old table was keyed (item_id, seq) where seq was a position inside the
-- retained tail, and every poll deleted the tail and reinserted it. That works
-- for "show the last few comments" and makes anything else impossible: a
-- comment had no stable identity, and everything past the tail was destroyed on
-- the next tick.
--
-- A reverse-chronological activity feed needs the opposite property — rows that
-- arrive once and stay. Keying on GitHub's node id makes ingest an idempotent
-- upsert instead of a destructive rewrite, which also removes the delete/insert
-- pair that previously had to be kept inside one transaction to avoid losing a
-- thread's comments on a mid-run failure.
--
-- Existing rows are dropped rather than migrated. They are a bounded cache of
-- each thread's last ten comments with no stable key to migrate onto, and the
-- next poll refetches them. Nothing here is a system of record.

DROP TABLE IF EXISTS comments;

CREATE TABLE comments (
  gh_id         TEXT PRIMARY KEY,          -- GitHub node id; stable across polls
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  author        TEXT,
  author_is_bot INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT,
  body          TEXT,                      -- truncated; UNTRUSTED
  first_seen_at TEXT                       -- when this poller first saw it
);

-- Thread view: the comments of one item, oldest first.
CREATE INDEX IF NOT EXISTS comments_item ON comments(item_id, created_at);

-- Feed view: everything that happened, newest first. The feed filters by repo,
-- which lives on items, so this index carries the ordering and the join key
-- does the narrowing.
CREATE INDEX IF NOT EXISTS comments_recent ON comments(created_at DESC);
