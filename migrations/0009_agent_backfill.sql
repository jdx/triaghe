-- Reclassify activity already stored under the board's own agent.
--
-- Adding `jdxbot` to BOT_LOGINS only changes what ingest decides from now on.
-- Everything already written was decided when the agent counted as a person,
-- and the item summaries do not recompute their way out of it: `last_mention_at`
-- and `last_human_at` are both monotonic, kept that way so a later poll reading
-- a shorter comment tail can never lose a real mention or a real reply. That
-- guarantee is exactly what makes a wrong value permanent.
--
-- Migration 0008 could not have caught these either — it carries its own copy
-- of the login list, and `jdxbot` was not on it when it was written. That
-- duplication is tolerable only because a migration runs once against the rows
-- that exist on the day; it is not a rule the application reads.

-- 1. The per-row classification everything below reads.
UPDATE comments
SET author_is_bot = 1,
    mentions_owner = 0
WHERE LOWER(author) = 'jdxbot';

UPDATE items
SET author_is_bot = 1,
    body_mentions_owner = 0
WHERE LOWER(author) = 'jdxbot';

-- 2. Rebuild the mention summary on rows the agent currently owns.
--
-- Same shape as 0008: rebuild from surviving evidence rather than nulling,
-- because an older unanswered human mention can be sitting underneath. Only
-- reaches NULL when nothing real is left.
--
-- The actor is cleared here and restored in step 3; ingest always writes the
-- pair together, so `at IS NOT NULL AND actor IS NULL` identifies exactly the
-- rows this statement touched.
UPDATE items
SET last_mention_at = (
      SELECT MAX(at) FROM (
        SELECT c.created_at AS at FROM comments c
         WHERE c.item_id = items.id AND c.mentions_owner = 1 AND c.author_is_bot = 0
        UNION ALL
        SELECT items.created_at AS at WHERE items.body_mentions_owner = 1
      )
    ),
    last_mention_actor = NULL
WHERE LOWER(last_mention_actor) = 'jdxbot';

UPDATE items
SET last_mention_actor = CASE
      WHEN body_mentions_owner = 1 AND last_mention_at = created_at THEN author
      ELSE (
        SELECT c.author FROM comments c
         WHERE c.item_id = items.id
           AND c.mentions_owner = 1
           AND c.author_is_bot = 0
           AND c.created_at = items.last_mention_at
         ORDER BY c.gh_id
         LIMIT 1
      )
    END
WHERE last_mention_at IS NOT NULL AND last_mention_actor IS NULL;

-- 3. The same for "who last spoke who was a person".
--
-- This one decides triage state rather than the mention band, and it is why the
-- agent's own PRs were reading as somebody waiting on the owner. The owner's
-- own comments are not excluded from the rebuild — the comments table has no
-- flag for that — but the consequence is harmless: if the owner's comment is
-- the newest non-bot one then `last_human_at` equals `last_owner_at`, and every
-- rule compares them with a strict `>`, so nothing reads as inbound.
UPDATE items
SET last_human_at = (
      SELECT MAX(at) FROM (
        SELECT c.created_at AS at FROM comments c
         WHERE c.item_id = items.id AND c.author_is_bot = 0
        UNION ALL
        SELECT items.created_at AS at WHERE items.author_is_bot = 0
      )
    ),
    last_human_actor = NULL
WHERE LOWER(last_human_actor) = 'jdxbot';

UPDATE items
SET last_human_actor = CASE
      WHEN author_is_bot = 0 AND last_human_at = created_at THEN author
      ELSE (
        SELECT c.author FROM comments c
         WHERE c.item_id = items.id
           AND c.author_is_bot = 0
           AND c.created_at = items.last_human_at
         ORDER BY c.gh_id
         LIMIT 1
      )
    END
WHERE last_human_at IS NOT NULL AND last_human_actor IS NULL;
