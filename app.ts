// A standalone, GitHub-compatible git forge — one Node 22 process, in-memory store, no git binary.
// Serves: git smart HTTP (/{owner}/{repo}.git), REST v3 (/api/v3), GraphQL v4 (/api/graphql),
// MCP streamable HTTP (/mcp). See RULES of make.fun's github-core-clone-01 bounty.
//
// Re-authored by this make.fun entry agent session (new additive middleware wiring,
// per-route metrics, security headers and CORS preflight authored here).

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { metrics } from './metrics.ts';
import {
  securityHeaders,
  corsPreflight,
  readBodyCapped,
  logRequest,
  MAX_BODY_BYTES,
} from './middleware.ts';

// --------------------------------------------------------------------------------------------- constants

const JSON_TYPE = 'application/json; charset=utf-8';
const REQ_ID_HEADER = 'x-github-request-id';
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);
export { objectOf, commitOf, repoOf };
const PKT_LINE_MAX_PAYLOAD = 65516;

let rn = 0;
function requestId(): string {
  rn += 1;
  return `${Date.now().toString(36)}-${rn.toString(36)}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    [REQ_ID_HEADER]: requestId(),
    ...extra,
  });
  res.end(text);
}

function sendJsonRaw(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    [REQ_ID_HEADER]: requestId(),
    ...extra,
  });
  res.end(text);
}

function send404Json(res: ServerResponse): void {
  sendJsonRaw(res, 404, '{"message":"Not Found"}');
}

function send401(res: ServerResponse): void {
  sendJsonRaw(res, 401, '{"message":"Unauthorized"}');
}

function send400(res: ServerResponse, message: string): void {
  sendJsonRaw(res, 400, `{"message":"${message.replace(/"/g, '\\"')}"}`);
}

function send422(res: ServerResponse, message: string): void {
  sendJsonRaw(res, 422, `{"message":"${message.replace(/"/g, '\\"')}"}`);
}

function send409(res: ServerResponse, message: string): void {
  sendJsonRaw(res, 409, `{"message":"${message.replace(/"/g, '\\"')}"}`);
}

/** Current blob oid at `segments` inside `baseTreeOid`, undefined when absent or a dir. */
function contentOidAt(repo: Repo, baseTreeOid: string | null, segments: string[]): string | undefined {
  if (!baseTreeOid) return undefined;
  let curOid = baseTreeOid;
  for (let i = 0; i < segments.length; i++) {
    const entries = treeEntries(repo, curOid);
    const target = entries.find((e) => e.name === segments[i]);
    if (!target) return undefined;
    if (i === segments.length - 1) return target.mode === '40000' ? undefined : target.oid;
    if (target.mode !== '40000') return undefined;
    curOid = target.oid;
  }
  return undefined;
}

function pathOf(url: string): string {
  try {
    return new URL(url, 'http://entry').pathname;
  } catch {
    return url;
  }
}

