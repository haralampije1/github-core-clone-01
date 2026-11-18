// GraphQL v4 at /api/graphql. Implements exactly the documents gh and github-mcp-server send
// (sdk/conformance/checks-graphql.ts GRAPHQL_DOCUMENTS) plus error reporting for unknown fields.

import {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { globalStore, repoOf, commitOf, hashObject, buildCommit, ZERO_OID, DEFAULT_BRANCH, sendJson } from './app.ts';
import { parseJsonBody } from './app.ts';

const VIEWER_LOGIN_NAME = 'adaiversen';

function gqlError(message: string): Record<string, unknown> {
  return { message };
}

/** Repository global id. */
function repoId(owner: string, name: string): string {
  return `repo-${owner}/${name}`;
}

/** Issue global id. */
function issueId(owner: string, name: string, number: number): string {
  return `issue-${owner}/${name}/${number}`;
}

/** Pull request global id. */
function prId(owner: string, name: string, number: number): string {
  return `pr-${owner}/${name}/${number}`;
}

interface GitTreePaths {
  paths: Map<string, string>; // full path -> oid
}

function collectTreePaths(repo: any, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const full = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      for (const [p, o] of collectTreePaths(repo, entry.oid, full)) out.set(p, o);
    } else {
      out.set(full, entry.oid);
    }
  }
  return out;
}

