-- Two gaps the notification-replacement work left open.
--
-- `body_mentions_owner` records whether the *opening post* tags the owner, as
-- distinct from the item's aggregate `last_mention_at`. The feed's `opened`
-- events had no way to express this and hardcoded 0, so an issue titled "Hi
-- @you" showed in Mentions while `/api/feed?mentions=1` contained nothing for
-- it. The aggregate cannot substitute: it may refer to a later comment.
--
-- The mention search also needs its own checkpoint rather than riding the
-- shared `last_ingest_at`, which advances on the owner-repository search alone.
-- That lives in `meta` as `mentions_ingest_at` and needs no schema.

ALTER TABLE items ADD COLUMN body_mentions_owner INTEGER NOT NULL DEFAULT 0;
