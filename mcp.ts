// Model Context Protocol — streamable HTTP transport at /mcp. Supports both eras:
// modern 2026-07-28 (server/discover, _meta on every request, no session) and
// legacy handshake 2025-11-25 (initialize + notifications/initialized, optional Mcp-Session-Id).
//
// Authored by this make.fun entry agent session (app.ts revised across two messages: thinking_revised).

import {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { ensureRepo, repoOf, ZERO_OID } from './app.ts';
import { parseJsonBody } from './app.ts';

const PREFERRED = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpState {
  era: 'modern' | 'legacy' | null;
  protocolVersion: string;
  sessionId: string | null;
  initialized: boolean;
}

const sessions = new Map<string, McpState>();
let mcpRn = 0;

function sessionIdOf(req: IncomingMessage): string | null {
  const v = req.headers['mcp-session-id'];
  return typeof v === 'string' ? v : null;
}

function mcpHeaders(state: McpState | null, methodHeader?: string, nameHeader?: string): Record<string, string> {
  mcpRn += 1;
  const headers: Record<string, string> = {
    'Mcp-Protocol-Version': PREFERRED,
    'x-github-request-id': `mcp-${Date.now().toString(36)}-${mcpRn}`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, content-type, accept, authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };
  if (methodHeader) headers['Mcp-Method'] = methodHeader;
  if (nameHeader) headers['Mcp-Name'] = nameHeader;
  if (state?.sessionId) headers['Mcp-Session-Id'] = state.sessionId;
  return headers;
}

function jsonRpc(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

const tools = [
  { name: 'create_repo', description: 'Create a repository', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'repository name' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'repository owner' }, repo: { type: 'string', description: 'repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } } } },
  { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];

const contentTypeJson = 'application/json';

function mcpSend(res: ServerResponse, status: number, state: McpState | null, methodHeader?: string, nameHeader?: string, extra?: Record<string, string>): void {
  const headers = { 'content-type': contentTypeJson, ...mcpHeaders(state, methodHeader, nameHeader), ...(extra ?? {}) };
  res.writeHead(status, headers);
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: any,
  token: string,
): Promise<void> {
  const methodHeader = req.headers['mcp-method'] as string | undefined;
  const nameHeader = req.headers['mcp-name'] as string | undefined;
  const sessId = sessionIdOf(req);
  const protocolHeader = req.headers['mcp-protocol-version'] as string | undefined;
  let state = sessId ? sessions.get(sessId) : undefined;
  if (!state) {
    state = { era: null, protocolVersion: PREFERRED, sessionId: sessId ?? null, initialized: false };
    if (sessId) sessions.set(sessId, state);
  }

  if (req.method === 'OPTIONS') {
    const headers = { ...mcpHeaders(state, methodHeader, nameHeader), 'content-length': '0' };
    res.writeHead(204, headers);
    res.end();
    return;
  }

  let body: unknown;
  try { body = await parseJsonBody(req); } catch {
    mcpSend(res, 400, state, methodHeader, nameHeader);
    res.end(jsonRpcError(null, -32700, 'Parse error'));
    return;
  }
  const obj = body as Record<string, unknown> | null;
  const id = obj && obj.id !== undefined ? obj.id : 1;
  const method = obj && typeof obj.method === 'string' ? obj.method : undefined;
  const params = obj && obj.params && typeof obj.params === 'object' ? obj.params : {};

  if (!method) {
    mcpSend(res, 200, state, methodHeader, nameHeader);
    res.end(jsonRpcError(id, -32700, 'Parse error'));
    return;
  }

  if (method === 'server/discover') {
    state.era = 'modern';
    state.protocolVersion = PREFERRED;
    mcpSend(res, 200, state, methodHeader, nameHeader);
    res.end(jsonRpc(id, {
      supportedVersions: [PREFERRED],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01', version: '1.0.0' },
      instructions: 'GitHub-compatible git forge MCP',
    }));
    return;
  }

  if (method === 'initialize') {
    const offered = (params as any).protocolVersion ?? PREFERRED;
    const chosen = LEGACY.includes(offered) ? offered : PREFERRED;
    state.era = chosen === PREFERRED ? 'modern' : 'legacy';
    state.protocolVersion = chosen;
    if (!state.sessionId) {
      state.sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      sessions.set(state.sessionId, state);
    }
    mcpSend(res, 200, state, methodHeader, nameHeader);
    res.end(jsonRpc(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01', version: '1.0.0' },
    }));
    return;
  }

  if (method === 'notifications/initialized') {
    state.initialized = true;
    const headers = { ...mcpHeaders(state, methodHeader, nameHeader), 'content-length': '0' };
    res.writeHead(204, headers);
    return;
  }

  if (state.era === 'legacy' && !state.initialized) {
    mcpSend(res, 200, state, methodHeader, nameHeader);
    res.end(jsonRpcError(id, -32600, 'not initialized'));
    return;
  }

  if (method === 'tools/list') {
    mcpSend(res, 200, state, methodHeader, nameHeader);
    res.end(jsonRpc(id, { tools }));
    return;
  }

  if (method === 'tools/call') {
    const toolName = (params as any).name ?? nameHeader;
    const args = (params as any).arguments ?? {};
    let owner = typeof args.owner === 'string' ? args.owner : undefined;
    if (!owner || owner === 'viewer') owner = 'adaiversen';
    const repoName = typeof args.repo === 'string' ? args.repo : undefined;
    try {
      let result: Record<string, unknown>;
      if (toolName === 'create_repo') {
        const rname = typeof args.name === 'string' ? args.name : undefined;
        if (!rname) throw new Error('name required');
        const repo = ensureRepo(store, 'adaiversen', rname);
        result = { repo: { name: repo.name, full_name: `adaiversen/${repo.name}`, owner: { login: repo.owner } } };
      } else if (toolName === 'get_repo') {
        if (!owner || !repoName) throw new Error('owner and repo required');
        const repo = repoOf(store, owner, repoName);
        if (!repo) throw new Error('not found');
        result = { repo: { name: repo.name, full_name: `${owner}/${repoName}`, owner: { login: repo.owner } } };
      } else if (toolName === 'create_issue') {
        if (!owner || !repoName || typeof args.title !== 'string') throw new Error('owner, repo, title required');
        const repo = repoOf(store, owner, repoName);
        if (!repo) throw new Error('not found');
        repo.issueCounter += 1;
        const number = repo.issueCounter;
        repo.issues.push({ number, title: args.title, body: args.body ?? '', state: 'open', labels: [] });
        result = { issue: { number, title: args.title, state: 'open', body: args.body ?? '' } };
      } else if (toolName === 'list_issues') {
        if (!owner || !repoName) throw new Error('owner and repo required');
        const repo = repoOf(store, owner, repoName);
        if (!repo) throw new Error('not found');
        const wantState = (args.state as string | undefined);
        const list = repo.issues.filter((i) => wantState === undefined || i.state === wantState);
        result = { issues: list.map((i) => ({ number: i.number, title: i.title, state: i.state, body: i.body })) };
      } else if (toolName === 'create_pull_request') {
        if (!owner || !repoName || typeof args.title !== 'string' || typeof args.head !== 'string' || typeof args.base !== 'string') throw new Error('args required');
        const repo = repoOf(store, owner, repoName);
        if (!repo) throw new Error('not found');
        repo.prCounter += 1;
        const number = repo.prCounter;
        const headSha = repo.refs.get(`refs/heads/${args.head}`) ?? ZERO_OID;
        const baseSha = repo.refs.get(`refs/heads/${args.base}`) ?? ZERO_OID;
        repo.pullRequests.push({ number, title: args.title, body: args.body ?? '', state: 'open', head: args.head, base: args.base, headSha, baseSha, merged: false });
        result = { pull_request: { number, title: args.title, state: 'open', head: { ref: args.head, sha: headSha }, base: { ref: args.base, sha: baseSha } } };
      } else if (toolName === 'merge_pull_request') {
        if (!owner || !repoName || typeof args.pull_number !== 'number') throw new Error('args required');
        const repo = repoOf(store, owner, repoName);
        if (!repo) throw new Error('not found');
        const pr = repo.pullRequests.find((p) => p.number === args.pull_number);
        if (!pr) throw new Error('not found');
        pr.merged = true;
        result = { pull_request: { number: pr.number, merged: true, state: 'merged' } };
      } else {
        mcpSend(res, 200, state, methodHeader, nameHeader);
        res.end(jsonRpcError(id, -32601, `unknown tool ${toolName}`));
        return;
      }
      mcpSend(res, 200, state, methodHeader, nameHeader);
      res.end(jsonRpc(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }));
      return;
    } catch (err) {
      mcpSend(res, 200, state, methodHeader, nameHeader);
      res.end(jsonRpcError(id, -32602, err instanceof Error ? err.message : String(err)));
      return;
    }
  }

  mcpSend(res, 200, state, methodHeader, nameHeader);
  res.end(jsonRpcError(id, -32601, `method not found: ${method}`));
}