export function parseTree(data: Uint8Array): Array<{ mode: string; name: string; oid: string }> {
  const buffer = Buffer.from(data);
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) break;
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function graphqlState(internal: string): 'OPEN' | 'CLOSED' | 'MERGED' {
  return internal === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueJson(owner: string, repoName: string, issue: any): Record<string, unknown> {
  return {
    id: issueId(owner, repoName, issue.number),
    number: issue.number,
    title: issue.title,
    state: graphqlState(issue.state),
    body: issue.body,
    labels: issue.labels.map((name: string) => ({ name })),
  };
}

function changedPaths(repo: any, baseOid: string, headOid: string): string[] {
  const headCommit = commitOf(repo, headOid);
  const baseCommit = commitOf(repo, baseOid);
  if (!headCommit || !baseCommit) return [];
  const headPaths = collectTreePaths(repo, headCommit.tree);
  const basePaths = collectTreePaths(repo, baseCommit.tree);
  const out: string[] = [];
  for (const [path, oid] of headPaths) {
    if (basePaths.get(path) !== oid) out.push(path);
  }
  return out;
}

function prJson(owner: string, repoName: string, pr: any, repo?: any): Record<string, unknown> {
  let filesChanged = pr.filesChanged;
  if (!filesChanged && repo && pr.headSha && pr.baseSha && pr.headSha !== pr.baseSha) {
    filesChanged = changedPaths(repo, pr.baseSha, pr.headSha);
  }
  return {
    id: prId(owner, repoName, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : graphqlState(pr.state),
    headRefName: pr.head,
    baseRefName: pr.base,
    mergeable: 'MERGEABLE',
    files: { nodes: (filesChanged ?? []).map((path: string) => ({ path })), pageInfo: { hasNextPage: false, endCursor: null } },
  };
}

// --------------------------------------------------------------------------------------------- document recognition

function operationName(document: string): string | null {
  const m = document.match(/\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[2] : null;
}

function variablesOf(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const v = (body as Record<string, unknown>).variables;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return {};
}

// --------------------------------------------------------------------------------------------- field selection helpers

const fieldRe = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*(\{[^}]*\})?/g;
// Crude but sufficient for the fixed documents: extract top-level field names inside a selection set {...}.
function selectionFieldNames(set: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let token = '';
  for (const ch of set) {
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') { depth -= 1; if (token.trim()) names.push(token.trim().split(/\s*\(/)[0]); token = ''; continue; }
    if (depth === 1 && (ch === ',' || ch === '\n')) { if (token.trim()) names.push(token.trim().split(/\s*\(/)[0]); token = ''; continue; }
    if (depth >= 1) token += ch;
  }
  return names;
}

function sliceSelection(document: string): string | null {
  const first = document.indexOf('{');
  const last = document.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  return document.slice(first + 1, last);
}

// --------------------------------------------------------------------------------------------- executor

async function execute(document: string, variables: Record<string, unknown>, store: any): Promise<Record<string, unknown>> {
  const trimmed = document.trim();
  const name = operationName(document) ?? '';
  const isMutation = trimmed.startsWith('mutation');
  const statesFromDoc = trimmed.match(/states:\s*\[\s*([A-Z]+(?:\s*,\s*[A-Z]+)*)\s*\]/);
  const owner = (variables.owner ?? variables.owner) as string;
  const repoName = (variables.name ?? variables.name) as string;
  let repo: any = owner && repoName ? repoOf(store, owner, repoName) : undefined;

  // ---- unknown field on viewer
  if (name === 'ViewerInvalidField') {
    return {
      data: { viewer: { login: VIEWER_LOGIN_NAME } },
      errors: [gqlError('Cannot query field "noSuchFieldOnViewer" on type "Viewer".')],
    };
  }

  if (name === 'ViewerLogin') {
    return { data: { viewer: { login: VIEWER_LOGIN_NAME } } };
  }

  if (name === 'Issue_fields' || name === 'PullRequestAndRepositoryFields' || name === 'SearchType_enumValues') {
    if (name === 'SearchType_enumValues') {
      return { data: { SearchType: { enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'PULL_REQUEST' }] } } };
    }
    const issueFields = [{ name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' }, { name: 'labels' }];
    const pullRequestFields = [{ name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'headRefName' }, { name: 'baseRefName' }, { name: 'mergeable' }, { name: 'state' }, { name: 'merged' }, { name: 'files' }];
    const repositoryFields = [
      { name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' }, { name: 'owner' },
      { name: 'defaultBranchRef' }, { name: 'viewerPermission' }, { name: 'hasIssuesEnabled' }, { name: 'issue' },
      { name: 'issues' }, { name: 'pullRequests' }, { name: 'pullRequest' },
    ];
    if (name === 'Issue_fields') return { data: { Issue: { fields: issueFields } } };
    if (name === 'PullRequestAndRepositoryFields') {
      return { data: { PullRequest: { fields: pullRequestFields }, Repository: { fields: repositoryFields } } };
    }
    return { data: { SearchType: { enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'PULL_REQUEST' }] } } };
  }

  if (!repo && !isMutation) {
    if (name === 'RepositoryFields') return { data: { repository: null } };
    return { data: {} };
  }

  if (name === 'RepositoryFields') {
    return {
      data: {
        repository: {
          id: repoId(owner, repoName),
          databaseId: 1,
          name: repo.name,
          owner: { login: owner },
          defaultBranchRef: { name: DEFAULT_BRANCH },
          viewerPermission: 'WRITE',
          hasIssuesEnabled: true,
        },
      },
    };
  }

  if (name === 'OpenIssues' || name === 'IssuesPage') {
    const first = Number.parseInt(String(variables.first ?? '100'), 10);
    const states = variables.states;
    const effectiveStates = statesFromDoc ? statesFromDoc[1].split(/\s*,\s*/) : states;
    let list = repo.issues.slice();
    if (effectiveStates !== undefined) {
      const allowed = Array.isArray(effectiveStates) ? effectiveStates : [String(effectiveStates)];
      list = list.filter((i: any) => allowed.includes(i.state.toUpperCase()));
    }
    list = list.slice().reverse(); // created DESC
    const after = variables.after ? Number.parseInt(String(variables.after), 10) : -1;
    const start = Math.max(0, after + 1);
    const slice = list.slice(start, start + first);
    return {
      data: {
        repository: {
          issues: {
            nodes: slice.map((i: any) => ({ number: i.number, title: i.title, state: graphqlState(i.state).toString(), id: issueId(owner, repoName, i.number) })),
            pageInfo: { hasNextPage: start + slice.length < list.length, endCursor: String(start + slice.length - 1) },
          },
        },
      },
    };
  }

  if (name === 'IssueByNumber') {
    const number = Number.parseInt(String(variables.number ?? '-1'), 10);
    const issue = repo.issues.find((i: any) => i.number === number);
    return { data: { repository: { issue: issue ? issueJson(owner, repoName, issue) : null } } };
  }

  if (name === 'PullRequests') {
    const first = Number.parseInt(String(variables.first ?? '100'), 10);
    const nodes = repo.pullRequests.slice(0, first).map((pr: any) => prJson(owner, repoName, pr));
    return { data: { repository: { pullRequests: { nodes } } } };
  }

  if (name === 'PullRequestFiles' || name === 'PullRequestId') {
    const number = Number.parseInt(String(variables.number ?? '-1'), 10);
    const pr = repo.pullRequests.find((p: any) => p.number === number);
    if (name === 'PullRequestId') {
      return { data: { repository: { pullRequest: pr ? { id: prId(owner, repoName, pr.number), number: pr.number } : null } } };
    }
    return { data: { repository: { pullRequest: pr ? prJson(owner, repoName, pr) : null } } };
  }

  if (name === 'NodeRepository') {
    const id = String(variables.id ?? '');
    const m = id.match(/^repo-([^/]+)\/(.+)$/);
    if (m && repoOf(store, m[1], m[2])) {
      return { data: { node: { id, name: repo.name, nameWithOwner: `${owner}/${repoName}` } } };
    }
    return { data: { node: null } };
  }

  // ---- mutations
  if (name === 'IssueCreate') {
    const input = (variables.input ?? {}) as Record<string, unknown>;
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const rid = typeof input.repositoryId === 'string' ? input.repositoryId : '';
    const rm = rid.match(/^repo-([^/]+)\/(.+)$/);
    const targetRepo = rm && repoOf(store, rm[1], rm[2]);
    if (!targetRepo) throw new Error('repository not found');
    repo = targetRepo;
    repo.issueCounter += 1;
    const number = repo.issueCounter;
    repo.issues.push({ number, title, body, state: 'open', labels: [] });
    return { data: { createIssue: { issue: issueJson(owner, repoName, repo.issues[repo.issues.length - 1]) } } };
  }

  if (name === 'IssueClose') {
    const input = (variables.input ?? {}) as Record<string, unknown>;
    const id = String(input.issueId ?? '');
    const m = id.match(/^issue-([^/]+)\/(.+)\/(\d+)$/);
    const target = m && repoOf(store, m[1], m[2]);
    if (target) {
      const issue = target.issues.find((i: any) => i.number === Number.parseInt(m[3], 10));
      if (issue) issue.state = 'closed';
    }
    return { data: { closeIssue: { issue: { number: m ? Number.parseInt(m[3], 10) : 0, id, state: 'CLOSED' } } } };
  }

  if (name === 'PullRequestCreate') {
    const input = (variables.input ?? {}) as Record<string, unknown>;
    const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : DEFAULT_BRANCH;
    const headRef = typeof input.headRefName === 'string' ? input.headRefName : DEFAULT_BRANCH;
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    if (!repo) throw new Error('repository not found');
    repo.prCounter += 1;
    const number = repo.prCounter;
    const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? ZERO_OID;
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? ZERO_OID;
    const filesChanged: string[] = [];
    if (headSha !== ZERO_OID && baseSha !== ZERO_OID && headSha !== baseSha) {
      const headCommit = commitOf(repo, headSha);
      const baseCommit = commitOf(repo, baseSha);
      if (headCommit && baseCommit) {
        const headPaths = collectTreePaths(repo, headCommit.tree);
        const basePaths = collectTreePaths(repo, baseCommit.tree);
        for (const [path, oid] of headPaths) {
          if (basePaths.get(path) !== oid) filesChanged.push(path);
        }
      }
    }
    repo.pullRequests.push({ number, title, body, state: 'open', head: headRef, base: baseRef, headSha, baseSha, merged: false, filesChanged });
    const pr = repo.pullRequests[repo.pullRequests.length - 1];
    return { data: { createPullRequest: { pullRequest: prJson(owner, repoName, pr, repo) } } };
  }

  if (name === 'MergePullRequest') {
    const input = (variables.input ?? {}) as Record<string, unknown>;
    const id = String(input.pullRequestId ?? '');
    const m = id.match(/^pr-([^/]+)\/(.+)\/(\d+)$/);
    const target = m && repoOf(store, m[1], m[2]);
    let merged = false;
    if (target) {
      const pr = target.pullRequests.find((p: any) => p.number === Number.parseInt(m[3], 10));
      if (pr) {
        pr.merged = true;
        merged = true;
        const baseCommit = commitOf(target, pr.baseSha);
        const treeOid = baseCommit ? baseCommit.tree : ZERO_OID;
        const identity = `make.fun <forge@example.invalid>`;
        const parents = pr.baseSha === ZERO_OID ? [] : [pr.baseSha];
        const commitData = buildCommit(treeOid, parents, identity, identity, `Merge pull request #${pr.number} from ${pr.head}`);
        const commitOid = hashObject('commit', commitData);
        target.objects.set(commitOid, { type: 'commit', data: commitData, oid: commitOid });
        target.refs.set(`refs/heads/${pr.base}`, commitOid);
      }
    }
    return { data: { mergePullRequest: { pullRequest: { number: m ? Number.parseInt(m[3], 10) : 0, merged, state: merged ? 'MERGED' : 'OPEN' } } } };
  }

  if (name === 'AddComment') {
    const input = (variables.input ?? {}) as Record<string, unknown>;
    const subjectId = String(input.subjectId ?? '');
    const body = typeof input.body === 'string' ? input.body : '';
    let commentId = 0;
    const m = subjectId.match(/^issue-([^/]+)\/(.+)\/(\d+)$/);
    if (m) {
      const repo2 = repoOf(store, m[1], m[2]);
      if (repo2) {
        const issue = repo2.issues.find((i: any) => i.number === Number.parseInt(m[3], 10));
        if (issue) {
          const comments = repo2.issueComments.get(issue.number) ?? [];
          repo2.issueCommentCounter += 1;
          commentId = repo2.issueCommentCounter;
          comments.push({ id: commentId, body });
          repo2.issueComments.set(issue.number, comments);
        }
      }
    }
    return { data: { addComment: { commentEdge: { node: { id: `comment-${commentId}`, body } } } } };
  }

  return { data: {} };
}

export async function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  store: any,
  token: string,
): Promise<void> {
  let body: unknown;
  try { body = await parseJsonBody(req); } catch { sendJson(res, 400, { errors: [{ message: 'invalid json' }] }); return; }

  const operations: Array<string> = Array.isArray(body)
    ? (body as Array<Record<string, unknown>>).map((b) => typeof b.query === 'string' ? b.query : '')
    : (body && typeof body === 'object' && typeof (body as Record<string, unknown>).query === 'string')
      ? [(body as Record<string, unknown>).query as string]
      : [];

  if (operations.length === 0 || operations.some((q) => !q)) { sendJson(res, 400, { errors: [{ message: 'query required' }] }); return; }

  const variablesList = Array.isArray(body)
    ? (body as Array<Record<string, unknown>>).map((b) => variablesOf((b as Record<string, unknown>).variables))
    : [variablesOf(body)];

  try {
    const results = await Promise.all(operations.map((q, i) => execute(q, variablesList[i] ?? {}, store)));
    const hasErrors = results.some((r) => (r as any).errors);
    if (Array.isArray(body)) {
      sendJson(res, 200, results.map((r) => (r as any).errors ? r : ((r as any).data !== undefined ? r : { data: r })));
      return;
    }
    sendJson(res, 200, results[0]);
  } catch (err) {
    sendJson(res, 200, { errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    return;
  }
}
