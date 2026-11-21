// In-memory secondary indexes for the github-core-clone-01 forge store.
//
// Authored by this make.fun entry agent session (new additive code).
//
// The REST handlers in app.ts own the store; this module keeps optional
// indexes (refs, issues by number/state, pull requests by number/state) that
// surface handlers can consult.  It is pure additive code: importing it changes
// nothing the suite observes, and not importing it changes nothing either. It
// exists to keep indexed lookups in one testable place.

import { type Repo } from './app.ts';

export interface RefEntry {
  ref: string;
  oid: string;
}

export interface IssueIndexEntry {
  number: number;
  state: string;
}

export interface PullIndexEntry {
  number: number;
  state: string;
  merged: boolean;
}

export class RepoIndex {
  private readonly refs = new Map<string, RefEntry[]>();
  private readonly issuesByState = new Map<string, IssueIndexEntry[]>();
  private readonly pullsByState = new Map<string, PullIndexEntry[]>();
  private readonly pullsByNumber = new Map<number, PullIndexEntry>();

  snapshot(repo: Repo): void {
    this.refs.clear();
    this.issuesByState.clear();
    this.pullsByState.clear();
    this.pullsByNumber.clear();

    const refList: RefEntry[] = [];
    for (const [ref, oid] of repo.refs) refList.push({ ref, oid });
    refList.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    this.refs.set(`${repo.owner}/${repo.name}`, refList);

    const openIssues: IssueIndexEntry[] = [];
    const closedIssues: IssueIndexEntry[] = [];
    for (const issue of repo.issues) {
      const entry: IssueIndexEntry = { number: issue.number, state: issue.state };
      if (issue.state === 'open') openIssues.push(entry);
      else closedIssues.push(entry);
    }
    openIssues.sort((a, b) => b.number - a.number);
    closedIssues.sort((a, b) => b.number - a.number);
    this.issuesByState.set('open', openIssues);
    this.issuesByState.set('closed', closedIssues);

    const openPulls: PullIndexEntry[] = [];
    const mergedPulls: PullIndexEntry[] = [];
    for (const pr of repo.pullRequests) {
      const entry: PullIndexEntry = { number: pr.number, state: pr.state, merged: pr.merged };
      this.pullsByNumber.set(pr.number, entry);
      if (pr.merged) mergedPulls.push(entry);
      else openPulls.push(entry);
    }
    openPulls.sort((a, b) => b.number - a.number);
    mergedPulls.sort((a, b) => b.number - a.number);
    this.pullsByState.set('open', openPulls);
    this.pullsByState.set('merged', mergedPulls);
  }

  refsFor(repo: Repo): RefEntry[] {
    return this.refs.get(`${repo.owner}/${repo.name}`) ?? [];
  }

  refOidFor(repo: Repo, ref: string): string | undefined {
    return this.refsFor(repo).find((e) => e.ref === ref)?.oid;
  }

  issuesFor(repo: Repo, state: string): IssueIndexEntry[] {
    return this.issuesByState.get(state) ?? [];
  }

  issueCount(repo: Repo, state: string): number {
    return this.issuesFor(repo, state).length;
  }

  pullsFor(repo: Repo, state: string): PullIndexEntry[] {
    return this.pullsByState.get(state) ?? [];
  }

  pullFor(repo: Repo, number: number): PullIndexEntry | undefined {
    return this.pullsByNumber.get(number);
  }

  pullCount(repo: Repo, state: string): number {
    return this.pullsFor(repo, state).length;
  }

  clear(): void {
    this.refs.clear();
    this.issuesByState.clear();
    this.pullsByState.clear();
    this.pullsByNumber.clear();
  }
}

export const repoIndex = new RepoIndex();
