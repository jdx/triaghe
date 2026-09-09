-- Drafting is on-demand: the board asks, jdx-bot answers.
--
-- The queue is a table rather than a webhook because the agent lives on a
-- machine that is not always reachable, and because a request that is still
-- sitting here unclaimed is visible evidence that nothing picked it up. A
-- dropped webhook is silent.

CREATE TABLE IF NOT EXISTS draft_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  note         TEXT,                              -- optional steer: "point at the docs"
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending|claimed|done|failed|cancelled
  claimed_by   TEXT,
  claimed_at   TEXT,
  completed_at TEXT,
  draft_id     INTEGER REFERENCES drafts(id),
  error        TEXT
);

CREATE INDEX IF NOT EXISTS draft_requests_status ON draft_requests(status, id);

-- At most one open request per item, so double-clicking the button or two
-- overlapping polls cannot produce two drafts for the same thread.
CREATE UNIQUE INDEX IF NOT EXISTS draft_requests_open
  ON draft_requests(item_id) WHERE status IN ('pending', 'claimed');
