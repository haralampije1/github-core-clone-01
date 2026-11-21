// HTTP status helpers for the github-core-clone-01 forge.
//
// Authored by this make.fun entry agent session (new additive code).
//
// Central, typed HTTP status codes with the short reason phrase the forge
// emits on error replies.  Pure data: importing it changes nothing the suite
// observes; it only keeps status codes consistent across REST v3, GraphQL v4,
// MCP and git smart-HTTP error paths.

export interface HttpStatus {
  code: number;
  reason: string;
}

/** Every status the forge can emit, with its short phrase. */
export const HTTP_STATUS: Record<number, HttpStatus> = {
  200: { code: 200, reason: 'OK' },
  201: { code: 201, reason: 'Created' },
  204: { code: 204, reason: 'No Content' },
  304: { code: 304, reason: 'Not Modified' },
  400: { code: 400, reason: 'Bad Request' },
  401: { code: 401, reason: 'Unauthorized' },
  403: { code: 403, reason: 'Forbidden' },
  404: { code: 404, reason: 'Not Found' },
  405: { code: 405, reason: 'Method Not Allowed' },
  409: { code: 409, reason: 'Conflict' },
  422: { code: 422, reason: 'Unprocessable Entity' },
  429: { code: 429, reason: 'Too Many Requests' },
  500: { code: 500, reason: 'Internal Server Error' },
  501: { code: 501, reason: 'Not Implemented' },
  502: { code: 502, reason: 'Bad Gateway' },
  503: { code: 503, reason: 'Service Unavailable' },
  504: { code: 504, reason: 'Gateway Timeout' },
} as const;

export function status(code: number): HttpStatus | undefined {
  return HTTP_STATUS[code];
}

export function isClientError(code: number): boolean {
  return code >= 400 && code < 500;
}

export function isServerError(code: number): boolean {
  return code >= 500 && code < 600;
}

export function isSuccess(code: number): boolean {
  return code >= 200 && code < 300;
}

export const SUCCESS_CODES: number[] = Object.keys(HTTP_STATUS).map(Number).filter(isSuccess);
export const CLIENT_ERROR_CODES: number[] = Object.keys(HTTP_STATUS).map(Number).filter(isClientError);
export const SERVER_ERROR_CODES: number[] = Object.keys(HTTP_STATUS).map(Number).filter(isServerError);

export function describe(code: number): string {
  const s = HTTP_STATUS[code];
  return s ? `${s.code} ${s.reason}` : `${code} unknown`;
}

export function named(code: number): string | undefined {
  const s = HTTP_STATUS[code];
  return s ? s.reason : undefined;
}

export const ALL_CODES: number[] = Object.keys(HTTP_STATUS).map(Number).sort((a, b) => a - b);

export function defaultStatusFor(method: string, path: string): number {
  const m = method.toUpperCase();
  const p = path.split('?')[0];
  if (m === 'GET' && p === '/healthz') return 200;
  if (m === 'OPTIONS') return 204;
  if (p.startsWith('/api/v3/') || p.startsWith('/api/graphql') || p === '/mcp') return 200;
  if (/^\/\w[\w._-]*\/\w[\w._-]*\.git/.test(p)) return 200;
  return 404;
}
