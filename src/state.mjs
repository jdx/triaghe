/**
 * Pure, deterministic triage state. No model runs here — this is the part that
 * decides what you see, so it stays auditable and cheap.
 */
import { isOwner, isReleasePr } from './config.mjs';

/**
 * When did work last arrive from outside?
 *
 * Prefer activity by a real person who is not the owner. That preference is the
 * load-bearing detail: a CodeRabbit or Greptile review comment landing on a
 * contributor's PR must not mask the contributor who is actually waiting.
 *
 * Fall back to the last actor of any kind. This is still needed to answer "has
 * anything happened here", but note what it is *not* used for any more: nothing
 * below moves an item into the inbox on the strength of it.
 */
function lastInbound(item) {
  if (item.last_human_at) return { at: item.last_human_at, who: item.last_human_actor, human: true };
  if (item.last_actor_at) return { at: item.last_actor_at, who: item.last_actor, human: false };
  return { at: null, who: null, human: false };
}

/**
 * Automation cannot put anything in the inbox.
 *
 * Every path into `needs_you` goes through here, and the reason it has to is
 * that Socket, Greptile, CodeRabbit and github-actions comment on essentially
 * every pull request. Measured on the live board: a hand-cleared inbox went
 * from 6 items to 12 in ninety minutes, and nine of the twelve were there
 * because a bot had spoken. Two of those were items the owner had marked done
 * an hour earlier; one was a *merged* PR that CodeRabbit commented on.
 *
 * That is not noise you can live with, because it compounds — an inbox that
 * refills itself is one nobody trusts enough to empty. Bot activity still
 * updates the item, still keeps its timestamps current, and still shows in the
 * feed, which is the surface that exists to answer "is the poller working".
 * It just never says somebody is waiting on you, because nobody is.
 */
const personWaitingSince = (item, inbound, lastOwner) =>
  inbound.human && inbound.at && Date.parse(inbound.at) > lastOwner;

