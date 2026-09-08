-- Replacing GitHub notifications rather than summarising them.
--
-- Three things the triage board could not express:
--
-- 1. `resolved_at` — when GitHub considered the thread finished (closed,
--    merged, or an answer chosen). Without it "someone commented after this
--    was closed" is unaskable: the board could see the comment and could see
--    the closed state, but not their order, so a closed thread stayed `done`
--    no matter who turned up afterwards.
--
-- 2. `mentions_owner` — whether a comment actually names the owner. Every
--    comment matters, but being tagged is someone asking for you specifically,
--    and that deserves to outrank the rest of the stream.
--
-- 3. `last_mention_at` on items, so the list can rank and filter without
--    re-scanning bodies on every request.

ALTER TABLE items ADD COLUMN resolved_at TEXT;
ALTER TABLE items ADD COLUMN last_mention_at TEXT;
ALTER TABLE items ADD COLUMN last_mention_actor TEXT;

ALTER TABLE comments ADD COLUMN mentions_owner INTEGER NOT NULL DEFAULT 0;

-- The mentions view: newest first, mentions only.
CREATE INDEX IF NOT EXISTS comments_mentions
  ON comments(mentions_owner, created_at DESC);
