import { requireThat, actorId } from './store.mjs';

// Browser identity only. No ingestion App credential or token argument exists.
// The identity token lives only within one exchange and is revoked afterwards.
export function githubOAuthProvider({ clientId, clientSecret, fetcher = fetch }) {
  requireThat(typeof clientId === 'string' && /^[A-Za-z0-9_.-]+$/.test(clientId), 500, 'OAuth client ID required');
  requireThat(typeof clientSecret === 'string' && clientSecret.length >= 16, 500, 'Separate OAuth client secret required');
  async function request(url, options) {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    requireThat(response.ok, 502, 'Identity provider unavailable');
    const chunks = []; let length = 0;
    if (response.body) for await (const chunk of response.body) {
      length += chunk.byteLength;
      requireThat(length <= 65_536, 502, 'Identity response too large');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }
  return {
    authorizationURL({ state, challenge, redirectURI }) {
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectURI, scope: '', state,
        code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'false' }).toString();
      return url.href;
    },
    async exchange({ code, verifier, redirectURI }) {
      const token = await request('https://github.com/login/oauth/access_token', { method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirectURI }) });
      requireThat(typeof token.access_token === 'string', 502, 'Identity exchange failed');
      try {
        requireThat(!token.scope, 502, 'Unexpected OAuth scopes');
        const user = await request('https://api.github.com/user', { headers: {
          accept: 'application/vnd.github+json', authorization: `Bearer ${token.access_token}`, 'x-github-api-version': '2022-11-28' } });
        requireThat(Number.isSafeInteger(user.id) && user.id > 0, 502, 'Stable identity unavailable');
        return { actorId: actorId(String(user.id)) };
      } finally {
        await request(`https://api.github.com/applications/${clientId}/token`, { method: 'DELETE', headers: {
          accept: 'application/vnd.github+json', 'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
          body: JSON.stringify({ access_token: token.access_token }) });
      }
    }
  };
}