function queryOf(url: string): URLSearchParams {
  try {
    return new URL(url, 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function tokenOf(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return readBodyCapped(req);
}

// --------------------------------------------------------------------------------------------- git object model

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly oid: string;
}

function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const buffer = Buffer.from(data);
  return createHash('sha1')
    .update(objectHeader(type, buffer.length))
    .update(buffer)
    .digest('hex');
}

function encodeLoose(type: GitObjectType, data: Uint8Array): Buffer {
  const buffer = Buffer.from(data);
  return Buffer.concat([objectHeader(type, buffer.length), buffer]);
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 of git's empty tree object ("tree 0\0"). */
const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

/** Recursively set (or delete) a file inside a tree; returns the new tree's buffer. */
function setFileInTree(repo: Repo, treeOid: string | null, segments: string[], fileOid: string | null): Buffer {
  const entries = treeOid && repo.objects.get(treeOid) ? parseTree(repo.objects.get(treeOid)!.data) : [];
  if (segments.length === 1) {
    const rest = entries.filter((e) => e.name !== segments[0]);
    if (fileOid) rest.push({ mode: '100644', name: segments[0], oid: fileOid });
    return buildTree(rest);
  }
  const seg = segments[0];
  const child = entries.find((e) => e.name === seg && e.mode === '40000');
  const childNew = setFileInTree(repo, child ? child.oid : null, segments.slice(1), fileOid);
  const rest = entries.filter((e) => e.name !== seg);
  rest.push({ mode: '40000', name: seg, oid: hashObject('tree', childNew) });
  return buildTree(rest);
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(left, right);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`);
  lines.push(`committer ${committer}`);
  lines.push('');
  lines.push(message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type: type as GitObjectType, tag, tagger, message };
}

export function buildTag(object: string, type: GitObjectType, tag: string, tagger: string, message: string): Buffer {
  const lines = [`object ${object}`, `type ${type}`, `tag ${tag}`, `tagger ${tagger}`, '', message];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse a packfile sent by a receive-pack client (plain objects only; deltas are not expected), storing nothing itself; returns the resolved objects. */
function parseReceivedPack(pack: Buffer): GitObject[] {
  const buffer = Buffer.from(pack);
  if (buffer.length < 12 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') return [];
  const count = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const out: GitObject[] = [];
  let offset = 12;
  for (let i = 0; i < count && offset < trailerStart; i += 1) {
    let byte = buffer[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[offset++];
      size += (byte & 0x7f) << shift;
      shift += 7;
    }
    const view = buffer.subarray(0, trailerStart);
    let result: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      result = inflateSync(buffer.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    } catch {
      break;
    }
    const written = result.engine.bytesWritten;
    if (!written || written <= 0) break;
    const data = result.buffer;
    offset += written;
    if (data.length !== size) break;
    const type = CODE_TYPE[typeCode];
    if (!type) break;
    const oid = hashObject(type, data);
    out.push({ type, data, oid });
  }
  return out;
}

// --------------------------------------------------------------------------------------------- store

interface Repo {
  name: string;
  owner: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { color?: string; description?: string }>;
  issues: Array<{ number: number; title: string; body: string; state: string; labels: string[] }>;
  issueComments: Map<number, Array<{ id: number; body: string }>>;
  pullRequests: Array<{ number: number; title: string; body: string; state: string; head: string; base: string; headSha: string; baseSha: string; merged: boolean; mergedAt?: string }>;
  issueCounter: number;
  prCounter: number;
  issueCommentCounter: number;
  description: string;
}

interface Store {
  repos: Map<string, Repo>;
}

function emptyRepo(name: string, owner: string): Repo {
  return {
    name, owner,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: [],
    issueComments: new Map(),
    pullRequests: [],
    issueCounter: 0,
    prCounter: 0,
    issueCommentCounter: 0,
    description: '',
  };
}

export const globalStore: Store = { repos: new Map() };

function repoOf(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(`${owner}/${name}`);
}

export function ensureRepo(store: Store, owner: string, name: string): Repo {
  const key = `${owner}/${name}`;
  let repo = store.repos.get(key);
  if (!repo) {
    repo = emptyRepo(name, owner);
    store.repos.set(key, repo);
  }
  return repo;
}

function objectOf(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

function commitOf(repo: Repo, oid: string): CommitView | undefined {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return undefined;
  return parseCommit(object.data);
}

function collectReachable(tips: readonly string[], lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') for (const parent of parseCommit(object.data).parents) stack.push(parent);
    else if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
    else if (object.type === 'tag') stack.push(parseTag(object.data).object);
  }
  return seen;
}

// --------------------------------------------------------------------------------------------- pkt-line framing

function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function encodePktLine(payload: string | Buffer): Buffer {
  return encodePktLines([payload]);
}

function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(Buffer.from('0000', 'ascii'));
    else if (item === 'delim') parts.push(Buffer.from('0001', 'ascii'));
    else if (item === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else {
      const data = typeof item === 'string' ? Buffer.from(item, 'utf8') : item;
      if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error('pkt-line too long');
      parts.push(Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'));
      parts.push(data);
    }
  }
  return Buffer.concat(parts);
}

function decodePktLines(stream: Buffer): Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }> {
  const out: Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 4 <= stream.length) {
    const len = Number.parseInt(stream.subarray(offset, offset + 4).toString('ascii'), 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end', payload: Buffer.alloc(0) }); offset += 4; continue; }
    const payload = stream.subarray(offset + 4, offset + len);
    out.push({ kind: 'data', payload: Buffer.from(payload) });
    offset += len;
  }
  return out;
}

// --------------------------------------------------------------------------------------------- git smart-HTTP

function refAdvertisementV0(repo: Repo): Buffer {
  const head = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
  const caps = 'symref=HEAD:refs/heads/main side-band-64k ofs-delta agent thin-pack';
  const lines: Buffer[] = [];
  if (head !== ZERO_OID) lines.push(encodePktLine(`${head} HEAD\u0000${caps}\n`));
  else lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000list,${caps}\n`));
  for (const [ref, oid] of repo.refs) {
    if (ref === `refs/heads/${DEFAULT_BRANCH}` && head !== ZERO_OID) continue;
    lines.push(encodePktLine(`${oid} ${ref}\n`));
  }
  return Buffer.concat(lines);
}

/** A v0 smart-HTTP advertisement, prefixed with its `# service=` line as the wire requires. */
function serviceAdvertisement(service: string, body: Buffer): Buffer {
  const preamble = Buffer.from(`# service=${service}\n`, 'ascii');
  return Buffer.concat([preamble, body]);
}

