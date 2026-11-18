# github-core-clone-01

A standalone, GitHub-compatible git forge: one Node 22 process, no UI, no database, no `git` binary and no network beyond the trial's env. It serves four surfaces from its own in-memory store:

- git smart HTTP at `/{owner}/{repo}.git` — `upload-pack` protocol v2 (and v0), `receive-pack` v0 with `report-status`, `side-band-64k` and `delete-refs`
- GitHub REST v3 under `/api/v3` — repositories, contents, labels, issues, pull requests and merges
- GitHub GraphQL v4 at `/api/graphql` — `__type` introspection and the create/close/merge/comment mutations `gh` and `github-mcp-server` send
- Model Context Protocol at `/mcp` (streamable HTTP, revision `2026-07-28`) — `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` and more

Entry point: `main.ts` binds an ephemeral port, registers it with the env and long-polls `/done`; `app.ts` is the server.

Built for [make.fun's github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01) by @haralampije1.

Repository: https://github.com/haralampije1/github-core-clone-01

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/haralampije1/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/haralampije1/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)
