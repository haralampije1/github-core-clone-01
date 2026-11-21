// Git object / reference operations shared by the github-core-clone-01 forge.
//
// Authored by this make.fun entry agent session (new additive code).
//
// Pure helpers over the in-memory git object model: ref validity, fast-forward
// checks, object reachability, and loose-object encoding.  Surface handlers in
// app.ts own protocol framing; this module owns the object-model rules so they
// are written once and reused by smart-HTTP receive-pack, REST git/refs, and
// GraphQL merges alike.

import {
  type GitObject,
  type GitObjectType,
  commitOf,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
} from './app.ts';

export type RefUpdate = { oldOid: string; newOid: string; ref: string };

export function isValidOid(oid: string): boolean {
  return /^[0-9a-f]{40}$/.test(oid);
}

export function isZeroOid(oid: string): boolean {
  return oid === ZERO_OID;
}

export function validRefName(ref: string): boolean {
  if (!ref || ref.length === 0 || ref.length > 255) return false;
  if (ref.startsWith('.') || ref.endsWith('.') || ref.includes('..')) return false;
  if (ref.includes('//') || ref.hasOwnProperty) return false;
  return !/[ \t~:^?*\\[]/.test(ref) && !ref.endsWith('/') && !ref.includes('/.');
}

/** Fast-forward rule: allowed when there is no old value, or the old value is
 * an ancestor of the new value (including equality). */
export function fastForwardAllowed(
  oldOid: string,
  newOid: string,
  lookup: (oid: string) => GitObject | undefined,
): boolean {
  if (isZeroOid(oldOid)) return true;
  if (oldOid === newOid) return true;
  const reachable = reachableFrom([newOid], lookup);
  return reachable.has(oldOid);
}

export function reachableFrom(tips: readonly string[], lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips].filter((oid) => oid && oid !== ZERO_OID);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') for (const parent of parseCommit(object.data).parents) stack.push(parent);
    else if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
    else if (object.type === 'tag') stack.push(parseTag(object.data).object);
  }
  return seen;
}

export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return Buffer.concat([header, Buffer.from(data)]);
}

export function objectOid(type: GitObjectType, data: Uint8Array): string {
  return hashObject(type, data);
}

export function parseRefUpdates(payload: Buffer): RefUpdate[] {
  const updates: RefUpdate[] = [];
  let off = 0;
  while (off + 4 <= payload.length) {
    const len = Number.parseInt(payload.subarray(off, off + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len === 0) break;
    const text = payload.subarray(off + 4, off + len).toString('utf8');
    off += len;
    if (!text) continue;
    const nul = text.indexOf('\u0000');
    const first = nul < 0 ? text : text.slice(0, nul);
    const sp = first.indexOf(' ');
    if (sp < 0) continue;
    const oldOid = first.slice(0, sp);
    const rest = first.slice(sp + 1);
    const sp2 = rest.indexOf(' ');
    const newOid = rest.slice(0, sp2);
    let ref = rest.slice(sp2 + 1);
    const caps = ref.indexOf('\u0000');
    if (caps >= 0) ref = ref.slice(0, caps);
    updates.push({ oldOid, newOid, ref });
  }
  return updates;
}

export function diffTreePaths(
  repo: { objects: Map<string, { type: string; data: Uint8Array }> },
  baseTreeOid: string | null,
  headTreeOid: string | null,
): string[] {
  const base = baseTreeOid ? collectPaths(repo.objects, baseTreeOid) : new Map<string, string>();
  const head = headTreeOid ? collectPaths(repo.objects, headTreeOid) : new Map<string, string>();
  const out: string[] = [];
  for (const [path, oid] of head) {
    if (base.get(path) !== oid) out.push(path);
  }
  return out.sort();
}

function collectPaths(objects: Map<string, { type: string; data: Uint8Array }>, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const stack: Array<{ oid: string; prefix: string }> = [{ oid: treeOid, prefix: '' }];
  while (stack.length > 0) {
    const { oid, prefix } = stack.pop()!;
    const object = objects.get(oid);
    if (!object || object.type !== 'tree') continue;
    for (const entry of parseTree(object.data)) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') stack.push({ oid: entry.oid, prefix: full });
      else out.set(full, entry.oid);
    }
  }
  return out;
}