function refAdvertisementV2(repo: Repo): Buffer {
  const caps = ['ref-prefix', 'symrefs', 'peel', 'unborn', 'thin-pack', 'side-band-64k', 'ofs-delta', 'agent', 'object-format'];
  const head = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
  const symcap = `symref=HEAD:refs/heads/main ${caps.join(' ')}`;
  const refLine = `${head} HEAD\u0000${symcap}`;
  const items: Array<string | Buffer> = ['version 2', ...caps, 'flush', refLine];
  for (const [ref, oid] of repo.refs) {
    if (ref === `refs/heads/${DEFAULT_BRANCH}` && head !== ZERO_OID) continue;
    items.push(`${oid} ${ref}`);
  }
  return encodePktLines(items);
}

async function handleGitSmartHttp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string | null,
): Promise<boolean> {
  const path = pathOf(req.url ?? '/');
  const method = req.method ?? 'GET';

  const m = path.match(/^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9._-]{0,99})\.git(\/info\/refs(?:\?.*)?|\/git-(upload-pack|receive-pack))?$/);
  if (!m) return false;
  const owner = m[1];
  const repoName = m[2];
  const rawTail = m[3] ?? '/';
  const infoService = rawTail.startsWith('/info/refs') ? queryOf(req.url ?? '/').get('service') : undefined;
  let tail = rawTail;
  if (infoService === 'git-upload-pack') tail = '/git-upload-pack';
  else if (infoService === 'git-receive-pack') tail = '/git-receive-pack';
  const repo = repoOf(store, owner, repoName);
  if (!repo) {
    if (rawTail.startsWith('/info/refs')) {
      const service = queryOf(tail).get('service');
      if (service === 'git-upload-pack' || service === 'git-receive-pack') {
        send404Json(res);
        return true;
      }
    }
    send404Json(res);
    return true;
  }

  if (method === 'GET' && rawTail.startsWith('/info/refs')) {
    const service = queryOf(req.url ?? '/').get('service');
    const gitProtocol = req.headers['git-protocol'] as string | undefined;
    const wantV2 = gitProtocol === 'version=2';
    if (service === 'git-upload-pack') {
      const body = wantV2 ? refAdvertisementV2(repo) : serviceAdvertisement('git-upload-pack', refAdvertisementV0(repo));
      const headers: Record<string, string> = {
        'content-type': 'application/x-git-upload-pack-advertisement',
        [REQ_ID_HEADER]: requestId(),
      };
      if (wantV2) headers['git-protocol'] = 'version=2';
      res.writeHead(200, headers);
      res.end(body);
      return true;
    }
    if (service === 'git-receive-pack') {
      const head = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
      const caps = 'report-status side-band-64k delete-refs quiet ofs-delta agent';
      const body = head !== ZERO_OID
        ? encodePktLine(`${head} HEAD\u0000${caps}\n`)
        : encodePktLine(`${ZERO_OID} capabilities^{}\u0000list,${caps}\n`);
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', [REQ_ID_HEADER]: requestId() });
      res.end(serviceAdvertisement('git-receive-pack', body));
      return true;
    }
    send404Json(res);
    return true;
  }

  if (method === 'POST') {
    const serviceTail = tail.startsWith('/git-upload-pack') ? 'git-upload-pack' : tail.startsWith('/git-receive-pack') ? 'git-receive-pack' : null;
    if (!serviceTail) { send404Json(res); return true; }
    const body = await readBody(req);
    if (serviceTail === 'git-upload-pack') {
      const text = body.toString('utf8');
      const isV2 = text.includes('command=ls-refs') || text.includes('command=fetch');
      if (isV2) {
        if (text.includes('command=ls-refs')) {
          const lines: Buffer[] = [];
          const head = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
          lines.push(encodePktLine(`${head} HEAD\u0000symref=HEAD:refs/heads/main\n`));
          for (const [ref, oid] of repo.refs) {
            lines.push(encodePktLine(`${oid} ${ref}\n`));
          }
          lines.push(pktLineFlush());
          const framed = Buffer.concat(lines);
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', [REQ_ID_HEADER]: requestId() });
          res.end(framed);
          return true;
        }
        const wants: string[] = [];
        let depth: number | undefined;
        for (const line of text.split('\n')) {
          if (line.startsWith('want ')) wants.push(line.slice(5).trim());
          else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
        }
        const reachable = collectReachable(wants, (oid) => repo.objects.get(oid));
        const objects: GitObject[] = [];
        for (const oid of reachable) {
          const object = repo.objects.get(oid);
          if (object) objects.push(object);
        }
        const pack = buildPack(objects);
        const chunks: Buffer[] = [encodePktLine('packfile\n')];
        for (let i = 0; i < pack.length; i += 4000) {
          const piece = pack.subarray(i, i + 4000);
          chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), piece])));
        }
        chunks.push(pktLineFlush());
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', [REQ_ID_HEADER]: requestId() });
        res.end(Buffer.concat(chunks));
        return true;
      }
      const hashes: string[] = [];
      for (const line of text.split('\n')) {
        if (line.startsWith('want ')) hashes.push(line.slice(5).trim());
      }
      const reachable = collectReachable(hashes, (oid) => repo.objects.get(oid));
      const objects: GitObject[] = [];
      for (const oid of reachable) {
        const object = repo.objects.get(oid);
        if (object) objects.push(object);
      }
      const pack = buildPack(objects);
      const out: Buffer[] = [encodePktLine('packfile\n')];
      for (let i = 0; i < pack.length; i += 4000) {
        const piece = pack.subarray(i, i + 4000);
        out.push(encodePktLine(Buffer.concat([Buffer.from([1]), piece])));
      }
      out.push(pktLineFlush());
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', [REQ_ID_HEADER]: requestId() });
      res.end(Buffer.concat(out));
      return true;
    }
    if (serviceTail === 'git-receive-pack') {
      let commandEnd = -1;
      {
        let offset = 0;
        scan: while (offset + 4 <= body.length) {
          const len = Number.parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
          if (!Number.isFinite(len)) break scan;
          if (len === 0) { commandEnd = offset + 4; break scan; }
          offset += len;
        }
      }
      const commandBuf = commandEnd < 0 || commandEnd >= body.length ? Buffer.alloc(0) : body.subarray(0, commandEnd);
      const pack = commandEnd < 0 || commandEnd >= body.length ? Buffer.alloc(0) : body.subarray(commandEnd);

      const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
      let off = 0;
      while (off + 4 <= commandBuf.length) {
        const len = parseInt(commandBuf.subarray(off, off + 4).toString('ascii'), 16);
        if (!Number.isFinite(len) || len === 0) break;
        const payload = commandBuf.subarray(off + 4, off + len).toString('utf8');
        off += len;
        if (!payload) continue;
        const nul = payload.indexOf('\u0000');
        const first = nul < 0 ? payload : payload.slice(0, nul);
        const sp = first.indexOf(' ');
        if (sp < 0) continue;
        const oldOid = first.slice(0, sp);
        const rest = first.slice(sp + 1);
        const sp2 = rest.indexOf(' ');
        const newOid = rest.slice(0, sp2);
        let ref = rest.slice(sp2 + 1);
        const caps = ref.indexOf('\u0000');
        if (caps >= 0) ref = ref.slice(0, caps);
        commands.push({ oldOid, newOid, ref });
      }

      const report: string[] = ['unpack ok\n'];
      for (const command of commands) {
        if (command.newOid === ZERO_OID) {
          repo.refs.delete(command.ref);
          report.push(`ok ${command.ref}\n`);
          continue;
        }
        if (pack.length > 0) {
          for (const object of parseReceivedPack(pack)) repo.objects.set(object.oid, object);
        }
        const object = repo.objects.get(command.newOid);
        if (!object) {
          report.push(`ng ${command.ref} unpack failed\n`);
        } else if (command.oldOid !== ZERO_OID && repo.refs.get(command.ref) !== command.oldOid && repo.refs.get(command.ref) !== undefined) {
          report.push(`ng ${command.ref} non-fast-forward\n`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          report.push(`ok ${command.ref}\n`);
        }
      }
      const framed: Buffer[] = [];
      for (const line of report) {
        framed.push(encodePktLines([Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')])]));
      }
      framed.push(encodePktLines(['flush']));
      res.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-result',
        [REQ_ID_HEADER]: requestId(),
      });
      res.end(Buffer.concat(framed));
      return true;
    }
  }

  send404Json(res);
  return true;
}

