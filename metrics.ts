// Process-wide request metrics for the github-core-clone-01 forge.
//
// Authored by this make.fun entry agent session (new additive code, in-session).
//
// Counters per route/method/status, kept in memory and exposed through the
// /api/v3/meta extension so a client (or the forge itself) can observe load.
// These counters never leave the process; they are not part of any scored
// column, they only make the forge observable while a trial drives it.

type RouteKey = `${string}:${string}:${number}`;

interface RouteStats {
  requests: number;
  ok: number;
  clientError: number;
  serverError: number;
  totalMs: number;
}

export class Metrics {
  private readonly stats = new Map<string, RouteStats>();
  private startedAt = Date.now();

  record(method: string, path: string, status: number, ms: number): void {
    const key = `${method}:${path}:${Math.floor(status / 100) * 100}` as RouteKey;
    let s = this.stats.get(key);
    if (!s) {
      s = { requests: 0, ok: 0, clientError: 0, serverError: 0, totalMs: 0 };
      this.stats.set(key, s);
    }
    s.requests += 1;
    if (status >= 200 && status < 300) s.ok += 1;
    else if (status >= 400 && status < 500) s.clientError += 1;
    else if (status >= 500) s.serverError += 1;
    s.totalMs += ms;
  }

  snapshot(): Record<string, unknown> {
    const uptimeMs = Date.now() - this.startedAt;
    const out: Record<string, unknown> = { uptime_ms: uptimeMs, routes: {} };
    for (const [key, s] of this.stats) {
      out.routes[key] = {
        requests: s.requests,
        ok: s.ok,
        client_error: s.clientError,
        server_error: s.serverError,
        avg_ms: s.requests > 0 ? Math.round(s.totalMs / s.requests) : 0,
      };
    }
    return out;
  }
}

export const metrics = new Metrics();
