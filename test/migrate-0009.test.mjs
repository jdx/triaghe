/**
 * Regression tests for migration 0009.
 *
 * Adding a login to BOT_LOGINS only changes what ingest decides next. The rows
 * already written were decided when the agent counted as a person, and neither
 * summary recomputes its way out of that: `last_mention_at` and `last_human_at`
 * are monotonic on purpose, so a wrong value is permanent until something
 * deletes it. These tests run the migration against a database seeded in that
 * broken shape, rather than through makeEnv, where it would only ever meet
 * empty tables that every statement trivially matches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'migrations');
const M0009 = fs.readFileSync(path.join(MIGRATIONS, '0009_agent_backfill.sql'), 'utf8');

function beforeMigration() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of fs.readdirSync(MIGRATIONS).sort()) {
    if (f.startsWith('0009')) break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
  return db;
}

const seedItem = (db, over = {}) => {
  const it = {
    id: 'o/r#pr#1', repo: 'o/r', kind: 'pr', number: 1,
    title: 'Stop the inbox surfacing automation as attention',
    url: 'https://example.test/1', author: 'jdxbot', author_is_bot: 0,
    state: 'OPEN', created_at: '2026-01-01T00:00:00Z',
    body_mentions_owner: 0, last_mention_at: null, last_mention_actor: null,
    last_human_at: null, last_human_actor: null,
    ...over,
  };
  db.prepare(`INSERT INTO items
    (id,repo,kind,number,title,url,author,author_is_bot,state,created_at,updated_at,
     first_seen_at,fetched_at,body_mentions_owner,last_mention_at,last_mention_actor,
     last_human_at,last_human_actor)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(it.id, it.repo, it.kind, it.number, it.title, it.url, it.author, it.author_is_bot,
      it.state, it.created_at, it.created_at, it.created_at, it.created_at,
      it.body_mentions_owner, it.last_mention_at, it.last_mention_actor,
      it.last_human_at, it.last_human_actor);
  return it.id;
};

const seedComment = (db, itemId, c) => {
  db.prepare(`INSERT INTO comments
    (gh_id,item_id,author,author_is_bot,created_at,body,mentions_owner,parent_gh_id,first_seen_at)
    VALUES (?,?,?,?,?,?,?,NULL,?)`)
    .run(c.gh_id, itemId, c.author, c.author_is_bot, c.created_at,
      c.body ?? '@jdx', c.mentions_owner ?? 0, c.created_at);
};

const item = (db) => db.prepare('SELECT * FROM items').get();

test('the agent\'s own mention is cleared', () => {
  // Observed live: the single outstanding mention on the board was the agent
  // tagging the owner in its own review reply.
  const db = beforeMigration();
  const id = seedItem(db, {
    last_mention_at: '2026-09-09T15:59:37Z',
    last_mention_actor: 'jdxbot',
    last_human_at: '2026-09-09T15:59:37Z',
    last_human_actor: 'jdxbot',
  });
  seedComment(db, id, {
    gh_id: 'C_1', author: 'jdxbot', author_is_bot: 0,
    created_at: '2026-09-09T15:59:37Z', mentions_owner: 1,
  });

  db.exec(M0009);

  const row = item(db);
  assert.equal(row.last_mention_at, null);
  assert.equal(row.last_mention_actor, null);
  assert.equal(row.last_human_at, null, 'nor does it read as somebody waiting');
  assert.equal(
    db.prepare("SELECT author_is_bot, mentions_owner FROM comments WHERE gh_id='C_1'").get().author_is_bot,
    1, 'the stored classification is corrected too, so later passes agree');
});

test('a real mention underneath the agent\'s survives', () => {
  // The property that makes rebuilding safer than nulling: the item columns
  // remember only the newest, and a merged PR is never re-ingested.
  const db = beforeMigration();
  const id = seedItem(db, {
    author: 'alice',
    last_mention_at: '2026-09-09T15:59:37Z',
    last_mention_actor: 'jdxbot',
    last_human_at: '2026-09-09T15:59:37Z',
    last_human_actor: 'jdxbot',
  });
  seedComment(db, id, {
    gh_id: 'C_1', author: 'alice', author_is_bot: 0,
    created_at: '2026-09-08T10:00:00Z', mentions_owner: 1,
  });
  seedComment(db, id, {
    gh_id: 'C_2', author: 'jdxbot', author_is_bot: 0,
    created_at: '2026-09-09T15:59:37Z', mentions_owner: 1,
  });

  db.exec(M0009);

  const row = item(db);
  assert.equal(row.last_mention_actor, 'alice');
  assert.equal(row.last_mention_at, '2026-09-08T10:00:00Z');
  assert.equal(row.last_human_actor, 'alice', 'and she is still the one waiting');
});

test('an opening post by the agent stops counting as a mention', () => {
  const db = beforeMigration();
  seedItem(db, {
    body_mentions_owner: 1,
    last_mention_at: '2026-01-01T00:00:00Z',
    last_mention_actor: 'jdxbot',
    last_human_at: '2026-01-01T00:00:00Z',
    last_human_actor: 'jdxbot',
  });

  db.exec(M0009);

  const row = item(db);
  assert.equal(row.body_mentions_owner, 0);
  assert.equal(row.last_mention_at, null);
  assert.equal(row.author_is_bot, 1);
});

test('nobody else is touched', () => {
  // The guard against this widening into "clear anything that looks automated".
  const db = beforeMigration();
  const id = seedItem(db, {
    author: 'alice',
    last_mention_at: '2026-09-08T10:00:00Z',
    last_mention_actor: 'alice',
    last_human_at: '2026-09-08T10:00:00Z',
    last_human_actor: 'alice',
  });
  seedComment(db, id, {
    gh_id: 'C_1', author: 'alice', author_is_bot: 0,
    created_at: '2026-09-08T10:00:00Z', mentions_owner: 1,
  });

  db.exec(M0009);

  const row = item(db);
  assert.equal(row.last_mention_actor, 'alice');
  assert.equal(row.last_mention_at, '2026-09-08T10:00:00Z');
  assert.equal(row.last_human_actor, 'alice');
  assert.equal(row.author_is_bot, 0);
});
