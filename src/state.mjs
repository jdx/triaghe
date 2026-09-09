/**
 * Pure, deterministic triage state. No model runs here — this is the part that
 * decides what you see, so it stays auditable and cheap.
 */
import { isReleasePr } from './config.mjs';

/**
 * When did work last arrive from outside?
 *
 * Prefer activity by a real person who is not the owner. That preference is the
 * load-bearing detail: a CodeRabbit or Greptile review comment landing on a
 * contributor's PR must not mask the contributor who is actually waiting.
 *
 * Fall back to the last actor of any kind, which is how purely automated items
 * — renovate, dependabot, release PRs — still count as work. They are open PRs
 * on your repos and somebody has to merge them.
 */
function lastInbound(item) {
  if (item.last_human_at) return { at: item.last_human_at, who: item.last_human_actor, human: true };
  if (item.last_actor_at) return { at: item.last_actor_at, who: item.last_actor, human: false };
  return { at: null, who: null, human: false };
}

export function computeState(item, triage) {
  const now = Date.now();

  if (triage?.snoozed_until && Date.parse(triage.snoozed_until) > now) {
    return { state: 'snoozed', reason: `snoozed until ${triage.snoozed_until}` };
  }

  const inbound = lastInbound(item);

  // A mark sticks until something new arrives after it.
  if (triage?.outcome) {
    const newer = inbound.at && triage.marked_at_activity
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

    // Reopen only for activity that landed *after* GitHub resolved it, and that
    // the owner has not already answered. Without `resolved_at` this cannot be
    // asked, which is why it is now ingested.
    const since = item.resolved_at ? Date.parse(item.resolved_at) : null;
    const spoke = inbound.at ? Date.parse(inbound.at) : null;
    const answered = item.last_owner_at ? Date.parse(item.last_owner_at) : 0;
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
  if (isReleasePr(item)) {
    return { state: 'release', reason: `release cut by ${item.author} — merge to ship` };
  }

  // Nothing has happened at all. Only reachable for an item with no author and
  // no comments, which GitHub should not produce, but the state machine should
  // not depend on that.
  if (!inbound.at) return { state: 'awaiting_them', reason: 'no activity' };

  const lastOwner = item.last_owner_at ? Date.parse(item.last_owner_at) : 0;

  if (Date.parse(inbound.at) > lastOwner) {
    const reason = inbound.human
      ? lastOwner ? `${inbound.who} replied after you` : 'no reply yet'
      : `automated (${item.author}) — needs a merge or a close`;
    return { state: 'needs_you', reason };
  }
  return { state: 'awaiting_them', reason: 'you spoke last' };
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
