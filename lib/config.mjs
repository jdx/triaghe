import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DB_PATH = process.env.TRIAGHE_DB || join(ROOT, 'data', 'inbox.sqlite');

/** The account whose inbox this is. Items authored by them are not "inbound work". */
export const OWNER_LOGIN = process.env.TRIAGHE_OWNER || 'jdx';

/** Search scope. `user:jdx` covers every repo the account owns. */
export const SEARCH_SCOPE = process.env.TRIAGHE_SCOPE || `user:${OWNER_LOGIN}`;

export const PORT = Number(process.env.TRIAGHE_PORT || 8787);

/**
 * Logins that are machinery, not people. Anything ending in `[bot]` is caught
 * separately; this list is for bots that post under a plain user account.
 */
export const BOT_LOGINS = new Set([
  'renovate', 'renovate-bot', 'dependabot', 'github-actions', 'codecov',
  'codecov-commenter', 'netlify', 'vercel', 'socket-security', 'sonarcloud',
  'coderabbitai', 'allcontributors', 'stale', 'imgbot', 'pre-commit-ci',
  'release-please', 'semantic-release-bot', 'mergify', 'deepsource-autofix',
  // AI reviewers and release automation that post under plain user accounts,
  // so GraphQL reports them as User rather than Bot.
  'greptile-apps', 'gemini-code-assist', 'mise-en-dev', 'sourcery-ai',
  'ellipsis-dev', 'sweep-ai', 'restyled-io', 'snyk-bot', 'trunk-io',
  'github-advanced-security', 'semgrep-app', 'whitesource-bolt-for-github',
]);

/**
 * `authorType` is GraphQL's `__typename` for the author: 'Bot' for every
 * GitHub App, which is the reliable signal. The login list only exists to catch
 * automation running under an ordinary user account.
 */
export function isBot(login, authorType) {
  if (authorType === 'Bot' || authorType === 'Mannequin') return true;
  if (!login) return false;
  const l = login.toLowerCase();
  return l.endsWith('[bot]') || l.endsWith('-bot') || BOT_LOGINS.has(l);
}

export function isOwner(login) {
  return !!login && login.toLowerCase() === OWNER_LOGIN.toLowerCase();
}

/**
 * Read the GitHub token from the Gateway-managed gh profile at call time, so we
 * always pick up a refreshed token instead of caching a stale one.
 * The token is never logged, never written to the DB, and never sent anywhere
 * except api.github.com.
 */
export function githubToken() {
  if (process.env.TRIAGHE_TOKEN) return process.env.TRIAGHE_TOKEN;
  const dir = process.env.GH_CONFIG_DIR;
  if (!dir) throw new Error('set GH_CONFIG_DIR to the gh profile dir (see README)');
  const yml = readFileSync(join(dir, 'hosts.yml'), 'utf8');
  const m = yml.match(/^\s+oauth_token:\s*(\S+)/m);
  if (!m) throw new Error(`no oauth_token found in ${dir}/hosts.yml`);
  return m[1];
}
