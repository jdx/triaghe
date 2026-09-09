/**
 * triaghe on Cloudflare Workers.
 *
 *   fetch      Access-gated JSON API + the board
 *   scheduled  incremental poll every 15 minutes, plus one backfill window
 *
 * See README for the security model. The short version: everything from GitHub
 * is hostile input, ingest runs no model, and the only path that writes to
 * GitHub requires a verified Access JWT carrying the owner's email.
 */
import { identify } from './access.mjs';
import { handleApi } from './api.mjs';
import { ingestOnce } from './ingest.mjs';

/**
 * No remote origins at all: scripts, styles and images are same-origin only.
 * Untrusted issue and discussion text therefore cannot phone home through an
 * <img> beacon or a stylesheet, even if the client rendering ever slipped.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-store',
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Access is enforced at the edge, but the Worker verifies the assertion
    // itself rather than assuming every route into it passed through Access.
    let identity;
    try {
      identity = await identify(request, env);
    } catch (e) {
      return json(403, { error: `access token rejected: ${e.message}` });
    }
    if (!identity) return json(401, { error: 'no cloudflare access identity' });

    if (url.pathname.startsWith('/api/')) {
      try {
        const { status, body } = await handleApi(request, env, ctx, identity);
        return json(status, body);
      } catch (e) {
        return json(500, { error: String(e.message) });
      }
    }

    // Static board. Re-wrapped so assets carry the same headers as the API
    // instead of relying on a separate _headers file staying in sync.
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(asset.body, { status: asset.status, headers });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      ingestOnce(env).catch(async (e) => {
        // A failed poll must not be silent: it is the difference between "no
        // new work" and "we stopped looking".
        console.error('ingest failed:', e.message);
        try {
          await env.DB.prepare(
            'INSERT INTO events (at, actor, action, item_id, detail) VALUES (?,?,?,?,?)',
          ).bind(new Date().toISOString(), 'ingest', 'poll.failed', null,
            JSON.stringify({ error: String(e.message) })).run();
        } catch { /* the database is the thing that is broken; nothing to do */ }
      }),
    );
  },
};
