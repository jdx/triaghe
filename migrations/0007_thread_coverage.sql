-- Coverage below the search result, and a way to close the gap.
--
-- Ingest measured itself against GitHub's `issueCount` for each search window,
-- which only counts threads. Everything nested inside a thread — the comment
-- connection capped at 50, discussion replies capped at 3 — was invisible to
-- that check, so a thread could be counted as fully fetched while comments
-- (and any mention inside them) were never read. The coverage indicator then
-- reported a complete sync over a feed that was missing events.
--
-- `comment_total` is what GitHub says the thread holds, comments plus replies.
-- `comment_gap` is that number minus what is actually stored. It is the unit
-- the drain pass consumes and the number the coverage report adds to its own
-- shortfall, so "we hold everything" is a claim about comments too.
--
-- `parent_gh_id` distinguishes a discussion reply from a top-level comment.
-- Storage keyed on GitHub's node id already made comments accumulate; knowing
-- which are replies is what lets a partially-read thread be counted exactly.

ALTER TABLE items ADD COLUMN comment_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN comment_gap INTEGER NOT NULL DEFAULT 0;

ALTER TABLE comments ADD COLUMN parent_gh_id TEXT;

-- The drain pass asks for the worst gaps first and nothing else, so the index
-- carries the ordering and stays small: incomplete threads are the exception.
CREATE INDEX IF NOT EXISTS items_comment_gap
  ON items(comment_gap DESC) WHERE comment_gap > 0;

-- The feed pages by (at, gh_id) rather than by offset, so its ordering key has
-- to be indexed on both sides of the union.
CREATE INDEX IF NOT EXISTS comments_feed_page ON comments(created_at DESC, gh_id DESC);
CREATE INDEX IF NOT EXISTS items_feed_page ON items(created_at DESC, id DESC);
