/**
 * GitHub access, authenticated as a GitHub App installation.
 *
 * Why an App rather than a PAT: the credential sitting in Cloudflare is an RSA
 * key that mints installation tokens lasting one hour. The App's permissions are
 * pinned to issues, discussions and pull requests, so even a full compromise of
 * the Worker cannot push code, merge, or touch a repo the App is not installed
 * on. Revoking it is one click and does not disturb any human's account.
 */

let cachedToken = { value: null, expiresAt: 0 };

// ── DER / PEM ──────────────────────────────────────────────────────────────
// GitHub hands you a PKCS#1 key ("BEGIN RSA PRIVATE KEY"). WebCrypto only
// imports PKCS#8. Rather than make the key's owner run openssl, wrap it here:
// PKCS#8 is just PKCS#1 with a version and an algorithm identifier in front.

const RSA_OID = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

function derLength(n) {
  if (n < 0x80) return [n];
  const out = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

function pkcs1ToPkcs8(pkcs1) {
  const octet = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [0x02, 0x01, 0x00, ...RSA_OID, ...octet];
  return Uint8Array.from([0x30, ...derLength(body.length), ...body]);
}

function pemBody(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function importPrivateKey(pem) {
  const der = pemBody(pem);
  const pkcs8 = /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1ToPkcs8(Array.from(der)) : der;
  return crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── App auth ───────────────────────────────────────────────────────────────

async function appJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  // 60s of clock skew backwards, 9 minutes forward: GitHub rejects anything
  // over 10 minutes.
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID,
  })));
  const key = await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Installation token, cached in the isolate until a minute before it expires. */
async function token(env) {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;

  // Check up front. Without this, a missing secret surfaces from deep inside
  // the PEM parser as "Cannot read properties of undefined (reading 'replace')",
  // which tells whoever is on call nothing about what to go fix.
  const missing = ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY']
    .filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`github app is not configured: missing ${missing.join(', ')}`);
  }

  const res = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await appJwt(env)}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'triaghe',
      },
    },
  );
  if (!res.ok) {
    // Deliberately does not include the response body: it is the one place a
    // GitHub error could echo credential material into a log line.
    throw new Error(`installation token failed: ${res.status}`);
  }
  const json = await res.json();
  cachedToken = { value: json.token, expiresAt: Date.parse(json.expires_at) };
  return cachedToken.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── API ────────────────────────────────────────────────────────────────────

const ENDPOINT = 'https://api.github.com/graphql';

/**
 * Minimal GraphQL client with retry on secondary rate limits. Backoff is
 * capped tighter than the node version because this runs inside a scheduled
 * Worker where wall-clock time is not free.
 */
export async function graphql(env, query, variables = {}, { retries = 3, write = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `bearer ${await token(env)}`,
          'content-type': 'application/json',
          'user-agent': 'triaghe',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      // A mutation whose connection dropped may well have been applied. Reads
      // can be retried freely; a write cannot, so the caller is told the
      // outcome is unknown rather than that it failed.
      throw Object.assign(new Error(`github request failed: ${e.message}`), { uncertain: write });
    }

    // GitHub answers 403 both for "slow down" and for "this key is not allowed
    // here". Retrying the second is pure waste: a revoked key or an uninstalled
    // App burned three backoffs and then reported "rate limited", discarding the
    // response body that said what was actually wrong.
    if (res.status === 403 || res.status === 429) {
      const body = await res.text();
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      const throttled = res.status === 429
        || retryAfter > 0
        || res.headers.get('x-ratelimit-remaining') === '0'
        || /rate limit|abuse detection|try again later/i.test(body);

      if (!throttled) {
        throw new Error(`github ${res.status} (not rate limiting): ${body.slice(0, 300)}`);
      }
      if (attempt >= retries) {
        throw new Error(`rate limited after ${retries} retries: ${body.slice(0, 200)}`);
      }
      await sleep(Math.min(retryAfter * 1000 || 2 ** attempt * 2000, 10_000));
      continue;
    }

    let text;
    try {
      text = await res.text();
    } catch (e) {
      // The mutation was accepted; only the response body was lost.
      throw Object.assign(new Error(`github response unreadable: ${e.message}`),
        { status: res.status, uncertain: write && res.ok });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`github ${res.status}: ${text.slice(0, 300)}`),
        { status: res.status, uncertain: write && res.status >= 500 });
    }

    const json = JSON.parse(text);
    if (json.errors?.length) {
      const retryable = json.errors.some((e) => e.type === 'RATE_LIMITED');
      if (retryable && attempt < retries) { await sleep(2 ** attempt * 2000); continue; }
      throw new Error(`graphql: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json.data;
  }
}

/**
 * REST helper, used only by the write path.
 *
 * Errors carry `uncertain`, which the approve path needs. A 4xx is a refusal:
 * nothing was created, and saying so is safe. A dropped connection or a 5xx may
 * have created the comment and lost the response — reporting that as a plain
 * failure invites a retry that posts the same reply twice.
 */
export async function rest(env, method, path, body) {
  const writing = method !== 'GET' && method !== 'HEAD';
  let res;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `bearer ${await token(env)}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'triaghe',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw Object.assign(new Error(`github request failed: ${e.message}`), { uncertain: writing });
  }

  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(
      new Error(`github ${res.status}: ${text.slice(0, 300)}`),
      { status: res.status, uncertain: writing && res.status >= 500 },
    );
  }
  return text ? JSON.parse(text) : null;
}