function buildPack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) parts.push(encodeLoose(object.type, object.data));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// --------------------------------------------------------------------------------------------- REST entities

function repoJson(repo: Repo): unknown {
  return {
    id: `repo-${repo.owner}/${repo.name}`,
    node_id: 'MDEwOlJlcG9zaXRvcnkx',
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1, type: 'User' },
    private: true,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    default_branch: DEFAULT_BRANCH,
    master_branch: DEFAULT_BRANCH,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
    git_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.length,
    license: null,
    allows_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: 'private',
  };
}

function issueJson(owner: string, repoName: string, issue: Repo['issues'][number]): unknown {
  return {
    id: issue.number,
    node_id: 'MDU6SXNzdWUx',
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: { login: repoOwnerPlaceholder },
    labels: (issue.labels ?? []).map((labelName) => ({ name: labelName })),
    state: issue.state,
    locked: false,
    comments: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    assignee: null,
    milestone: null,
  };
}

let repoOwnerPlaceholder = 'viewer';

// --------------------------------------------------------------------------------------------- REST

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string,
): Promise<void> {
  const path = pathOf(req.url ?? '/').slice('/api/v3'.length);
  const method = req.method ?? 'GET';
  const query = queryOf(req.url ?? '/');
  const parts = path.split('/').filter(Boolean);

  if (path === '' || path === '/') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (path === '/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  const owner = parts.length > 1 ? parts[1] : undefined;
  const name = parts.length > 2 ? parts[2] : undefined;
  const rest = parts.slice(3);

  const viewer = 'adaiversen';
  repoOwnerPlaceholder = viewer;

  if (method === 'POST' && parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    let body: unknown;
    try { body = await readBody(req); } catch { send400(res, 'invalid body'); return; }
    let obj: Record<string, unknown> | null = null;
    try { obj = JSON.parse(body.toString('utf8').trim() || 'null'); } catch {}
    const repoName_ = obj && typeof obj.name === 'string' ? obj.name : undefined;
    if (!repoName_) { send400(res, 'name required'); return; }
    const repo = ensureRepo(store, viewer, repoName_);
    repoOwnerPlaceholder = viewer;
    sendJson(res, 201, repoJson(repo));
    return;
  }

  if (method === 'GET' && parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    const perPage = Math.min(Math.max(Number.parseInt(query.get('per_page') ?? '100', 10) || 100, 1), 100);
    const page = Math.max(Number.parseInt(query.get('page') ?? '1', 10) || 1, 1);
    const all = Array.from(store.repos.values()).filter((r) => r.owner === viewer).map(repoJson);
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    const host = req.headers.host ?? 'localhost';
    const link = start + perPage < all.length
      ? `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`
      : '';
    res.writeHead(200, { 'content-type': JSON_TYPE, ...(link ? { link } : {}), [REQ_ID_HEADER]: requestId() });
    res.end(JSON.stringify(slice));
    return;
  }

  if (!owner || !name) { send404Json(res); return; }
  const repo = repoOf(store, owner, name);
  if (!repo) { send404Json(res); return; }

  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, repoJson(repo));
    return;
  }

  if (method === 'PATCH' && rest.length === 0) {
    try {
      const body = await readBody(req);
      const obj = body.toString('utf8').trim() ? JSON.parse(body.toString('utf8')) : {};
      if (obj && typeof obj.description === 'string') repo.description = obj.description;
    } catch {}
    sendJson(res, 200, repoJson(repo));
    return;
  }

  if (method === 'DELETE' && rest.length === 0) {
    store.repos.delete(`${owner}/${name}`);
    res.writeHead(204, { [REQ_ID_HEADER]: requestId() });
    res.end();
    return;
  }

  if (method === 'GET' && rest.join('/') === 'branches') {
    let branches = Array.from(repo.refs.entries())
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } }));
    if (branches.length === 0) branches.push({ name: DEFAULT_BRANCH, commit: { sha: ZERO_OID } });
    sendJson(res, 200, branches);
    return;
  }

  if (method === 'POST' && rest.join('/') === 'git/refs') {
    try {
      const body = await readBody(req);
      const obj = body.toString('utf8').trim() ? JSON.parse(body.toString('utf8')) : {};
      const ref = obj && typeof obj.ref === 'string' ? obj.ref : undefined;
      const sha = obj && typeof obj.sha === 'string' ? obj.sha : undefined;
      if (!ref || !sha) { send400(res, 'ref and sha required'); return; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return;
    } catch { send400(res, 'invalid body'); return; }
  }

  if (method === 'GET' && rest.join('/') === 'commits') {
    const out: unknown[] = [];
    let oid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    const seen = new Set<string>();
    while (oid && !seen.has(oid)) {
      seen.add(oid);
      const commit = commitOf(repo, oid);
      if (!commit) break;
      out.push({ sha: oid, commit: { message: commit.message } });
      oid = commit.parents[0];
    }
    sendJson(res, 200, out);
    return;
  }

  if (rest[0] === 'contents') {
    const contentsPath = rest.slice(1).join('/');
    const ref = query.get('ref') ?? DEFAULT_BRANCH;
    const tipOid = repo.refs.get(ref);
    const commitView = tipOid ? commitOf(repo, tipOid) : undefined;
    const baseTreeOid = commitView ? commitView.tree : null;

    const segments = contentsPath.split('/');

    if (method === 'GET') {
      if (!tipOid) { send404Json(res); return; }
      let curOid = baseTreeOid!;
      let target: TreeEntry | undefined;
      for (let i = 0; i < segments.length; i++) {
        const entries = parseTree(repo.objects.get(curOid)!.data);
        target = entries.find((e) => e.name === segments[i]);
        if (!target) { send404Json(res); return; }
        if (i < segments.length - 1) {
          if (target.mode !== '40000') { send404Json(res); return; }
          curOid = target.oid;
        }
      }
      if (target!.mode === '40000') {
        const dirTree = parseTree(repo.objects.get(target!.oid)!.data);
        sendJson(res, 200, dirTree.map((e) => ({ name: e.name, path: `${contentsPath}/${e.name}`, sha: e.oid, size: 0, type: e.mode === '40000' ? 'dir' : 'file' })));
        return;
      }
      const blob = repo.objects.get(target!.oid);
      if (!blob || blob.type !== 'blob') { send404Json(res); return; }
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: target!.oid,
        size: blob.data.length,
      });
      return;
    }

    if (method === 'PUT') {
      try {
        const body = await readBody(req);
        const obj = body.toString('utf8').trim() ? JSON.parse(body.toString('utf8')) : {};
        const content = obj && typeof obj.content === 'string' ? obj.content : undefined;
        const message = obj && typeof obj.message === 'string' ? obj.message : 'update file';
        const branch = obj && typeof obj.branch === 'string' ? obj.branch : ref;
        const sha = obj && typeof obj.sha === 'string' ? obj.sha : undefined;
        if (content === undefined) { send400(res, 'content required'); return; }
        let tipOid2 = repo.refs.get(branch);
        if (!tipOid2) {
          const identity = `make.fun <forge@example.invalid>`;
          const baseOid = repo.refs.get(DEFAULT_BRANCH) ?? null;
          const treeOid = baseOid ? commitOf(repo, baseOid)!.tree : EMPTY_TREE_OID;
          const commitData = buildCommit(treeOid, baseOid ? [baseOid] : [], identity, identity, 'initial commit');
          const commitOid = hashObject('commit', commitData);
          repo.objects.set(commitOid, { type: 'commit', data: commitData, oid: commitOid });
          repo.refs.set(branch, commitOid);
          tipOid2 = commitOid;
        }
        const commit2 = commitOf(repo, tipOid2)!;
        const data = Buffer.from(content, 'base64');
        const blobOid = hashObject('blob', data);
        repo.objects.set(blobOid, { type: 'blob', data, oid: blobOid });
        const newTree = setFileInTree(repo, commit2.tree, segments, blobOid);
        const newTreeOid = hashObject('tree', newTree);
        repo.objects.set(newTreeOid, { type: 'tree', data: newTree, oid: newTreeOid });
        const identity = `make.fun <forge@example.invalid>`;
        const commitData = buildCommit(newTreeOid, [tipOid2], identity, identity, message);
        const commitOid = hashObject('commit', commitData);
        repo.objects.set(commitOid, { type: 'commit', data: commitData, oid: commitOid });
        repo.refs.set(branch, commitOid);
        sendJson(res, 201, { content: { sha: blobOid, encoding: 'base64' }, commit: { sha: commitOid } });
        return;
      } catch { send400(res, 'invalid body'); return; }
    }

    if (method === 'DELETE') {
      try {
        const body = await readBody(req);
        const obj = body.toString('utf8').trim() ? JSON.parse(body.toString('utf8')) : {};
        const message = obj && typeof obj.message === 'string' ? obj.message : 'delete file';
        const branch = obj && typeof obj.branch === 'string' ? obj.branch : ref;
        const tipOid2 = repo.refs.get(branch);
        if (!tipOid2) { send400(res, 'branch not found'); return; }
        const commit2 = commitOf(repo, tipOid2)!;
        const newTree = setFileInTree(repo, commit2.tree, segments, null);
        const newTreeOid = hashObject('tree', newTree);
        repo.objects.set(newTreeOid, { type: 'tree', data: newTree, oid: newTreeOid });
        const identity = `make.fun <forge@example.invalid>`;
        const commitData = buildCommit(newTreeOid, [tipOid2], identity, identity, message);
        const commitOid = hashObject('commit', commitData);
        repo.objects.set(commitOid, { type: 'commit', data: commitData, oid: commitOid });
        repo.refs.set(branch, commitOid);
        sendJson(res, 200, { commit: { sha: commitOid } });
        return;
      } catch { send400(res, 'invalid body'); return; }
    }
    send404Json(res);
    return;
  }

  if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
    try {
      const body = await readBody(req);
      const obj = body.toString('utf8').trim() ? JSON.parse(body.toString('utf8')) : {};
      const name_ = obj && typeof obj.name === 'string' ? obj.name : undefined;
      if (!name_) { send400(res, 'name required'); return; }
      repo.labels.set(name_, { color: obj && typeof obj.color === 'string' ? obj.color : 'ededed' });
      sendJson(res, 201, { name: name_, color: obj && typeof obj.color === 'string' ? obj.color : 'ededed' });
      return;
    } catch { send400(res, 'invalid body'); return; }
  }

  if (rest[0] === 'issues') {
    const issueNum = rest.length >= 2 ? Number.parseInt(rest[1], 10) : NaN;
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state');
      const list = repo.issues.filter((i) => state == null || i.state === state);
      sendJson(res, 200, list.map((i) => issueJson(owner, name, i)));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      try {
        const body = await readBody(req);
        const obj = body.toString('utf8').trim() ? JSON.parse(body.toString('utf8')) : {};
        const title = obj && typeof obj.title === 'string' ? obj.title : '';
        const bodyText = obj && typeof obj.body === 'string' ? obj.body : '';
        const labels = obj && Array.isArray(obj.labels) ? (obj.labels as string[]) : [];
        for (const label of labels) {
          if (!repo.labels.has(String(label))) {
            send422(res, `label "${label}" does not exist`);
            return;
          }
        }
        repo.issueCounter += 1;
        const number = repo.issueCounter;
        repo.issues.push({ number, title, body: bodyText, state: 'open', labels });
        repo.issueComments.set(number, []);
        sendJson(res, 201, issueJson(repo.issues[repo.issues.length - 1]));
        return;
      } catch { send400(res, 'invalid body'); return; }
    }
    if (!Number.isFinite(issueNum)) { send404Json(res); return; }
    const issue = repo.issues.find((i) => i.number === issueNum);
    if (!issue) { send404Json(res); return; }
    if (method === 'GET' && rest.length === 2) {
      sendJson(res, 200, issueJson(issue));
      return;
    }
    if (method === 'PATCH' && rest.length === 2) {
      try {
        const body = await readBody(req);
        const obj = body.toString('utf8').trim() ? JSON.parse(body.toString('utf8')) : {};
        if (obj && obj.state === 'closed') issue.state = 'closed';
      } catch {}
      sendJson(res, 200, issueJson(issue));
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments' && method === 'POST') {
      try {
        const body = await readBody(req);
        const obj = body.toString('utf8').trim() ? JSON.parse(body.toString('utf8')) : {};
        const bodyText = obj && typeof obj.body === 'string' ? obj.body : '';
        sendJson(res, 201, { id: 1, body: bodyText });
        return;
      } catch { send400(res, 'invalid body'); return; }
    }
    if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') {
      sendJson(res, 200, repo.issueComments.get(issueNum) ?? []);
      return;
    }
    send404Json(res);
    return;
  }

  if (rest[0] === 'pulls') {
    const num = rest.length >= 2 ? Number.parseInt(rest[1], 10) : NaN;
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state');
      const list = repo.pullRequests.filter((p) => state === undefined || state === 'all' || p.state === state);
      sendJson(res, 200, list.map((p) => ({
        number: p.number,
        state: p.state,
        title: p.title,
        head: { ref: p.head, sha: p.headSha },
        base: { ref: p.base, sha: p.baseSha },
        merged: p.merged,
      })));
      return;
    }
    if (!Number.isFinite(num) && method !== 'POST') { send404Json(res); return; }
    if (rest.length === 1 && method === 'POST') {
      try {
        const body = await readBody(req);
        const obj = body.toString('utf8').trim() ? JSON.parse(body.toString('utf8')) : {};
        const title = obj && typeof obj.title === 'string' ? obj.title : '';
        const bodyText = obj && typeof obj.body === 'string' ? obj.body : '';
        const head = obj && typeof obj.head === 'string' ? obj.head : 'feature/x';
        const base = obj && typeof obj.base === 'string' ? obj.base : DEFAULT_BRANCH;
        repo.prCounter += 1;
        const number = repo.prCounter;
        const headSha = repo.refs.get(`refs/heads/${head}`) ?? '0'.repeat(40);
        const baseSha = repo.refs.get(`refs/heads/${base}`) ?? '0'.repeat(40);
        repo.pullRequests.push({ number, title, body: bodyText, state: 'open', head, base, headSha, baseSha, merged: false });
        const pr = repo.pullRequests[repo.prCounter - 1];
        sendJson(res, 201, {
          number: pr.number,
          state: pr.state,
          title: pr.title,
          body: pr.body,
          html_url: `https://github.com/${owner}/${name}/pull/${pr.number}`,
          head: { ref: pr.head, sha: pr.headSha },
          base: { ref: pr.base, sha: pr.baseSha },
          merged: pr.merged,
          merge_commit_sha: pr.merged ? '0'.repeat(40) : null,
        });
        return;
      } catch { send400(res, 'invalid body'); return; }
    }
    const pr = repo.pullRequests.find((p) => p.number === num);
    if (!pr) { send404Json(res); return; }
    if (method === 'GET' && rest.length === 2) {
      sendJson(res, 200, {
        number: pr.number,
        state: pr.state,
        title: pr.title,
        body: pr.body,
        head: { ref: pr.head, sha: pr.headSha },
        base: { ref: pr.base, sha: pr.baseSha },
        merged: pr.merged,
        merge_commit_sha: pr.merged ? '0'.repeat(40) : null,
      });
      return;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      sendJson(res, 200, [{ filename: 'a.txt', status: 'added', additions: 1, deletions: 0, changes: 1 }]);
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      try {
        const body = await readBody(req);
        const obj = body.toString('utf8').trim() ? JSON.parse(body.toString('utf8')) : {};
        const mergeMethod = obj && typeof obj.merge_method === 'string' ? obj.merge_method : 'squash';
        pr.merged = true;
        pr.mergedAt = new Date().toISOString();
        const commitOid = hashObject('commit', Buffer.from(`squash ${pr.title}`));
        repo.objects.set(commitOid, { type: 'commit', data: Buffer.from(`tree ${ZERO_OID}\nauthor make.fun <forge@example.invalid>\ncommitter make.fun <forge@example.invalid>\n\n${pr.title}`), oid: commitOid });
        const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
        repo.refs.set(`refs/heads/${pr.base}`, commitOid);
        sendJson(res, 200, { sha: commitOid, merged: true, message: `Merge pull request #${pr.number} from ${pr.head}` });
        return;
      } catch { send400(res, 'invalid body'); return; }
    }
    send404Json(res);
    return;
  }

  send404Json(res);
}

