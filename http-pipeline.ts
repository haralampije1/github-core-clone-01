// HTTP request pipeline for the github-core-clone-01 forge.
//
// Authored by this make.fun entry agent session (new additive code).
//
// A small middleware chain that every inbound request crosses before it reaches
// a surface handler:
//   1. security headers (x-content-type-options, x-frame-options, CORS allow-list),
//   2. CORS preflight short-circuit (OPTIONS),
//   3. bearer-token validation against MAKEFUN_SHOP_TOKEN,
//   4. per-IP request window (abuse surface, logged to stderr),
//   5. timed dispatch to the surface handler with a per-request deadline,
//   6. metrics recording and structured access logging.
// Surfaces (git smart-HTTP, REST v3, GraphQL v4, MCP) keep owning their logic;
// this module only wraps the dispatch consistently so the forge behaves the same
// whichever client (the suite, gh, github-mcp-server) drives it.

import {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createHash } from 'node:crypto';
import { tokenValid, requiredScopesFor, authErrorBody, recordHit, pruneWindows } from './auth.ts';
import { securityHeaders, corsPreflight, logRequest, MAX_BODY_BYTES } from './middleware.ts';
import { metrics } from './metrics.ts';

export interface SurfaceHandler {
  (req: IncomingMessage, res: ServerResponse, token: string): Promise<void> | void;
}

interface PipelineOptions {
  expectedToken: string | null;
  clientIp: string;
  requestId: string;
}

const pipelineSeq = new Map<string, number>();

function pipelineIdFor(requestId: string): string {
  let n = (pipelineSeq.get(requestId) ?? 0) + 1;
  pipelineSeq.set(requestId, n);
  return `${requestId}-p${n}`;
}

const healthyThresholdMs = 3_000;

export function runPipeline(
  req: IncomingMessage,
  res: ServerResponse,
  handler: SurfaceHandler,
  options: PipelineOptions,
): { handled: boolean; reason?: string } {
  const { expectedToken, clientIp, requestId } = options;
  const id = pipelineIdFor(requestId);
  const started = Date.now();
  const path = (req.url ?? '').split('?')[0];
  const method = req.method ?? 'GET';

  // 1. security headers on every reply.
  securityHeaders(res, id);

  // 2. CORS preflight short-circuit before auth (browsers send OPTIONS first).
  if (method === 'OPTIONS' && corsPreflight(req, res)) {
    metrics.record(method, path, 204, Date.now() - started);
    logRequest(id, method, path, 204, Date.now() - started);
    return { handled: true, reason: 'cors preflight' };
  }

  // 3. bearer-token validation.
  const token = (req.headers['authorization'] as string | undefined) ?? '';
  const bearer = token.startsWith('Bearer ') ? token.slice(7) : '';
  if (!tokenValid(bearer || null, expectedToken)) {
    metrics.record(method, path, 401, Date.now() - started);
    const body = authErrorBody('Unauthorized');
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      [pipelineHeader()]: id,
    });
    res.end(body);
    logRequest(id, method, path, 401, Date.now() - started);
    return { handled: true, reason: 'unauthorized' };
  }

  // 4. per-IP request window; log surface hits for observability.
  if (!recordHit(clientIp ?? 'unknown')) {
    metrics.record(method, path, 429, Date.now() - started);
    const body = authErrorBody('too many requests');
    res.writeHead(429, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      [pipelineHeader()]: id,
    });
    res.end(body);
    logRequest(id, method, path, 429, Date.now() - started);
    return { handled: true, reason: 'rate limited' };
  }

  // 5. timed dispatch to the surface handler.  A slow handler is not allowed to
  // stall the forge past the suite's per-request deadline.
  let settled = false;
  const deadline = started + healthyThresholdMs;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try {
      if (!res.headersSent) {
        const body = authErrorBody('request timeout');
        res.writeHead(504, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
          [pipelineHeader()]: id,
        });
        res.end(body);
      }
    } catch {}
    metrics.record(method, path, 504, Date.now() - started);
    logRequest(id, method, path, 504, Date.now() - started);
  }, healthyThresholdMs);
  timer.unref?.();

  let result: void | Promise<void>;
  try { result = handler(req, res, bearer); } catch (err) {
    clearTimeout(timer);
    settled = true;
    const message = err instanceof Error ? err.message : String(err);
    const body = authErrorBody(`internal server error: ${message.replace(/"/g, '\\"')}`);
    res.writeHead(500, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      [pipelineHeader()]: id,
    });
    res.end(body);
    metrics.record(method, path, 500, Date.now() - started);
    logRequest(id, method, path, 500, Date.now() - started);
    return { handled: true, reason: 'handler threw' };
  }

  if (result && typeof (result as Promise<void>).then === 'function') {
    (result as Promise<void>).then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      metrics.record(method, path, 200, Date.now() - started);
      logRequest(id, method, path, 200, Date.now() - started);
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      const body = authErrorBody(`handler failed: ${message.replace(/"/g, '\\"')}`);
      try {
        if (!res.headersSent) {
          res.writeHead(500, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(Buffer.byteLength(body)),
            [pipelineHeader()]: id,
          });
          res.end(body);
        }
      } catch {}
      metrics.record(method, path, 500, Date.now() - started);
      logRequest(id, method, path, 500, Date.now() - started);
    });
    return { handled: false };
  }

  settled = true;
  clearTimeout(timer);
  metrics.record(method, path, 200, Date.now() - started);
  logRequest(id, method, path, 200, Date.now() - started);
  return { handled: false, reason: 'sync handler' };
}

function pipelineHeader(): string {
  return 'x-forge-pipeline-id';
}

/** Deterministic opaque client fingerprint from connection metadata (no PII). */
export function clientFingerprint(headers: IncomingMessage['headers']): string {
  const parts = [
    String(headers['x-forwarded-for'] ?? headers['x-real-ip'] ?? ''),
    String(headers['user-agent'] ?? ''),
    String(headers['accept'] ?? ''),
  ];
  return createHash('sha1').update(parts.join('\0')).digest('hex');
}

/** Periodically prune expired rate-limit windows so memory stays bounded. */
export function startWindowPruning(intervalMs = WINDOW_MS): ReturnType<typeof setInterval> {
  return setInterval(() => { pruneWindows(); }, intervalMs);
}
