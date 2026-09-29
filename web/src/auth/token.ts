/**
 * Access-token plumbing shared by the REST client, the SSE chat client and the live WebSocket.
 *
 * Local mode: no provider is registered, so requests go out without an Authorization header.
 * Cloud (Entra) mode: the MSAL layer registers a provider that calls acquireTokenSilent().
 */
export type TokenProvider = () => Promise<string | null>;

let provider: TokenProvider | null = null;

/** Register (or clear) the function used to obtain a bearer token for /api requests. */
export function setTokenProvider(p: TokenProvider | null): void {
  provider = p;
}

/** Current bearer token, or null when auth is not required (local mode) or unavailable. */
export async function getAccessToken(): Promise<string | null> {
  if (!provider) return null;
  try {
    return await provider();
  } catch {
    return null;
  }
}

/** `fetch` wrapper that attaches `Authorization: Bearer <token>` when a provider is registered. */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  if (!token) return fetch(input, init);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
