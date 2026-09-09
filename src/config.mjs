/**
 * Configuration is read from the Worker `env` rather than process.env, so a
 * deploy changes behaviour through wrangler.toml `[vars]` and `wrangler secret`
 * instead of through anything checked into a public repo.
 */

/** The account whose inbox this is. Items authored by them are not inbound work. */
export const ownerLogin = (env) => env.TRIAGHE_OWNER || 'jdx';

/** Search scope. `user:jdx` covers every repo the account owns. */
export const searchScope = (env) => env.TRIAGHE_SCOPE || `user:${ownerLogin(env)}`;

/**
 * The single identity allowed to approve a post to GitHub. Compared against the
 * verified `email` claim in the Cloudflare Access JWT, never against a header.
 */
export const ownerEmail = (env) => (env.OWNER_EMAIL || '').toLowerCase();

/**
 * Logins that are machinery, not people. Anything reported by GraphQL as a Bot
 * is caught by __typename; this list is only for automation that posts under an
 * ordinary user account, where __typename says User and nothing else gives it
 * away.
 */
export const BOT_LOGINS = new Set([
  'renovate', 'renovate-bot', 'dependabot', 'github-actions', 'codecov',
  'codecov-commenter', 'netlify', 'vercel', 'socket-security', 'sonarcloud',
  'coderabbitai', 'allcontributors', 'stale', 'imgbot', 'pre-commit-ci',
  'release-please', 'semantic-release-bot', 'mergify', 'deepsource-autofix',
  // AI reviewers and release automation running under plain user accounts,
  // so GraphQL reports them as User rather than Bot.
  'greptile-apps', 'gemini-code-assist', 'mise-en-dev', 'sourcery-ai',
  'ellipsis-dev', 'sweep-ai', 'restyled-io', 'snyk-bot', 'trunk-io',
  'github-advanced-security', 'semgrep-app', 'whitesource-bolt-for-github',
  // This board's own agent. It opens PRs here and answers review threads on
  // them, and every one of those replies was arriving as somebody waiting on
  // the owner — including a `@owner` in a reply, which reached the mention band,
  // the one signal the board promotes above everything else.
  //
  // A machine account is a plain user to GraphQL, so nothing else catches it.
  // Being the loudest automation on the owner's own repositories, it is the one
  // omission from this list that compounds: the agent answers a review, that
  // creates inbox work, the owner looks, there is nothing there for them.
  'jdxbot',
]);

/**
 * `authorType` is GraphQL's `__typename` for the author: 'Bot' for every GitHub
 * App, which is the reliable signal. The login list only exists to catch
 * automation running under an ordinary user account.
 */
export function isBot(login, authorType) {
  if (authorType === 'Bot' || authorType === 'Mannequin') return true;
  if (!login) return false;
  const l = login.toLowerCase();
  // `[bot]` only, not `-bot`.
  //
  // GitHub disallows brackets in a username, so the `[bot]` suffix cannot be
  // worn by a person — it is structurally an App. `-bot` is only a naming
  // convention, and anyone may adopt it.
  //
  // That distinction did not matter much while a bot still counted as inbound
  // activity: misfiling a person cost them a slightly wrong label. It matters
  // now. Being classified as automation means a comment cannot undo a mark or
  // reopen a resolved thread, and an open PR lands in Chores — so a guess based
  // on someone's choice of username decides whether they can reach the owner at
  // all, which is not a guess worth making.
  //
  // Nothing is lost: every `-bot` account this board actually sees
  // (`renovate-bot`, `snyk-bot`) is already named in the list above, and of 75
  // distinct actors across the most recent 500 events, none relied on the
  // suffix. An account that does turn up gets added by name, which is a review
  // rather than a heuristic.
  return l.endsWith('[bot]') || BOT_LOGINS.has(l);
}

export function isOwner(login, owner) {
  return !!login && !!owner && login.toLowerCase() === owner.toLowerCase();
}

/**
 * Does this text tag the owner?
 *
 * Deliberately strict about both edges. The leading class rejects an address
 * like `ship@jdx.dev`, which is not a mention; the trailing lookahead rejects
 * `@jdxcode`, which is a different account. Being tagged is the one signal
 * promoted above the rest of the stream, so a false positive there costs more
 * than elsewhere.
 */
export function mentionsOwner(text, owner) {
  if (!text || !owner) return false;
  const safe = String(owner).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9._/-])@${safe}(?![A-Za-z0-9-])`, 'i').test(text);
}

/**
 * Did a *person* tag the owner?
 *
 * Bots tag the owner constantly and mean nothing by it: release automation puts
 * `@owner` in generated changelogs, AI reviewers address their summaries to the
 * author. Counting those defeats the whole point of the mention band, which is
 * "somebody is waiting on you specifically" — in production all three
 * outstanding mentions were release PRs from `mise-en-dev`.
 *
 * Every mention signal routes through here so the badge, the list, and the feed
 * cannot disagree about what counts.
 */
export function isHumanMention(login, authorType, text, owner) {
  return !!login
    && !isOwner(login, owner)
    && !isBot(login, authorType)
    && mentionsOwner(text, owner);
}

/** Labels that mark a pull request as a release cut. */
export const RELEASE_LABELS = new Set(['release', 'releases', 'autorelease']);

/**
 * A title that is a release cut rather than a change to release machinery.
 *
 * Anchored at the start and requiring the release word to be the subject, so
 * `chore: release v1.35.2` and `Release 2026.9.4` match while `fix(release):
 * handle missing tag` and `docs: explain the release process` do not.
 */
const RELEASE_TITLE = /^(?:(?:chore|ci|build)(?:\([^)]*\))?:\s*)?release\b/i;

/**
 * Is this a release PR?
 *
 * Two signals, because neither is reliable alone. The label is the honest one
 * but is not applied everywhere — of the three release PRs open on the live
 * board, `jdx/usage` and `jdx/mise` carried a `release` label and `jdx/fnox`
 * carried none at all, despite all three being the same bot cutting the same
 * kind of release.
 *
 * The title fallback is gated on who wrote it, and the gate admits two people:
 * a release bot, and the owner. It exists to stop a contributor writing
 * "release: cut 2.0 by hand" from being filed away, because that person is
 * waiting on a review. Neither of the two admitted is waiting on anyone — the
 * owner cutting their own release is running the same scheduled chore a bot
 * would, just by hand, which on these repositories is how most of them happen.
 */
export function isReleasePr(item, owner) {
  if (item?.kind !== 'pr') return false;

  const raw = item.labels;
  const labels = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
  if (labels.some((l) => RELEASE_LABELS.has(String(l).toLowerCase()))) return true;

  const routine = !!item.author_is_bot || isOwner(item.author, owner);
  return routine && RELEASE_TITLE.test(item.title || '');
}
