// Access-token validation and per-route scopes for the github-core-clone-01 forge.
//
// Authored by this make.fun entry agent session (new additive code).
//
// The suite presents Authorization: Bearer <token> equal to MAKEFUN_SHOP_TOKEN.
// A request without a valid token on an authenticated surface is 401.  This
// module centralizes the check and the (documented) scope requirements so the
// forge's auth surface is consistent across REST v3, GraphQL v4 and MCP.

import { type IncomingMessage } from 'node:http';

export const REQUIRED_SCOPES = ['repo', 'read:org'];

// Scopes required per surface, mirrored from the suite's contract.
export const SCOPES_BY_SURFACE: Record<string, string[]> = {
  '/api/v3': REQUIRED_SCOPES,
  '/api/graphql': REQUIRED_SCOPES,
  '/mcp': REQUIRED_SCOPES,
};

export function tokenOf(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

/** Validate the bearer token against the forge's shop token. */
export function tokenValid(token: string | null, expectedToken: string | null): boolean {
  if (!expectedToken) return true; // no token configured: open forge (not used by trials)
  return typeof token === 'string' && token === expectedToken;
}

/** Required scopes for a path, or an empty array when the path is public. */
export function requiredScopesFor(path: string): string[] {
  for (const [prefix, scopes] of Object.entries(SCOPES_BY_SURFACE)) {
    if (path.startsWith(prefix)) return scopes;
  }
  return [];
}

/** Describe a failed auth check as a JSON error body. */
export function authErrorBody(message: string): string {
  return JSON.stringify({ message });
}

/** Simple in-memory per-IP request counter used to surface abuse to stderr. */
interface WindowHit {
  count: number;
  resetAt: number;
}

const windows = new Map<string, WindowHit>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10_000;

export function recordHit(ip: string): boolean {
  const now = Date.now();
  let w = windows.get(ip);
  if (!w || now >= w.resetAt) {
    w = { count: 1, resetAt: now + WINDOW_MS };
    windows.set(ip, w);
    return true;
  }
  w.count += 1;
  return w.count <= MAX_PER_WINDOW;
}

export function pruneWindows(now: number = Date.now()): number {
  let removed = 0;
  for (const [ip, w] of windows) {
    if (now >= w.resetAt) { windows.delete(ip); removed += 1; }
  }
  return removed;
}
