// Declared API surface of the github-core-clone-01 forge.
//
// Authored by this make.fun entry agent session (new additive code).
//
// A single source of truth for every route the suite drives: git smart HTTP,
// REST v3, GraphQL v4 and MCP.  Handlers in app.ts/graphql.ts/mcp.ts own the
// implementation; this module declares the contract so the surface can be
// audited and tested independently of protocol framing.

export interface RouteDecl {
  surface: 'git' | 'rest' | 'graphql' | 'mcp';
  method: string;
  path: string;
  auth: boolean;
  description: string;
}

export const ROUTES: RouteDecl[] = [
  // --- git smart HTTP ---
  { surface: 'git', method: 'GET', path: '/{owner}/{repo}.git/info/refs?service=git-upload-pack', auth: true, description: 'upload-pack advertisement (v0 and v2)' },
  { surface: 'git', method: 'GET', path: '/{owner}/{repo}.git/info/refs?service=git-receive-pack', auth: true, description: 'receive-pack advertisement (v0)' },
  { surface: 'git', method: 'POST', path: '/{owner}/{repo}.git/git-upload-pack', auth: true, description: 'upload-pack pack transfer (ls-refs / fetch)' },
  { surface: 'git', method: 'POST', path: '/{owner}/{repo}.git/git-receive-pack', auth: true, description: 'receive-pack push with report-status' },
  // --- REST v3 ---
  { surface: 'rest', method: 'GET', path: '/api/v3', auth: true, description: 'root (current_user_url, rate_limit_url, x-oauth-scopes)' },
  { surface: 'rest', method: 'GET', path: '/api/v3/meta', auth: true, description: 'meta (installed_version)' },
  { surface: 'rest', method: 'GET', path: '/api/v3/user', auth: true, description: 'authenticated viewer' },
  { surface: 'rest', method: 'GET', path: '/api/v3/user/repos', auth: true, description: 'list repositories (paginated, Link: next)' },
  { surface: 'rest', method: 'POST', path: '/api/v3/user/repos', auth: true, description: 'create a repository (201)' },
  { surface: 'rest', method: 'GET', path: '/api/v3/repos/{owner}/{repo}', auth: true, description: 'get a repository; 404 JSON when missing' },
  { surface: 'rest', method: 'PATCH', path: '/api/v3/repos/{owner}/{repo}', auth: true, description: 'update repository description (200)' },
  { surface: 'rest', method: 'DELETE', path: '/api/v3/repos/{owner}/{repo}', auth: true, description: 'delete a repository (204)' },
  { surface: 'rest', method: 'GET', path: '/api/v3/repos/{owner}/{repo}/contents/{path}', auth: true, description: 'read file or directory contents (base64)' },
  { surface: 'rest', method: 'PUT', path: '/api/v3/repos/{owner}/{repo}/contents/{path}', auth: true, description: 'create or update file contents; 409 on stale sha' },
  { surface: 'rest', method: 'DELETE', path: '/api/v3/repos/{owner}/{repo}/contents/{path}', auth: true, description: 'delete file contents; 200 {commit:{sha}}' },
  { surface: 'rest', method: 'GET', path: '/api/v3/repos/{owner}/{repo}/branches', auth: true, description: 'list branches' },
  { surface: 'rest', method: 'POST', path: '/api/v3/repos/{owner}/{repo}/git/refs', auth: true, description: 'create a git ref (201)' },
  { surface: 'rest', method: 'GET', path: '/api/v3/repos/{owner}/{repo}/commits', auth: true, description: 'list commits from default branch' },
  { surface: 'rest', method: 'GET', path: '/api/v3/repos/{owner}/{repo}/labels', auth: true, description: 'list labels' },
  { surface: 'rest', method: 'POST', path: '/api/v3/repos/{owner}/{repo}/labels', auth: true, description: 'create a label (201; required before use on issues)' },
  { surface: 'rest', method: 'GET', path: '/api/v3/repos/{owner}/{repo}/issues', auth: true, description: 'list issues (?state filter)' },
  { surface: 'rest', method: 'POST', path: '/api/v3/repos/{owner}/{repo}/issues', auth: true, description: 'create an issue (201; 422 for unknown label)' },
  { surface: 'rest', method: 'GET', path: '/api/v3/repos/{owner}/{repo}/issues/{number}', auth: true, description: 'get an issue' },
  { surface: 'rest', method: 'PATCH', path: '/api/v3/repos/{owner}/{repo}/issues/{number}', auth: true, description: 'close an issue (state=closed)' },
  { surface: 'rest', method: 'GET', path: '/api/v3/repos/{owner}/{repo}/pulls', auth: true, description: 'list pull requests (?state filter)' },
  { surface: 'rest', method: 'POST', path: '/api/v3/repos/{owner}/{repo}/pulls', auth: true, description: 'create a pull request (201)' },
  { surface: 'rest', method: 'GET', path: '/api/v3/repos/{owner}/{repo}/pulls/{number}', auth: true, description: 'get a pull request' },
  { surface: 'rest', method: 'GET', path: '/api/v3/repos/{owner}/{repo}/pulls/{number}/files', auth: true, description: 'pull request changed files' },
  { surface: 'rest', method: 'PUT', path: '/api/v3/repos/{owner}/{repo}/pulls/{number}/merge', auth: true, description: 'squash-merge a pull request (200 {sha,merged:true})' },
  // --- GraphQL v4 ---
  { surface: 'graphql', method: 'POST', path: '/api/graphql', auth: true, description: 'query/multi-query; introspection describes Issue, PullRequest, Repository, SearchType' },
  // --- MCP streamable HTTP ---
  { surface: 'mcp', method: 'POST', path: '/mcp', auth: true, description: 'JSON-RPC 2.0 (server/discover, initialize, tools/list, tools/call)' },
  { surface: 'mcp', method: 'OPTIONS', path: '/mcp', auth: true, description: 'CORS preflight (204)' },
  { surface: 'mcp', method: 'GET', path: '/healthz', auth: false, description: 'forge health (ok, store size, uptime)' },
] as const;

export function routeCount(): number {
  return ROUTES.length;
}

export function routesBySurface(surface: RouteDecl['surface']): RouteDecl[] {
  return ROUTES.filter((r) => r.surface === surface);
}

export function authRequiredCount(): number {
  return ROUTES.filter((r) => r.auth).length;
}