export function computeState(item, triage, owner) {
  const now = Date.now();

  if (triage?.snoozed_until && Date.parse(triage.snoozed_until) > now) {
    return { state: 'snoozed', reason: `snoozed until ${triage.snoozed_until}` };
  }

  const inbound = lastInbound(item);
  const lastOwner = item.last_owner_at ? Date.parse(item.last_owner_at) : 0;

  // A mark sticks until a *person* arrives after it.
  //
  // This was the single largest source of the refill. Marking something done
  // records the activity timestamp it was cleared at; any later activity used
  // to undo that, and Socket posting its scan report an hour later counts as
  // later activity. The owner's decision was being overturned by a robot.
  if (triage?.outcome) {
    const newer = inbound.human && inbound.at && triage.marked_at_activity
      && Date.parse(inbound.at) > Date.parse(triage.marked_at_activity);
    if (!newer) return { state: 'done', reason: `marked ${triage.outcome}` };
    return { state: 'needs_you', reason: `reopened: ${inbound.who} replied` };
  }

  // Closed is not the same as finished. People keep talking on closed threads —
  // "this broke again in 2.1", "how do I do the thing you mentioned" — and that
  // is exactly the traffic GitHub notifications used to surface. Previously any
  // CLOSED/MERGED/answered item returned `done` before activity was ever
  // considered, so those comments landed in the database and were never shown.
  const resolved = item.state === 'CLOSED' || item.state === 'MERGED' || item.is_answered;
  if (resolved) {
    const label = item.is_answered && item.state !== 'CLOSED' && item.state !== 'MERGED'
      ? 'answered on github'
      : `${String(item.state).toLowerCase()} on github`;

    // Reopen only for a person who turned up *after* GitHub resolved it, and
    // whom the owner has not already answered. Without `resolved_at` this
    // cannot be asked, which is why it is now ingested.
    //
    // The human requirement matters most here: a merged PR attracts CI results
    // and review-bot summaries for hours afterwards, and every one of them was
    // resurrecting it. A merged PR that CodeRabbit commented on is finished.
    const since = item.resolved_at ? Date.parse(item.resolved_at) : null;
    const spoke = inbound.human && inbound.at ? Date.parse(inbound.at) : null;
    const answered = lastOwner;
    if (since && spoke && spoke > since && spoke > answered) {
      return {
        state: 'needs_you',
        reason: `${inbound.who} commented after it was ${label.split(' ')[0]}`,
      };
    }
    return { state: 'done', reason: label };
  }

  // Release PRs get their own lane rather than the inbox.
  //
  // They are real work — somebody has to merge them to ship — but they are a
  // scheduled chore, not a person waiting, and they arrive often enough to be
  // most of what a quiet inbox contains. Deliberately placed *after* the
  // resolved branch: merging one is how a release happens, and a merged release
  // PR should read as done like anything else.
  //
  // Not hidden. `?state=release` and the Releases tab still list them, and the
  // feed shows them regardless, because an inbox filter that loses a pending
  // release is worse than one that never existed.
  //
  // It also yields to a person. A release PR is a chore right up until somebody
  // turns up on it — "this one breaks the macOS build", "hold this until #400
  // lands" — and that comment has to reach the inbox like any other. Without
  // the check the lane is unconditional, and because both the Mentions filter
  // and the badge require `needs_you`, tagging the owner on a release PR would
  // have been the one way to make a direct request invisible.
  const personWaiting = personWaitingSince(item, inbound, lastOwner);

  // An open pull request the owner wrote is theirs to finish.
  //
  // This is the one inbox entry that is not somebody waiting, and it is here
  // because it is the owner's own unfinished work — the queue they are trying
  // to clear, not a request they are trying to answer. It has to be stated
  // rather than fall out of the activity rules, because after this change
  // nothing else would put it here: only CI and review bots speak on most of
  // them, and the whole point above is that a bot speaking means nothing.
  //
  // Deliberately PRs and not issues. An issue the owner opened on their own
  // repository is usually a note to themselves; an open PR is work in flight.
  // It also sits after the resolved branch, so merging or closing one settles
  // it, which is what makes the lane drain instead of accumulating.
  if (isOwner(item.author, owner) && item.kind === 'pr' && !personWaiting) {
    return {
      state: 'needs_you',
      reason: item.is_draft ? 'your draft — still open' : 'your PR — still open',
    };
  }

  if (isReleasePr(item) && !personWaiting) {
    return { state: 'release', reason: `release cut by ${item.author} — merge to ship` };
  }

  // Everything else automation opened, in a lane beside Releases.
  //
  // Renovate and Dependabot open real work — somebody has to merge or close it
  // — but it is a batch chore you sit down to, not a person waiting for a
  // reply. Left in the inbox it is most of the volume, and after the change
  // above it would otherwise have drifted into `awaiting_them` and read as
  // "waiting on someone else", which is worse: nobody is coming.
  //
  // Yields to a person on the same terms Releases does. "This bump breaks the
  // macOS build" belongs in the inbox no matter who opened the PR.
  if (item.author_is_bot && !personWaiting) {
    return { state: 'chore', reason: `opened by ${item.author} — merge or close` };
  }

  // Nothing has happened at all. Only reachable for an item with no author and
  // no comments, which GitHub should not produce, but the state machine should
  // not depend on that.
  if (!inbound.at) return { state: 'awaiting_them', reason: 'no activity' };

  if (personWaiting) {
    return {
      state: 'needs_you',
      reason: lastOwner ? `${inbound.who} replied after you` : 'no reply yet',
    };
  }

  // Reached when the last word was the owner's, or was automation's on an item
  // a person opened. The old wording here read "automated (jdx) — needs a merge
  // or a close" on the owner's own pull requests: it named the *author* while
  // describing the *actor*, so it was wrong twice over.
  return {
    state: 'awaiting_them',
    reason: inbound.human || !inbound.at
      ? 'you spoke last'
      : `nothing since ${inbound.who} (automated)`,
  };
}

/**
 * Rough ordering hint within the inbox.
 *
 * Dependency PRs are inbox work, but they are a batch chore rather than
 * somebody waiting on an answer, so they do not accrue urgency with age the way
 * a person's unanswered question does. They stay fully visible and fully
 * counted — this only decides what sits at the top of the list.
 */
export function priority(item, state) {
  if (state !== 'needs_you') return 0;

  // Someone typing your handle is asking for you specifically, rather than
  // leaving a message the queue happens to contain. It outranks everything
  // else in the inbox, and only loses to another mention.
  if (item.last_mention_at
    && (!item.last_owner_at
      || Date.parse(item.last_mention_at) > Date.parse(item.last_owner_at))) {
    return 1000 + Math.min((Date.now() - Date.parse(item.last_mention_at)) / 86400000, 60);
  }

  // Two bands that cannot overlap: automation scores at most 10, a person
  // always scores at least 20. Without the floor, a question somebody asked
  // this morning sorts below a Dependency Dashboard, because the human score
  // starts from age in days.
  if (!item.last_human_at) return item.kind === 'pr' ? 10 : 5;

  const ageDays = (Date.now() - Date.parse(item.created_at)) / 86400000;
  let p = 20 + Math.min(ageDays, 60);
  if (item.kind === 'pr') p += 25;                       // PRs rot fastest
  if (item.author_assoc === 'CONTRIBUTOR') p += 10;      // returning contributors
  if (item.author_assoc === 'MEMBER') p += 15;
  if (item.comment_count === 0) p += 5;                  // nobody has looked at it
  return Math.round(p);
}
