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
  return l.endsWith('[bot]') || l.endsWith('-bot') || BOT_LOGINS.has(l);
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
