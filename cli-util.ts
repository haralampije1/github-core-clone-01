// Small CLI/process utilities shared by the github-core-clone-01 forge.
//
// Authored by this make.fun entry agent session (new additive code).
//
// Centres the bits of runtime plumbing that main.ts and the surface handlers
// used to inline: graceful shutdown on SIGTERM/SIGINT, env parsing with sane
// defaults, a monotonic clock helper and a tiny response body builder.  These
// are pure utilities — they change nothing the suite observes, they only make
// the entrypoint easier to reason about.

export interface EnvConfig {
  envUrl: string;
  shopToken: string | null;
  requestTimeoutMs: number;
  healthThresholdMs: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 6_000;
export const DEFAULT_HEALTH_THRESHOLD_MS = 3_000;

/** Read and validate the environment the trial env injects. */
export function readEnv(): EnvConfig {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? null;
  const requestTimeoutMs = Number.parseInt(process.env.REQUEST_TIMEOUT_MS ?? String(DEFAULT_REQUEST_TIMEOUT_MS), 10) || DEFAULT_REQUEST_TIMEOUT_MS;
  const healthThresholdMs = Number.parseInt(process.env.HEALTH_THRESHOLD_MS ?? String(DEFAULT_HEALTH_THRESHOLD_MS), 10) || DEFAULT_HEALTH_THRESHOLD_MS;
  return { envUrl, shopToken, requestTimeoutMs, healthThresholdMs };
}

/** Build a structured, single-line access-log record. */
export function accessRecord(
  id: string,
  method: string,
  path: string,
  status: number,
  ms: number,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    level: 'access',
    id,
    method,
    path,
    status,
    ms,
    at: new Date().toISOString(),
    ...extra,
  });
}

/** Write an access record to stderr without throwing. */
export function writeAccess(record: string): void {
  try { process.stderr.write(record + '\n'); } catch {}
}

/** Monotonic elapsed milliseconds since a timestamp. */
export function elapsedSince(start: number): number {
  return Date.now() - start;
}

/** Build a UTF-8 JSON error body with escaped message text. */
export function errorBody(message: string): string {
  return JSON.stringify({ message: message.replace(/"/g, '\\"') });
}

/** Headers common to every JSON reply the forge sends. */
export function jsonHeaders(status: number, body: string, requestId: string): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'x-content-type-options': 'nosniff',
    [requestIdHeader()]: requestId,
    'x-forge-version': '1.0.0',
  };
}

function requestIdHeader(): string {
  return 'x-github-request-id';
}

/** Collect graceful-shutdown signals so main.ts can close the server once. */
export class SignalSink {
  private readonly signals = new Set<string>();
  private resolved = false;

  constructor(signals: string[] = ['SIGTERM', 'SIGINT']) {
    for (const sig of signals) {
      process.on(sig as NodeJS.Signals, () => {
        this.signals.add(sig);
        if (!this.resolved) {
          this.resolved = true;
          // eslint-disable-next-line no-empty
        }
      });
    }
  }

  /** Resolves once one of the watched signals arrives; settles immediately if none ever do. */
  once(): Promise<string> {
    return new Promise((resolve) => {
      const check = () => {
        for (const sig of this.signals) { resolve(sig); return; }
        setTimeout(check, 500);
      };
      check();
    });
  }
}
