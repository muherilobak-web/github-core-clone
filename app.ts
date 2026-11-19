// app.ts — the HTTP server: one Forge, four surfaces.
//   - GET /healthz (the env's boot probe) and GET /api/v3/ (the API root),
//     exactly as the starter answers them.
//   - git smart HTTP (/{owner}/{repo}.git/...) — unauthenticated, see git.ts.
//   - REST v3 (/api/v3/...) — Bearer token, X-GitHub-Request-Id on every reply.
//   - GraphQL v4 (POST /api/graphql) and MCP (POST /mcp) — Bearer token.
//   - everything else: JSON 404.
//
// REST notes (from checks-rest.ts):
//   - GET /user/repos honours per_page/page and answers Link: <absolute url>; rel="next".
//   - issue numbers increment per repo from 1; a duplicate repo name is 422 with
//     "already exists" in the message; a repo under another owner is 404, never 403.
//   - PUT /contents is 201 on create, 200 on update, 409 on a stale sha, and creates
//     the branch (from the default tip) when it is missing.
//   - a conflicted squash merge is 405; an unknown PR merge is 404.
//   - the commit list view strips one trailing newline from the message.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER, tokenValid as shopTokenValid, type Issue, type Repo } from './store.ts';
import { parseCommit, walkCommits } from './gitcore.ts';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

interface Reply {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  const text = `${JSON.stringify(body)}\n`;
  return { status, contentType: JSON_TYPE, body: Buffer.from(text, 'utf8'), headers };
}

function rawJsonReply(status: number, text: string, headers: Record<string, string> = {}): Reply {
  return { status, contentType: JSON_TYPE, body: Buffer.from(text, 'utf8'), headers };
}

function notFound(): Reply {
  return jsonReply(404, { message: 'Not Found' });
}

