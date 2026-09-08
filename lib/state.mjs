import { isBot, isOwner } from './config.mjs';

/**
 * Pure, deterministic triage state. No model runs here — this is the part that
 * decides what you see, so it stays auditable and cheap.
 */
export function computeState(item, triage) {
  const now = Date.now();

  if (triage?.snoozed_until && Date.parse(triage.snoozed_until) > now) {
    return { state: 'snoozed', reason: `snoozed until ${triage.snoozed_until}` };
  }

  // A mark sticks until a real person speaks again after it. Bot chatter on a
  // thread you already handled must not drag it back into the inbox.
  if (triage?.outcome) {
    const newer = item.last_human_at && triage.marked_at_activity &&
      Date.parse(item.last_human_at) > Date.parse(triage.marked_at_activity);
    if (!newer) return { state: 'done', reason: `marked ${triage.outcome}` };
    return { state: 'needs_you', reason: `reopened: ${item.last_human_actor} replied` };
  }

  if (item.state === 'CLOSED' || item.state === 'MERGED') {
    return { state: 'done', reason: `${item.state.toLowerCase()} on github` };
  }
  if (item.is_answered) return { state: 'done', reason: 'answered on github' };

  // No outside human has touched it: renovate/dependabot churn and your own
  // release PRs. Still visible under the "noise" filter, just never in the inbox.
  if (!item.last_human_at) {
    return { state: 'noise', reason: `automated (${item.author})` };
  }

  const lastOwner = item.last_owner_at ? Date.parse(item.last_owner_at) : 0;
  const lastHuman = Date.parse(item.last_human_at);

  if (lastHuman > lastOwner) {
    return {
      state: 'needs_you',
      reason: lastOwner ? `${item.last_human_actor} replied after you` : 'no reply yet',
    };
  }
  return { state: 'awaiting_them', reason: 'you spoke last' };
}

/** Rough ordering hint: older untouched things and maintainer-adjacent authors first. */
export function priority(item, state) {
  if (state !== 'needs_you') return 0;
  const ageDays = (Date.now() - Date.parse(item.created_at)) / 86400000;
  let p = Math.min(ageDays, 60);
  if (item.kind === 'pr') p += 25;                       // PRs rot fastest
  if (item.author_assoc === 'CONTRIBUTOR') p += 10;      // returning contributors
  if (item.author_assoc === 'MEMBER') p += 15;
  if (item.comment_count === 0) p += 5;                  // nobody has looked at it
  return Math.round(p);
}

export const classifyAuthor = { isBot, isOwner };
