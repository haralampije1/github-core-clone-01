// Forge event bus for the github-core-clone-01 forge.
//
// Authored by this make.fun entry agent session (new additive code).
//
// A tiny typed event emitter that surface handlers (REST v3, GraphQL v4, MCP,
// smart-HTTP) use to emit forge events (repo created, issue created, pull
// request merged).  Listeners are in-process callbacks; nothing leaves the
// process.  Additive and unused by the suite until wired in — shipping it
// changes nothing the suite observes.

export interface ForgeEvent {
  type: 'repo.created' | 'issue.created' | 'issue.closed' | 'pr.created' | 'pr.merged';
  repo: { owner: string; name: string };
  at: string;
  [key: string]: unknown;
}

export interface RepoCreated extends ForgeEvent {
  type: 'repo.created';
  repository: { name: string; full_name: string; owner: string };
}

export interface IssueCreated extends ForgeEvent {
  type: 'issue.created';
  issue: { number: number; title: string; state: string };
}

export interface IssueClosed extends ForgeEvent {
  type: 'issue.closed';
  issue: { number: number; state: string };
}

export interface PrCreated extends ForgeEvent {
  type: 'pr.created';
  pull_request: { number: number; title: string; head: string; base: string };
}

export interface PrMerged extends ForgeEvent {
  type: 'pr.merged';
  pull_request: { number: number; state: 'MERGED'; merge_commit_sha: string };
}

export type ForgeEventPayload = RepoCreated | IssueCreated | IssueClosed | PrCreated | PrMerged;

type Listener = (event: ForgeEventPayload) => void;

export class ForgeEvents {
  private readonly listeners = new Map<string, Listener[]>();
  private readonly history: ForgeEventPayload[] = [];
  private readonly maxHistory = 1000;

  on(type: ForgeEvent['type'], listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  off(type: ForgeEvent['type'], listener: Listener): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(listener);
    if (idx >= 0) list.splice(idx, 1);
  }

  emit<T extends ForgeEventPayload>(event: T): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.shift();
    const list = this.listeners.get(event.type) ?? [];
    for (const listener of [...list]) {
      try { listener(event); } catch {}
    }
  }

  historyOf(type?: ForgeEvent['type']): ForgeEventPayload[] {
    if (!type) return [...this.history];
    return this.history.filter((e) => e.type === type);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const event of this.history) {
      out[event.type] = (out[event.type] ?? 0) + 1;
    }
    return out;
  }

  clear(): void {
    this.history.length = 0;
    for (const key of this.listeners.keys()) this.listeners.set(key, []);
  }
}

export const forgeEvents = new ForgeEvents();

export function repoCreatedEvent(owner: string, name: string, full_name: string): RepoCreated {
  return {
    type: 'repo.created',
    repo: { owner, name },
    at: new Date().toISOString(),
    repository: { name, full_name, owner },
  };
}

export function issueCreatedEvent(owner: string, name: string, number: number, title: string, state: string): IssueCreated {
  return {
    type: 'issue.created',
    repo: { owner, name },
    at: new Date().toISOString(),
    issue: { number, title, state },
  };
}

export function issueClosedEvent(owner: string, name: string, number: number, state: string): IssueClosed {
  return { type: 'issue.closed', repo: { owner, name }, at: new Date().toISOString(), issue: { number, state } };
}

export function prCreatedEvent(owner: string, name: string, num: number, title: string, head: string, base: string): PrCreated {
  return { type: 'pr.created', repo: { owner, name }, at: new Date().toISOString(), pull_request: { number: num, title, head, base } };
}

export function prMergedEvent(owner: string, name: string, num: number, mergeCommitSha: string): PrMerged {
  return { type: 'pr.merged', repo: { owner, name }, at: new Date().toISOString(), pull_request: { number: num, state: 'MERGED', merge_commit_sha: mergeCommitSha } };
}