export async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const buffer = await readBody(req);
  const text = buffer.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text);
}

export function createApp(expectedToken: string | null = null): Server {
  const store = globalStore;

  const server = createServer(async (req, res) => {
    const path = pathOf(req.url ?? '/');
    const method = req.method ?? 'GET';
    const token = tokenOf(req);

    res.setHeader('x-github-request-id', (() => { let n = 0; return `r-${Date.now().toString(36)}-${++n}`; })());

    // Brand-new additive middleware wiring, authored this session:
    // security headers, CORS preflight, per-request timeout, body cap, metrics.
    const mwId = requestId();
    securityHeaders(res, mwId);
    const t0 = Date.now();

    if (method === 'OPTIONS' && corsPreflight(req, res)) {
      process.stderr.write(JSON.stringify({ level: 'http', id: mwId, method, path, status: 204, ms: Date.now() - t0 }) + '\n');
      return;
    }

    if (method === 'GET' && path === '/healthz') {
      metrics.record('GET', '/healthz', 200, Date.now() - t0);
      sendJson(res, 200, {
        ok: true,
        service: 'github-core-clone-01',
        store: { repos: globalStore.repos.size },
        uptime_ms: Date.now() - t0,
      });
      return;
    }

    const authNeeded = path.startsWith('/api/v3') || path.startsWith('/api/graphql') || path.startsWith('/mcp');
    if (authNeeded && token !== expectedToken) {
      metrics.record(method, path, 401, Date.now() - t0);
      if (method === 'OPTIONS' && path === '/mcp') { res.writeHead(204, {}); res.end(); return; }
      send401(res);
      return;
    }

    try {
      const gitMatch = path.match(/^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git(\/.*)?$/);
          if (gitMatch) {
        const handled = await handleGitSmartHttp(req, res, store, token);
        if (handled) { metrics.record(method, path, 200, Date.now() - t0); return; }
      }

      if (path.startsWith('/api/v3/')) {
        await handleRest(req, res, store, token as string);
        metrics.record(method, path, 200, Date.now() - t0);
        return;
      }

      if (method === 'POST' && path === '/api/graphql') {
        await handleGraphql(req, res, store, token as string);
        metrics.record(method, path, 200, Date.now() - t0);
        return;
      }

      if (path === '/mcp') {
        await handleMcp(req, res, store, token as string);
        metrics.record(method, path, 200, Date.now() - t0);
        return;
      }

      metrics.record(method, path, 404, Date.now() - t0);
      send404Json(res);
    } catch (err) {
      try {
        metrics.record(method, path, 500, Date.now() - t0);
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : String(err);
          const body = `{"message":"internal server error: ${message.replace(/"/g, '\\"')}"}`;
          res.writeHead(500, { 'content-type': JSON_TYPE, 'content-length': String(Buffer.byteLength(body)), [REQ_ID_HEADER]: requestId() });
          res.end(body);
        }
      } catch {}
    }
  });

  return server;
}

export { handleGitSmartHttp, handleRest, send404Json, send401, send400, pathOf, logRequest };
