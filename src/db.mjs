/**
 * Thin helpers over the D1 binding.
 *
 * Every query in this project goes through `.bind()`. There is no string
 * interpolation of GitHub content into SQL anywhere, which is what makes it
 * safe to store hostile text verbatim.
 *
 * D1 supports positional `?` parameters. The node:sqlite version of this
 * project used named `$name` parameters; those are not portable here, so the
 * ingest upsert is written positionally.
 */

export const all = async (env, sql, ...args) =>
  (await env.DB.prepare(sql).bind(...args).all()).results ?? [];

export const first = (env, sql, ...args) =>
  env.DB.prepare(sql).bind(...args).first();

export const run = (env, sql, ...args) =>
  env.DB.prepare(sql).bind(...args).run();

/**
 * Append to the audit log. Every mutation and every GitHub write calls this.
 * Detail is JSON-encoded so the row stays a single opaque string.
 */
export function log(env, actor, action, itemId, detail) {
  return run(
    env,
    'INSERT INTO events (at, actor, action, item_id, detail) VALUES (?,?,?,?,?)',
    new Date().toISOString(),
    actor,
    action,
    itemId ?? null,
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
  );
}

export async function getMeta(env, key, fallback = null) {
  const row = await first(env, 'SELECT value FROM meta WHERE key = ?', key);
  return row ? row.value : fallback;
}

export function setMeta(env, key, value) {
  return run(
    env,
    'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key,
    String(value),
  );
}
