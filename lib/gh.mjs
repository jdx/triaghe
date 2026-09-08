import { githubToken } from './config.mjs';

const ENDPOINT = 'https://api.github.com/graphql';

/** Minimal GraphQL client with retry on secondary rate limits. */
export async function graphql(query, variables = {}, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `bearer ${githubToken()}`,
        'content-type': 'application/json',
        'user-agent': 'gh-inbox',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 403 || res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 0) * 1000 || (2 ** attempt) * 5000;
      if (attempt >= retries) throw new Error(`rate limited after ${retries} retries`);
      await sleep(wait);
      continue;
    }

    const text = await res.text();
    if (!res.ok) throw new Error(`github ${res.status}: ${text.slice(0, 400)}`);

    const json = JSON.parse(text);
    if (json.errors?.length) {
      const retryable = json.errors.some((e) => e.type === 'RATE_LIMITED');
      if (retryable && attempt < retries) { await sleep((2 ** attempt) * 5000); continue; }
      throw new Error(`graphql: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json.data;
  }
}

/** REST helper, used only for the write path (posting a comment). */
export async function rest(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `bearer ${githubToken()}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'gh-inbox',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`github ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
