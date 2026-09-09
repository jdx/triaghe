-- Clear mentions that were never real.
--
-- Until now the mention band only excluded the owner, not bots, so release
-- automation and AI reviewers writing `@owner` into a generated changelog
-- registered as somebody asking for attention. In production every single
-- outstanding mention was a `mise-en-dev` release PR.
--
-- The ingest fix stops new ones, but it cannot undo these: `last_mention_at`
-- is deliberately monotonic (`MAX(existing, incoming)`) so that a mention is
-- never lost when a later poll reads a shorter comment tail. That same rule
-- means a wrong value is permanent until something deletes it. Hence a
-- migration rather than waiting for re-ingest.
--
-- The login list is duplicated from BOT_LOGINS in src/config.mjs. Duplication
-- is acceptable here precisely because this runs once against the rows that
-- exist today; it is not a rule the application reads.

UPDATE items
SET last_mention_at = NULL,
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

-- Same correction for the two flags the feed reads. These are recomputed on
-- every upsert rather than kept monotonic, so they would eventually heal on
-- their own — but only for items that happen to be touched again, which for a
-- merged release PR is never.
UPDATE items SET body_mentions_owner = 0
WHERE body_mentions_owner = 1 AND author_is_bot = 1;

UPDATE comments SET mentions_owner = 0
WHERE mentions_owner = 1 AND author_is_bot = 1;
