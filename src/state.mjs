/**
 * Pure, deterministic triage state. No model runs here — this is the part that
 * decides what you see, so it stays auditable and cheap.
 */

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

  if (item.state === 'CLOSED' || item.state === 'MERGED') {
    return { state: 'done', reason: `${item.state.toLowerCase()} on github` };
  }
  if (item.is_answered) return { state: 'done', reason: 'answered on github' };

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
