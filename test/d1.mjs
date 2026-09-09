/**
 * A D1 binding backed by in-memory SQLite.
 *
 * The point is to exercise the real handlers rather than a reimplementation of
 * them. Every concurrency bug found so far lived in the exact SQL — a stale
 * revision guard, a conditional claim, an upsert's conflict clause — so a test
 * double that accepted SQL without running it would have proved nothing.
 *
 * Only the surface `src/db.mjs` actually uses is implemented: prepare/bind,
 * all/first/run, and batch.
 */
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'migrations');

class Bound {
  constructor(db, sql, args) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Bound(this.db, this.sql, args);
  }

  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args) };
  }

  async first() {
    // `get` also returns the row for UPDATE ... RETURNING, which the approve
    // and edit paths depend on.
    return this.db.prepare(this.sql).get(...this.args) ?? null;
  }

  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function makeEnv(vars = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of fs.readdirSync(MIGRATIONS).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }

  return {
    raw: db,
    DB: {
      prepare: (sql) => new Bound(db, sql, []),
      // D1 runs a batch as one transaction. Modelling that matters: tests for
      // partial-failure behaviour are meaningless if every statement commits
      // independently.
      batch: async (stmts) => {
        db.exec('BEGIN');
        try {
          const out = [];
          for (const s of stmts) out.push(await s.run());
          db.exec('COMMIT');
          return out;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    TRIAGHE_OWNER: 'jdx',
    OWNER_EMAIL: 'owner@example.test',
    ...vars,
  };
}

/**
 * App credentials for tests. The key is real and generated per run, so the PEM
 * import and JWT signing in `gh.mjs` execute for real instead of being stubbed
 * past — that code has already had one bug (PKCS#1 vs PKCS#8) worth catching.
 */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const APP = {
  GITHUB_APP_ID: '1',
  GITHUB_APP_INSTALLATION_ID: '1',
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

export const owner = { actor: 'jdx', email: 'owner@example.test', canApprove: true };
export const agent = { actor: 'jdx-bot', email: null, canApprove: false };

export function seedItem(env, over = {}) {
  const it = {
    id: 'o/r#issue#1', repo: 'o/r', kind: 'issue', number: 1,
    title: 't', url: 'https://example.test/1', author: 'alice',
    state: 'OPEN', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
  env.raw.prepare(`INSERT INTO items
    (id,repo,kind,number,title,url,author,author_is_bot,state,created_at,updated_at,first_seen_at,fetched_at)
    VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)`)
    .run(it.id, it.repo, it.kind, it.number, it.title, it.url, it.author,
      it.state, it.created_at, it.updated_at, it.created_at, it.created_at);
  return it.id;
}

export function seedDraft(env, itemId, body = 'the text the owner read') {
  const r = env.raw.prepare(
    `INSERT INTO drafts (item_id,kind,body,created_by,created_at) VALUES (?,'comment',?,'jdx-bot',?)`,
  ).run(itemId, body, '2026-01-01T00:00:00Z');
  return Number(r.lastInsertRowid);
}
