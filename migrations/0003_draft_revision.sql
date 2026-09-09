-- Approval must be bound to the exact text the owner read.
--
-- Without this, approve sends only a draft id: the owner opens draft A, the
-- agent edits it to B, and the click posts B. The identity check answers "who
-- clicked", not "what did they agree to". `revision` makes the second question
-- answerable — every edit bumps it, and approve refuses a revision it did not
-- expect.
--
-- It also carries the atomic claim. Approve is a conditional UPDATE on
-- (status, revision), so two overlapping approvals cannot both pass the guard
-- and post the same comment twice.

ALTER TABLE drafts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

-- 'approving' is the window where we have committed to posting but do not yet
-- know GitHub's answer. A draft left in this state is not a bug to be retried
-- blindly: it means the outcome is unknown and a human should look at the
-- thread before anything else is sent.
--
-- status: pending | approving | posted | rejected | failed | uncertain
