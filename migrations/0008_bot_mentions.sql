-- Correct mentions that were never real.
--
-- Until now the mention band only excluded the owner, not bots, so release
-- automation and AI reviewers writing `@owner` into a generated changelog
-- registered as somebody asking for attention. In production every single
-- outstanding mention was a `mise-en-dev` release PR.
--
-- The ingest fix stops new ones, but it cannot undo these: `last_mention_at`
-- is deliberately monotonic (`MAX(existing, incoming)`) so that a mention is
-- never lost when a later poll reads a shorter comment tail. That same rule
-- means a wrong value is permanent until something deletes it.
--
-- The item columns hold only the *latest* mention, so a bot tag can be sitting
-- on top of an earlier, genuine, still-unanswered human one. Simply nulling
-- them would throw that away for good — closed and merged items stop being
-- re-ingested once their update window passes, so nothing would ever put it
-- back. The comments table still has the evidence, so rebuild from it.

-- 1. Per-comment flags first: everything below reads them as the source of
--    truth for what a real mention is.
UPDATE comments SET mentions_owner = 0
WHERE mentions_owner = 1 AND author_is_bot = 1;

-- 2. The opening-post flag, same correction.
UPDATE items SET body_mentions_owner = 0
WHERE body_mentions_owner = 1 AND author_is_bot = 1;

-- 3. Rebuild the item summary for rows a bot currently owns.
--
-- Scoped to those rows on purpose. `comments` holds a tail, not full history,
-- so recomputing every item would drop mentions whose comment has aged out —
-- the exact loss the monotonic rule exists to prevent. For a row whose stored
-- actor is a bot the summary is already wrong, so rebuilding it is never worse
-- than the alternative, and lands on NULL only when no evidence survives.
--
-- The actor is cleared here and restored in step 4; ingest always writes the
-- two columns together, so `at IS NOT NULL AND actor IS NULL` uniquely
-- identifies the rows this statement just touched.
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
WHERE last_mention_actor IS NOT NULL
  AND (
    LOWER(last_mention_actor) LIKE '%[bot]'
    OR LOWER(last_mention_actor) LIKE '%-bot'
    OR LOWER(last_mention_actor) IN (
      'renovate', 'renovate-bot', 'dependabot', 'github-actions', 'codecov',
      'codecov-commenter', 'netlify', 'vercel', 'socket-security', 'sonarcloud',
      'coderabbitai', 'allcontributors', 'stale', 'imgbot', 'pre-commit-ci',
      'release-please', 'semantic-release-bot', 'mergify', 'deepsource-autofix',
      'greptile-apps', 'gemini-code-assist', 'mise-en-dev', 'sourcery-ai',
      'ellipsis-dev', 'sweep-ai', 'restyled-io', 'snyk-bot', 'trunk-io',
      'github-advanced-security', 'semgrep-app', 'whitesource-bolt-for-github'
    )
  );

-- 4. Name whoever wrote the mention step 3 settled on: the opening post when
--    the timestamp is the item's own, otherwise the comment at that instant.
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