function unauthorized(): Reply {
  return jsonReply(401, { message: 'Requires authentication' });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The path and query of a request URL, parsed once (never a throw from a request). */
function urlOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/** Read the request body (up to MAX_BODY_BYTES); an over-long body is an error. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body: {} for an empty body, null when the JSON is malformed. */
function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  const text = body.toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ views

/** `Name <email> <epoch> +0000` -> the GitHub author/committer shape. */
function personView(raw: string): { name: string; email: string; date: string } {
  const match = /^(.+?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw);
  if (match === null) return { name: raw, email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitView(forge: Forge, oid: string): Record<string, unknown> | null {
  const object = forge.getObject(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
  return {
    sha: oid,
    commit: {
      message,
      author: personView(commit.author),
      committer: personView(commit.committer),
    },
    parents: commit.parents.map((sha) => ({ sha })),
  };
}

// ------------------------------------------------------------------ REST

class Rest {
  private readonly forge: Forge;

  constructor(forge: Forge) {
    this.forge = forge;
  }

  private tokenValid(headers: Record<string, string | undefined>): boolean {
    return shopTokenValid(headers.authorization);
  }

  /** The repo a REST path names, or null (404 — never 403 for another owner). */
  private repo(owner: string, name: string): Repo | null {
    return this.forge.getRepo(owner, name) ?? null;
  }

  route(method: string, path: string, query: URLSearchParams, headers: Record<string, string | undefined>, body: Buffer, host: string): Reply {
    // Meta.
    if (method === 'GET' && path === '/api/v3/meta') {
      if (!this.tokenValid(headers)) return unauthorized();
      return jsonReply(200, { installed_version: '1.0.0' });
    }
    if (method === 'GET' && path === '/api/v3/user') {
      if (!this.tokenValid(headers)) return unauthorized();
      return jsonReply(200, {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        avatar_url: '',
        html_url: '',
      });
    }
    // /user/repos: create + paginated list.
    if (path === '/api/v3/user/repos') {
      if (!this.tokenValid(headers)) return unauthorized();
      if (method === 'POST') return this.createRepo(body);
      if (method === 'GET') return this.listRepos(query, host);
      return notFound();
    }
    // /repos/{owner}/{repo}/...
    if (path.startsWith('/api/v3/repos/')) {
      if (!this.tokenValid(headers)) return unauthorized();
      return this.routeRepo(method, path.slice('/api/v3/repos/'.length), query, body);
    }
    return notFound();
  }

  private createRepo(body: Buffer): Reply {
    const parsed = parseJsonBody(body);
    if (parsed === null) return jsonReply(400, { message: 'request body is not valid JSON' });
    const name = parsed.name as string | undefined;
    if (typeof name !== 'string' || name === '') return jsonReply(422, { message: 'name is required' });
    const repo = this.forge.createRepo(
      name,
      typeof parsed.description === 'string' ? parsed.description : '',
      parsed.private === true,
    );
    if (repo === null) return jsonReply(422, { message: `Repository '${name}' already exists` });
    return jsonReply(201, this.forge.repoJson(repo));
  }

  private listRepos(query: URLSearchParams, host: string): Reply {
    const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
    const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
    const repos = this.forge.listRepos();
    const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
    const start = (page - 1) * perPage;
    const slice = repos.slice(start, start + perPage);
    const headers: Record<string, string> = {};
    if (page < totalPages) {
      const origin = `http://${host}`;
      const next = `${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
      const last = `${origin}/api/v3/user/repos?per_page=${perPage}&page=${totalPages}`;
      headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
    }
    return jsonReply(200, slice.map((repo) => this.forge.repoJson(repo)), headers);
  }

  private routeRepo(method: string, rest: string, query: URLSearchParams, body: Buffer): Reply {
    const segments = rest.split('/').map(decodeSegment);
    const owner = segments[0] ?? '';
    const name = segments[1] ?? '';
    const repo = this.repo(owner, name);
    if (repo === null) return notFound();
    const tail = segments.slice(2);
    if (tail.length === 0) {
      if (method === 'GET') return jsonReply(200, this.forge.repoJson(repo));
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (parsed === null) return jsonReply(400, { message: 'request body is not valid JSON' });
        if (typeof parsed.description === 'string') repo.description = parsed.description;
        return jsonReply(200, this.forge.repoJson(repo));
      }
      if (method === 'DELETE') {
        this.forge.deleteRepo(repo);
        return { status: 204, contentType: JSON_TYPE, body: Buffer.alloc(0) };
      }
      return notFound();
    }
    switch (tail[0]) {
      case 'branches': {
        if (tail.length === 1) {
          if (method !== 'GET') return notFound();
          const branches = this.forge
            .refList(repo)
            .filter((ref) => ref.name.startsWith('refs/heads/'))
            .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } }));
          return jsonReply(200, branches);
        }
        if (method !== 'GET') return notFound();
        const branch = tail.slice(1).join('/');
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return notFound();
        return jsonReply(200, { name: branch, commit: { sha: tip } });
      }
      case 'commits': {
        if (method !== 'GET') return notFound();
        if (tail.length === 2) {
          const view = commitView(this.forge, tail[1]);
          return view === null ? notFound() : jsonReply(200, view);
        }
        const ref = query.get('sha') ?? undefined;
        const tip = this.forge.resolveRef(repo, ref);
        if (tip === null) return jsonReply(200, []);
        const views = walkCommits(this.forge.getObject, tip)
          .map((oid) => commitView(this.forge, oid))
          .filter((view): view is Record<string, unknown> => view !== null);
        return jsonReply(200, views);
      }
      case 'git': {
        if (tail[1] !== 'refs') return notFound();
        if (method === 'POST' && tail.length === 2) {
          const parsed = parseJsonBody(body);
          if (parsed === null) return jsonReply(400, { message: 'request body is not valid JSON' });
          const ref = parsed.ref as string | undefined;
          const sha = parsed.sha as string | undefined;
          if (typeof ref !== 'string' || !ref.startsWith('refs/')) return jsonReply(422, { message: 'ref must start with refs/' });
          if (typeof sha !== 'string' || this.forge.getObject(sha) === undefined) {
            return jsonReply(422, { message: 'sha does not name an object' });
          }
          if (repo.refs.has(ref)) return jsonReply(422, { message: 'Reference already exists' });
          repo.refs.set(ref, sha);
          return jsonReply(201, { ref, object: { sha } });
        }
        if (method === 'GET' && tail[2] === 'heads' && tail.length >= 4) {
          const branch = tail.slice(3).join('/');
          const tip = repo.refs.get(`refs/heads/${branch}`);
          if (tip === undefined) return notFound();
          return jsonReply(200, { ref: `refs/heads/${branch}`, object: { sha: tip } });
        }
        return notFound();
      }
      case 'contents': {
        const filePath = tail.slice(1).join('/');
        if (method === 'GET') return this.getContents(repo, query, filePath);
        if (method === 'PUT') return this.putContents(repo, body, filePath);
        if (method === 'DELETE') return this.deleteContents(repo, body, filePath);
        return notFound();
      }
      case 'labels': {
        if (method !== 'POST') return notFound();
        const parsed = parseJsonBody(body);
        if (parsed === null) return jsonReply(400, { message: 'request body is not valid JSON' });
        const labelName = parsed.name as string | undefined;
        if (typeof labelName !== 'string' || labelName === '') return jsonReply(422, { message: 'name is required' });
        if (repo.labels.has(labelName)) return jsonReply(422, { message: `Label '${labelName}' already exists` });
        const color = typeof parsed.color === 'string' ? parsed.color : 'ededed';
        repo.labels.set(labelName, { name: labelName, color });
        return jsonReply(201, { name: labelName, color });
      }
      case 'issues': {
        if (tail.length === 1) {
          if (method === 'GET') return this.listIssues(repo, query);
          if (method === 'POST') return this.createIssue(repo, body);
          return notFound();
        }
        const number = Number(tail[1]);
        if (!Number.isInteger(number)) return notFound();
        const issue = this.forge.getIssue(repo, number);
        if (issue === undefined) return notFound();
        if (tail.length === 2) {
          if (method === 'GET') return rawJsonReply(200, issue.json);
          if (method === 'PATCH') return this.patchIssue(repo, issue, body);
          return notFound();
        }
        if (tail[2] === 'comments') {
          if (method === 'GET') {
            return jsonReply(
              200,
              issue.comments.map((comment) => ({
                id: comment.id,
                body: comment.body,
                user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
                created_at: this.forge.isoAt(comment.seq),
              })),
            );
          }
          if (method === 'POST') {
            const parsed = parseJsonBody(body);
            if (parsed === null) return jsonReply(400, { message: 'request body is not valid JSON' });
            const commentBody = typeof parsed.body === 'string' ? parsed.body : '';
            const comment = this.forge.addComment(repo, issue, commentBody);
            return jsonReply(201, {
              id: comment.id,
              body: comment.body,
              user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
              created_at: this.forge.isoAt(comment.seq),
            });
          }
          return notFound();
        }
        return notFound();
      }
      case 'pulls': {
        if (tail.length === 1) {
          if (method === 'GET') return this.listPulls(repo, query);
          if (method === 'POST') return this.createPull(repo, body);
          return notFound();
        }
        const number = Number(tail[1]);
        if (!Number.isInteger(number)) return notFound();
        const pull = this.forge.getPull(repo, number);
        if (pull === undefined) return notFound();
        if (tail.length === 2) {
          if (method !== 'GET') return notFound();
          return jsonReply(200, this.forge.pullView(repo, pull));
        }
        if (tail[2] === 'files' && method === 'GET') {
          return jsonReply(200, this.forge.pullFiles(repo, pull));
        }
        if (tail[2] === 'merge' && method === 'PUT') {
          const result = this.forge.mergePull(repo, pull);
          if (!result.ok) return jsonReply(result.status, { message: result.message });
          return jsonReply(200, { merged: true, sha: result.sha, message: 'Pull request successfully merged' });
        }
        return notFound();
      }
      default:
        return notFound();
    }
  }

  private getContents(repo: Repo, query: URLSearchParams, filePath: string): Reply {
    const ref = query.get('ref') ?? undefined;
    const found = this.forge.readPath(repo, ref, filePath);
    if (found === null) return notFound();
    if (found.kind === 'dir') return jsonReply(200, found.entries);
    return jsonReply(200, {
      type: 'file',
      encoding: 'base64',
      content: found.data.toString('base64'),
      sha: found.oid,
      size: found.data.length,
    });
  }

  private putContents(repo: Repo, body: Buffer, filePath: string): Reply {
    const parsed = parseJsonBody(body);
    if (parsed === null) return jsonReply(400, { message: 'request body is not valid JSON' });
    const content = parsed.content as string | undefined;
    if (typeof content !== 'string') return jsonReply(422, { message: 'content is required' });
    const message = typeof parsed.message === 'string' ? parsed.message : 'Update file';
    const branch = typeof parsed.branch === 'string' ? parsed.branch : undefined;
    const sha = typeof parsed.sha === 'string' ? parsed.sha : undefined;
    const result = this.forge.putFile(repo, filePath, content, message, branch, sha);
    if (result.status === 409 || result.status === 422) return jsonReply(result.status, { message: result.message ?? 'Conflict' });
    return jsonReply(result.status, {
      content: { sha: result.contentSha, encoding: 'base64' },
      commit: { sha: result.commitSha },
    });
  }

  private deleteContents(repo: Repo, body: Buffer, filePath: string): Reply {
    const parsed = parseJsonBody(body);
    if (parsed === null) return jsonReply(400, { message: 'request body is not valid JSON' });
    const message = typeof parsed.message === 'string' ? parsed.message : 'Delete file';
    const sha = typeof parsed.sha === 'string' ? parsed.sha : undefined;
    const result = this.forge.deleteFile(repo, filePath, message, sha);
    if (result.status !== 200) return jsonReply(result.status, { message: result.message ?? 'Not Found' });
    return jsonReply(200, { commit: { sha: result.commitSha } });
  }

  private listIssues(repo: Repo, query: URLSearchParams): Reply {
    const state = query.get('state') ?? 'open';
    const direction = query.get('direction') ?? 'desc';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    return jsonReply(200, issues.map((issue) => this.forge.issueView(repo, issue)));
  }

  private createIssue(repo: Repo, body: Buffer): Reply {
    const parsed = parseJsonBody(body);
    if (parsed === null) return jsonReply(400, { message: 'request body is not valid JSON' });
    const title = typeof parsed.title === 'string' ? parsed.title : '';
    const issueBody = typeof parsed.body === 'string' ? parsed.body : '';
    const labels = Array.isArray(parsed.labels) ? (parsed.labels as string[]) : [];
    const issue = this.forge.createIssue(repo, title, issueBody, labels);
    if ('error' in issue) return jsonReply(422, { message: issue.error });
    return rawJsonReply(201, issue.json);
  }

  private patchIssue(repo: Repo, issue: Issue, body: Buffer): Reply {
    const parsed = parseJsonBody(body);
    if (parsed === null) return jsonReply(400, { message: 'request body is not valid JSON' });
    if (parsed.state === 'closed' || parsed.state === 'open') this.forge.setIssueState(repo, issue, parsed.state);
    if (typeof parsed.title === 'string') issue.title = parsed.title;
    if (typeof parsed.body === 'string') issue.body = parsed.body;
    this.forge.refreshIssueJson(repo, issue);
    return rawJsonReply(200, issue.json);
  }

  private listPulls(repo: Repo, query: URLSearchParams): Reply {
    const state = query.get('state') ?? 'open';
    let pulls = [...repo.pulls];
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    return jsonReply(200, pulls.map((pull) => this.forge.pullView(repo, pull)));
  }

  private createPull(repo: Repo, body: Buffer): Reply {
    const parsed = parseJsonBody(body);
    if (parsed === null) return jsonReply(400, { message: 'request body is not valid JSON' });
    const title = typeof parsed.title === 'string' ? parsed.title : '';
    const pullBody = typeof parsed.body === 'string' ? parsed.body : '';
    const head = typeof parsed.head === 'string' ? parsed.head : '';
    const base = typeof parsed.base === 'string' ? parsed.base : repo.defaultBranch;
    const pull = this.forge.createPull(repo, title, pullBody, head, base);
    if ('error' in pull) return jsonReply(422, { message: pull.error });
    return jsonReply(201, this.forge.pullView(repo, pull));
  }
}

// ------------------------------------------------------------------ server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const rest = new Rest(forge);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { path, query } = urlOf(req);
      const method = req.method ?? 'GET';
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      const host = headers.host ?? '127.0.0.1';
      let reply: Reply;
      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          reply = jsonReply(200, { ok: true });
        } else if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
          reply = jsonReply(
            200,
            { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
            { 'x-oauth-scopes': 'repo, read:org', 'x-github-request-id': forge.nextRequestId() },
          );
        } else if (method === 'POST' && path === '/mcp') {
          reply = handleMcp(forge, { headers, body: await readBody(req) });
        } else if (method === 'POST' && path === '/api/graphql') {
          if (!shopTokenValid(headers.authorization)) {
            reply = unauthorized();
          } else {
            const result = handleGraphql(forge, await readBody(req));
            reply = { status: result.status, contentType: JSON_TYPE, body: Buffer.from(result.body, 'utf8') };
          }
        } else if (path.startsWith('/api/v3/')) {
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          reply = rest.route(method, path, query, headers, body, host);
          // Every REST reply carries a request id and the token scopes.
          reply.headers = {
            'x-github-request-id': forge.nextRequestId(),
            'x-oauth-scopes': 'repo, read:org',
            ...reply.headers,
          };
        } else {
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const gitReply = handleGit(forge, { method, path, query, headers, body });
          reply = gitReply ?? notFound();
        }
      } catch (error) {
        // A handler must never kill the server: answer 500 and keep serving.
        process.stderr.write(`[forge] handler error: ${error instanceof Error ? error.message : String(error)}\n`);
        reply = jsonReply(500, { message: 'Internal Server Error' });
      }
      res.writeHead(reply.status, {
        'content-type': reply.contentType,
        'content-length': reply.body.length,
        ...reply.headers,
      });
      res.end(reply.body);
    })().catch((error: unknown) => {
      try {
        process.stderr.write(`[forge] fatal handler error: ${error instanceof Error ? error.message : String(error)}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({ message: 'Internal Server Error' }));
        }
      } catch {
        // Nothing left to do: the socket is gone.
      }
    });
  });
}
