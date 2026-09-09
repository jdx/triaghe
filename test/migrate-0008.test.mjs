/**
 * Regression tests for migration 0008.
 *
 * A migration gets one attempt against real data and leaves no way to check its
 * work afterwards, so the failure that matters is the quiet one: a genuine
 * unanswered mention sitting underneath a bot's, discarded because the item
 * columns only remember the most recent.
 *
 * The migration is executed here against a database seeded in the broken
 * pre-fix shape, rather than through makeEnv, which applies it to empty tables
 * where every statement trivially matches nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.join(import.meta.dirname, '..', 'migrations');
const M0008 = fs.readFileSync(path.join(MIGRATIONS, '0008_bot_mentions.sql'), 'utf8');

/** Every migration up to but excluding 0008, so 0008 can be run deliberately. */
function beforeMigration() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of fs.readdirSync(MIGRATIONS).sort()) {
    if (f.startsWith('0008')) break;
    db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
  return db;
}

const seedItem = (db, over = {}) => {
  const it = {
    id: 'o/r#pr#1',
    repo: 'o/r',
    kind: 'pr',
    number: 1,
    title: 'chore: release v1.35.2',
    url: 'https://example.test/1',
    author: 'mise-en-dev',
    author_is_bot: 1,
    state: 'MERGED',
    created_at: '2026-01-01T00:00:00Z',
    body_mentions_owner: 0,
    last_mention_at: null,
    last_mention_actor: null,
    ...over,
  };
  db.prepare(`INSERT INTO items
    (id,repo,kind,number,title,url,author,author_is_bot,state,created_at,updated_at,
     first_seen_at,fetched_at,body_mentions_owner,last_mention_at,last_mention_actor)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(it.id, it.repo, it.kind, it.number, it.title, it.url, it.author, it.author_is_bot,
      it.state, it.created_at, it.created_at, it.created_at, it.created_at,
      it.body_mentions_owner, it.last_mention_at, it.last_mention_actor);
  return it.id;
};

const seedComment = (db, itemId, over) => {
  const c = { parent_gh_id: null, mentions_owner: 1, ...over };
  db.prepare(`INSERT INTO comments
    (gh_id,item_id,author,author_is_bot,created_at,body,mentions_owner,parent_gh_id,first_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(c.gh_id, itemId, c.author, c.author_is_bot, c.created_at,
      c.body ?? '@jdx', c.mentions_owner, c.parent_gh_id, c.created_at);
};

const item = (db) => db.prepare('SELECT * FROM items').get();

test('an older human mention survives a bot mention landing on top of it', () => {
  const db = beforeMigration();
  const id = seedItem(db, {
    // The bot tagged the owner last, so that is all the item columns remember.
    last_mention_at: '2026-02-02T00:00:00Z',
    last_mention_actor: 'mise-en-dev',
  });
  seedComment(db, id, { gh_id: 'C_1', author: 'alice', author_is_bot: 0, created_at: '2026-02-01T00:00:00Z' });
  seedComment(db, id, { gh_id: 'C_2', author: 'mise-en-dev', author_is_bot: 1, created_at: '2026-02-02T00:00:00Z' });

  db.exec(M0008);

  const row = item(db);
  assert.equal(row.last_mention_actor, 'alice',
    'a merged PR is never re-ingested, so discarding this loses it for good');
  assert.equal(row.last_mention_at, '2026-02-01T00:00:00Z');
});

test('a bot-only mention is cleared outright', () => {
  const db = beforeMigration();
  const id = seedItem(db, {
    last_mention_at: '2026-02-02T00:00:00Z',
    last_mention_actor: 'mise-en-dev',
  });
  seedComment(db, id, { gh_id: 'C_1', author: 'mise-en-dev', author_is_bot: 1, created_at: '2026-02-02T00:00:00Z' });

  db.exec(M0008);

  const row = item(db);
  assert.equal(row.last_mention_at, null, 'nothing real is underneath it');
  assert.equal(row.last_mention_actor, null);
  assert.equal(
    db.prepare("SELECT mentions_owner FROM comments WHERE gh_id='C_1'").get().mentions_owner, 0,
    'and the feed flag agrees',
  );
});

test('a mention in a human opening post is recovered', () => {
  const db = beforeMigration();
  seedItem(db, {
    author: 'alice',
    author_is_bot: 0,
    body_mentions_owner: 1,
    last_mention_at: '2026-02-02T00:00:00Z',
    last_mention_actor: 'github-actions',
  });

  const db2 = db;
  db2.exec(M0008);

  const row = item(db2);
  assert.equal(row.last_mention_at, '2026-01-01T00:00:00Z', 'falls back to the opening post');
  assert.equal(row.last_mention_actor, 'alice');
  assert.equal(row.body_mentions_owner, 1, 'a person opening with "@you" still counts');
});

test('a bot opening post loses its flag', () => {
  const db = beforeMigration();
  seedItem(db, { body_mentions_owner: 1, last_mention_at: '2026-01-01T00:00:00Z', last_mention_actor: 'mise-en-dev' });
  db.exec(M0008);
  const row = item(db);
  assert.equal(row.body_mentions_owner, 0);
  assert.equal(row.last_mention_at, null, 'a generated changelog is not an address to the owner');
});

test('a genuine human mention is left completely alone', () => {
  const db = beforeMigration();
  const id = seedItem(db, {
    author: 'alice',
    author_is_bot: 0,
    last_mention_at: '2026-02-01T00:00:00Z',
    last_mention_actor: 'alice',
  });
  // Deliberately no comment row: this is the aged-out tail the monotonic rule
  // exists to protect. Recomputing every item would silently drop it.
  db.exec(M0008);

  const row = item(db);
  assert.equal(row.last_mention_at, '2026-02-01T00:00:00Z');
  assert.equal(row.last_mention_actor, 'alice');
});
