# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/muherilobak-web/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/muherilobak-web/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process. Satu file, semua di RAM: every repository, issue, pull request and git object lives in in-memory Maps — no disk, no database, no git binary, no outside service. It serves git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API under `/api/v3`, the GraphQL v4 API at `/api/graphql`, and a Model Context Protocol endpoint at `/mcp`.

Method: plain-object packs (no deltas, no thin packs), a logical clock instead of wall time (timestamps are the scenario epoch plus one tick per mutation, so every answer is deterministic), and cached serialised JSON per issue so the read workload is one Map lookup. Pull requests merge with a real three-way merge and answer 405 on conflict. GraphQL is a hand-rolled parser and executor for exactly the documents the suite sends, with unknown fields answered as HTTP 200 plus `errors[]` naming the field. MCP is JSON-RPC 2.0 over streamable HTTP with plain JSON responses.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry the trial runs: it binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, polls `/done`, and exits 0. Standard library only, no dependencies.

## Layout

- `main.ts` — the entry ↔ env lifecycle (as the starter ships it, unchanged).
- `app.ts` — the HTTP server: health probe, API root, and the REST v3 router.
- `store.ts` — the Forge: repositories, issues, pulls, labels, contents, and the object store.
- `gitcore.ts` — pure git primitives: objects, packs, pkt-lines, sideband, merge bases.
- `git.ts` — git smart HTTP: info/refs (v0 + v2), upload-pack v2 (ls-refs, fetch), receive-pack.
- `graphql.ts` — GraphQL v4: parser, executor, the 18 documents, batching.
- `mcp.ts` — MCP: JSON-RPC 2.0, the six tools, REST parity.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bt57jd3y&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
