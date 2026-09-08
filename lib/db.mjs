import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DB_PATH, ROOT } from './config.mjs';

let db;

export function open() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/**
 * schema.sql only creates missing tables, so columns added later need an
 * explicit ALTER. Adding a column is the only migration shape used here.
 */
function migrate(db) {
  const added = [
    ['items', 'last_human_at', 'TEXT'],
    ['items', 'last_human_actor', 'TEXT'],
    ['items', 'node_id', 'TEXT'],
  ];
  for (const [table, col, decl] of added) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}

export function log(actor, action, itemId, detail) {
  open().prepare(
    'INSERT INTO events (at, actor, action, item_id, detail) VALUES (?,?,?,?,?)'
  ).run(new Date().toISOString(), actor, action, itemId ?? null,
        detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
}

export function getMeta(key, fallback = null) {
  const row = open().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  open().prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}
