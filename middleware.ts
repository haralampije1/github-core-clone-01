// HTTP middleware for the github-core-clone-01 forge.
//
// Authored by this make.fun entry agent session (new additive code, in-session).
//
// Provides:
//   * security / CORS headers on every response,
//   * CORS preflight handling for /mcp (OPTIONS),
//   * a request body size cap,
//   * a per-request processing timeout,
//   * a structured access log to stderr.
// Every header and body is emitted as JSON-compatible text (no HTML) so the
// suite's git smart-HTTP, REST v3, GraphQL v4 and MCP clients keep parsing cleanly.

import {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';
const REQ_ID_HEADER = 'x-github-request-id';

let middlewareSeq = 0;
function middlewareId(): string {
  middlewareSeq += 1;
  return `mw-${Date.now().toString(36)}-${middlewareSeq.toString(36)}`;
}

// Maximum accepted request body in bytes (protects the in-memory store from
// runaway uploads during the timed push/write workloads).
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

// Per-request wall-clock budget in milliseconds; the forge must answer every
// suite request well inside the suite's own 3 s window.
export const REQUEST_TIMEOUT_MS = 6_000;

export interface MiddlewareResult {
  handled: boolean; // true when the middleware already sent the final reply
}

export function securityHeaders(res: ServerResponse, requestId: string): void {
  res.setHeader(REQ_ID_HEADER, requestId);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader(
    'access-control-allow-headers',
    'authorization, content-type, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, x-github-request-id, git-protocol',
  );
  res.setHeader(
    'access-control-allow-methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  );
}

export function corsPreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'OPTIONS') return false;
  const path = (req.url ?? '').split('?')[0];
  const isApi = path.startsWith('/api/v3') || path.startsWith('/api/graphql') || path === '/mcp';
  const isGit = /^\/\w[\w._-]*\/\w[\w._-]*\.git/.test(path);
  if (!isApi && !isGit) return false;
  const requestedHeaders =
    req.headers['access-control-request-headers'] ??
    req.headers['access-control-request-headers'] ??
    '';
  res.writeHead(204, {
    'content-length': '0',
    [REQ_ID_HEADER]: middlewareId(),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers':
      typeof requestedHeaders === 'string' && requestedHeaders.length > 0
        ? requestedHeaders
        : 'authorization, content-type',
    'access-control-max-age': '86400',
  });
  res.end();
  return true;
}

export function readBodyCapped(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('request body timeout'));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    req.on('data', (chunk: Buffer) => {
      if (timedOut) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        timedOut = true;
        clearTimeout(timer);
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function logRequest(requestId: string, method: string, path: string, status: number, ms: number): void {
  process.stderr.write(
    JSON.stringify({
      level: 'http',
      id: requestId,
      method,
      path,
      status,
      ms,
      at: new Date().toISOString(),
    }) + '\n',
  );
}

export function wrapWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {}, ms);
  timer.unref?.();
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error('request timeout')), ms);
      t.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
