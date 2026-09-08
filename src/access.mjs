/**
 * Cloudflare Access identity.
 *
 * Access terminates at Cloudflare's edge and hands the Worker a signed JWT in
 * `Cf-Access-Jwt-Assertion`. We verify that signature ourselves rather than
 * trusting the header's presence, because a Worker can also be reached over
 * routes that were never meant to be public, and "the edge would have blocked
 * it" is an assumption rather than a check.
 *
 * This replaces the `x-triaghe-actor` header the loopback version used. That
 * header was fine on 127.0.0.1 and is not fine on the internet: it let the
 * caller pick its own privilege level. Here the distinction is cryptographic:
 *
 *   human login   -> the JWT carries an `email` claim  -> actor `jdx`, may approve
 *   service token -> the JWT carries `common_name`     -> actor `jdx-bot`, may not
 *
 * A service token literally cannot mint a token with an email claim, so the
 * agent cannot escalate to the approve path even if its own credentials leak.
 */

const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache = { url: null, at: 0, keys: null };

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function jwks(teamDomain) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const fresh = jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS;
  if (fresh && jwksCache.keys) return jwksCache.keys;

  const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  const { keys } = await res.json();
  if (!Array.isArray(keys) || !keys.length) throw new Error('access certs returned no keys');

  jwksCache = { url, at: Date.now(), keys };
  return keys;
}

/**
 * Verify an Access JWT. Returns the claims, or throws. Signature, issuer,
 * audience and expiry are all checked — dropping any one of them turns this
 * into decoration.
 */
async function verify(token, { teamDomain, aud }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const [rawHeader, rawPayload, rawSig] = parts;

  const header = b64urlToJson(rawHeader);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);

  const key = (await jwks(teamDomain)).find((k) => k.kid === header.kid);
  if (!key) throw new Error('no matching access key');

  const pub = await crypto.subtle.importKey(
    'jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', pub,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!ok) throw new Error('bad signature');

  const claims = b64urlToJson(rawPayload);
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && now >= claims.exp) throw new Error('expired');
  if (claims.nbf && now < claims.nbf) throw new Error('not yet valid');
  if (claims.iss !== `https://${teamDomain}`) throw new Error('bad issuer');

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(aud)) throw new Error('bad audience');

  return claims;
}

/**
 * Resolve the caller.
 *
 * `canApprove` is deliberately not "is a human" — it is "is the one specific
 * email in OWNER_EMAIL". Anyone else Access lets through can read and triage
 * but cannot cause anything to be written to GitHub.
 */
export async function identify(request, env) {
  const url = new URL(request.url);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  // `wrangler dev` has no Access in front of it. The bypass needs an explicit
  // var AND a loopback hostname; the deployed Worker is only routable as
  // inbox.jdx.dev, so this branch is unreachable in production.
  if (local && env.DEV_IDENTITY) {
    const agent = env.DEV_IDENTITY === 'agent';
    return {
      actor: agent ? 'jdx-bot' : env.TRIAGHE_OWNER || 'jdx',
      email: agent ? null : env.OWNER_EMAIL || null,
      canApprove: !agent,
      dev: true,
    };
  }

  const token = request.headers.get('cf-access-jwt-assertion')
    || (request.headers.get('cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token) return null;

  const claims = await verify(token, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD,
  });

  const email = (claims.email || '').toLowerCase();
  if (email) {
    return {
      actor: env.TRIAGHE_OWNER || 'jdx',
      email,
      canApprove: email === (env.OWNER_EMAIL || '').toLowerCase(),
    };
  }

  // Service token: `common_name` is the token's client id. No email claim is
  // possible on this path, so canApprove is structurally false.
  return {
    actor: 'jdx-bot',
    email: null,
    serviceToken: claims.common_name ?? null,
    canApprove: false,
  };
}
