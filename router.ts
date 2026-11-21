// Route registration and matching helpers for the github-core-clone-01 forge.
//
// Authored by this make.fun entry agent session (new additive code, in-session).
//
// The forge serves four surfaces from one process: git smart HTTP, REST v3,
// GraphQL v4 and MCP.  This module keeps a small, explicit route table so the
// dispatch logic in app.ts stays readable and every surface the suite drives
// is declared in one place.  It is additive: it never replaces the handlers
// in app.ts, graphql.ts or mcp.ts, it only names the routes they own.

import { type IncomingMessage } from 'node:http';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | '*';

export interface Route {
  method: Method;
  // A RegExp source (without anchors) matched against the URL pathname.
  pattern: string;
  handler: string; // symbolic name of the surface that owns the route
  description: string;
}

export interface MatchedRoute {
  route: Route;
  params: Record<string, string>;
}

const routes: Route[] = [
  // Git smart HTTP
  { method: 'GET', pattern: '/([^/]+)/([^/]+)\\.git/info/refs', handler: 'git', description: 'smart-HTTP advertisement (upload-pack / receive-pack)' },
  { method: 'POST', pattern: '/([^/]+)/([^/]+)\\.git/git-(upload-pack|receive-pack)', handler: 'git', description: 'smart-HTTP pack transfer' },
  { method: '*', pattern: '/([^/]+)/([^/]+)\\.git.*', handler: 'git', description: 'any other git smart-HTTP path' },
  // REST v3
  { method: 'GET', pattern: '/api/v3/?$', handler: 'rest', description: 'REST root' },
  { method: 'GET', pattern: '/api/v3/meta', handler: 'rest', description: 'REST meta / version' },
  { method: 'GET', pattern: '/api/v3/user', handler: 'rest', description: 'authenticated user' },
  { method: 'GET', pattern: '/api/v3/user/repos', handler: 'rest', description: 'list repositories' },
  { method: 'POST', pattern: '/api/v3/user/repos', handler: 'rest', description: 'create a repository' },
  { method: 'GET', pattern: '/api/v3/repos/([^/]+)/([^/]+)', handler: 'rest', description: 'get a repository' },
  { method: 'PATCH', pattern: '/api/v3/repos/([^/]+)/([^/]+)', handler: 'rest', description: 'update a repository' },
  { method: 'DELETE', pattern: '/api/v3/repos/([^/]+)/([^/]+)', handler: 'rest', description: 'delete a repository' },
  { method: 'PUT', pattern: '/api/v3/repos/([^/]+)/([^/]+)/contents/.+', handler: 'rest', description: 'create or update file contents' },
  { method: 'DELETE', pattern: '/api/v3/repos/([^/]+)/([^/]+)/contents/.+', handler: 'rest', description: 'delete file contents' },
  { method: 'GET', pattern: '/api/v3/repos/([^/]+)/([^/]+)/contents/.+', handler: 'rest', description: 'read file contents' },
  { method: 'GET', pattern: '/api/v3/repos/([^/]+)/([^/]+)/branches', handler: 'rest', description: 'list branches' },
  { method: 'POST', pattern: '/api/v3/repos/([^/]+)/([^/]+)/git/refs', handler: 'rest', description: 'create a git ref' },
  { method: 'GET', pattern: '/api/v3/repos/([^/]+)/([^/]+)/commits', handler: 'rest', description: 'list commits' },
  { method: 'GET', pattern: '/api/v3/repos/([^/]+)/([^/]+)/labels', handler: 'rest', description: 'list labels' },
  { method: 'POST', pattern: '/api/v3/repos/([^/]+)/([^/]+)/labels', handler: 'rest', description: 'create a label' },
  { method: 'GET', pattern: '/api/v3/repos/([^/]+)/([^/]+)/issues', handler: 'rest', description: 'list issues' },
  { method: 'POST', pattern: '/api/v3/repos/([^/]+)/([^/]+)/issues', handler: 'rest', description: 'create an issue' },
  { method: 'GET', pattern: '/api/v3/repos/([^/]+)/([^/]+)/issues/([0-9]+)', handler: 'rest', description: 'get an issue' },
  { method: 'PATCH', pattern: '/api/v3/repos/([^/]+)/([^/]+)/issues/([0-9]+)', handler: 'rest', description: 'update an issue' },
  { method: 'GET', pattern: '/api/v3/repos/([^/]+)/([^/]+)/pulls', handler: 'rest', description: 'list pull requests' },
  { method: 'POST', pattern: '/api/v3/repos/([^/]+)/([^/]+)/pulls', handler: 'rest', description: 'create a pull request' },
  { method: 'GET', pattern: '/api/v3/repos/([^/]+)/([^/]+)/pulls/([0-9]+)', handler: 'rest', description: 'get a pull request' },
  { method: 'PUT', pattern: '/api/v3/repos/([^/]+)/([^/]+)/pulls/([0-9]+)/merge', handler: 'rest', description: 'merge a pull request' },
  // GraphQL v4
  { method: 'POST', pattern: '/api/graphql', handler: 'graphql', description: 'GraphQL query / mutation' },
  // MCP streamable HTTP
  { method: 'POST', pattern: '/mcp', handler: 'mcp', description: 'MCP JSON-RPC request' },
  { method: 'OPTIONS', pattern: '/mcp', handler: 'mcp', description: 'MCP CORS preflight' },
  { method: 'GET', pattern: '/healthz', handler: 'forge', description: 'forge health check' },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turn a simple path string (with /:param style segments) into a RegExp source. */
export function pathToPattern(path: string): string {
  let source = '';
  let i = 0;
  while (i < path.length) {
    if (path[i] === ':') {
      const end = path.indexOf('/', i + 1);
      const name = end < 0 ? path.slice(i + 1) : path.slice(i + 1, end);
      source += '([^/]+)';
      i = end < 0 ? path.length : end;
    } else {
      source += escapeRegExp(path[i]);
      i += 1;
    }
  }
  return source;
}

export function registerRoute(method: Method, path: string, handler: string, description: string): void {
  routes.push({ method, pattern: pathToPattern(path), handler, description });
}

export function listRoutes(): Route[] {
  return routes.slice();
}

/** Match an incoming request against the route table. */
export function matchRoute(method: string, url: string): MatchedRoute | null {
  const pathname = url.split('?')[0];
  const m = method.toUpperCase() as Method;
  for (const route of routes) {
    if (route.method !== '*' && route.method !== m) continue;
    const re = new RegExp(`^${route.pattern}$`);
    const match = pathname.match(re);
    if (!match) continue;
    const paramNames: string[] = [];
    const source = route.pattern;
    let scan = 0;
    while (scan < source.length) {
      if (source[scan] === '(') {
        let depth = 1, j = scan + 1, name = '';
        while (j < source.length && depth > 0) {
          if (source[j] === '(') depth += 1;
          else if (source[j] === ')') depth -= 1;
          else if (depth === 1 && source[j] !== '\\' && /[A-Za-z_]/.test(source[j])) name += source[j];
          j += 1;
        }
        if (name.length > 0) paramNames.push(name);
        scan = j;
      } else {
        scan += 1;
      }
    }
    const params: Record<string, string> = {};
    paramNames.forEach((name, index) => {
      if (match[index + 1] !== undefined) params[name] = match[index + 1];
    });
    return { route, params };
  }
  return null;
}

export function surfaceOf(method: string, url: string): string | null {
  const matched = matchRoute(method, url);
  return matched ? matched.route.handler : null;
}
