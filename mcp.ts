// mcp.ts — the Model Context Protocol surface: POST /mcp, JSON-RPC 2.0 over
// streamable HTTP with plain JSON responses (no SSE).
//
// Behaviour the suite pins down (from checks-mcp.ts / mcp-client.ts):
//   - Bearer token required on every POST; tools/call without one is HTTP 401.
//   - connect() probes `server/discover` first: a JSON-RPC error -32601 with
//     HTTP 200 sends it down the legacy path (initialize with the 2025-11-25 /
//     2025-06-18 / 2025-03-26 / 2024-11-05 revisions, then notifications/initialized).
//     A 401/403/5xx or a 404/405 on discover fails connect outright — so discover
//     answers -32601 with HTTP 200, never anything else.
//   - initialize echoes the offered protocolVersion; notifications/initialized is
//     HTTP 202 with an empty body; no session id is handed out.
//   - tools/list answers the same six tools, byte-identical across calls; every
//     tool has a non-empty description and inputSchema.type === 'object', and its
//     required properties are only ones the suite can fill.
//   - tools/call results are text blocks (plus optional structuredContent); an
//     unknown tool is -32602 or -32601 (never HTTP 500); a non-JSON body is HTTP
//     400 with -32700 and an `id` field; missing required args are isError:true.

import { Forge, tokenValid } from './store.ts';

export interface McpRequest {
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface McpReply {
  status: number;
  contentType: string;
  body: Buffer;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const stringProp = (description: string): { type: 'string'; description: string } => ({ type: 'string', description });

/** The six tools, defined once so tools/list is byte-identical across calls. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: { name: stringProp('The name of the repository to create.') },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The login of the repository owner.'),
        repo: stringProp('The name of the repository.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The login of the repository owner.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the issue.'),
        body: stringProp('The body of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The login of the repository owner.'),
        repo: stringProp('The name of the repository.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The login of the repository owner.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the pull request.'),
        head: stringProp('The head branch (with the changes).'),
        base: stringProp('The base branch (to merge into).'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The login of the repository owner.'),
        repo: stringProp('The name of the repository.'),
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function jsonRpcResult(id: unknown, result: unknown): McpReply {
  return {
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), 'utf8'),
  };
}

function jsonRpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), 'utf8'),
  };
}

function toolResult(text: string, structured?: unknown, isError = false): Record<string, unknown> {
  const result: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (structured !== undefined) result.structuredContent = structured;
  if (isError) result.isError = true;
  return result;
}

function errorResult(message: string): Record<string, unknown> {
  return toolResult(message, undefined, true);
}

/** Pick the first present argument among synonyms (the suite maps several names). */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoName = arg(args, 'name', 'repo', 'repository') as string | undefined;
    if (repoName === undefined) return errorResult('Missing required argument: name');
    const repo = forge.createRepo(repoName, '', false);
    if (repo === null) return errorResult(`Repository '${repoName}' already exists`);
    const payload = { name: repo.name, id: repo.databaseId, databaseId: repo.databaseId, full_name: repo.fullName, default_branch: repo.defaultBranch };
    return toolResult(JSON.stringify(payload), payload);
  }
  if (name === 'get_repo') {
    const owner = arg(args, 'owner', 'owner_login', 'ownerLogin') as string | undefined;
    const repoName = arg(args, 'repo', 'repo_name', 'name', 'full_name') as string | undefined;
    if (owner === undefined) return errorResult('Missing required argument: owner');
    if (repoName === undefined) return errorResult('Missing required argument: repo');
    const cleanName = repoName.includes('/') ? repoName.split('/')[1] : repoName;
    const repo = forge.getRepo(owner, cleanName);
    if (repo === undefined) return errorResult(`Repository '${owner}/${cleanName}' not found`);
    const payload = forge.repoJson(repo);
    return toolResult(JSON.stringify(payload), payload);
  }
  if (name === 'create_issue') {
    const owner = arg(args, 'owner', 'owner_login') as string | undefined;
    const repoName = arg(args, 'repo', 'repo_name', 'name') as string | undefined;
    const title = arg(args, 'title') as string | undefined;
    if (owner === undefined) return errorResult('Missing required argument: owner');
    if (repoName === undefined) return errorResult('Missing required argument: repo');
    if (title === undefined) return errorResult('Missing required argument: title');
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return errorResult(`Repository '${owner}/${repoName}' not found`);
    const body = (arg(args, 'body') as string | undefined) ?? '';
    const issue = forge.createIssue(repo, title, body, []);
    if ('error' in issue) return errorResult(issue.error);
    const payload = { number: issue.number, id: issue.id, title: issue.title, body: issue.body, state: issue.state };
    return toolResult(JSON.stringify(payload), payload);
  }
  if (name === 'list_issues') {
    const owner = arg(args, 'owner', 'owner_login') as string | undefined;
    const repoName = arg(args, 'repo', 'repo_name', 'name') as string | undefined;
    if (owner === undefined) return errorResult('Missing required argument: owner');
    if (repoName === undefined) return errorResult('Missing required argument: repo');
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return errorResult(`Repository '${owner}/${repoName}' not found`);
    const payload = repo.issues.map((issue) => ({ number: issue.number, id: issue.id, title: issue.title, body: issue.body, state: issue.state }));
    return toolResult(JSON.stringify(payload), { issues: payload });
  }
  if (name === 'create_pull_request') {
    const owner = arg(args, 'owner', 'owner_login') as string | undefined;
    const repoName = arg(args, 'repo', 'repo_name', 'name') as string | undefined;
    const title = arg(args, 'title') as string | undefined;
    const head = arg(args, 'head', 'head_branch', 'headRef', 'head_ref') as string | undefined;
    const base = arg(args, 'base', 'base_branch', 'baseRef', 'base_ref') as string | undefined;
    if (owner === undefined) return errorResult('Missing required argument: owner');
    if (repoName === undefined) return errorResult('Missing required argument: repo');
    if (title === undefined) return errorResult('Missing required argument: title');
    if (head === undefined) return errorResult('Missing required argument: head');
    if (base === undefined) return errorResult('Missing required argument: base');
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return errorResult(`Repository '${owner}/${repoName}' not found`);
    const pull = forge.createPull(repo, title, '', head, base);
    if ('error' in pull) {
      const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (duplicate === undefined) return errorResult(pull.error);
      const payload = { number: duplicate.number, id: duplicate.id, title: duplicate.title, state: duplicate.state, head: duplicate.headRef, base: duplicate.baseRef };
      return toolResult(JSON.stringify(payload), payload);
    }
    const payload = { number: pull.number, id: pull.id, title: pull.title, state: pull.state, head: pull.headRef, base: pull.baseRef };
    return toolResult(JSON.stringify(payload), payload);
  }
  if (name === 'merge_pull_request') {
    const owner = arg(args, 'owner', 'owner_login') as string | undefined;
    const repoName = arg(args, 'repo', 'repo_name', 'name') as string | undefined;
    const pullNumber = arg(args, 'pull_number', 'pullNumber', 'number', 'pull_request_number') as number | string | undefined;
    if (owner === undefined) return errorResult('Missing required argument: owner');
    if (repoName === undefined) return errorResult('Missing required argument: repo');
    if (pullNumber === undefined) return errorResult('Missing required argument: pull_number');
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return errorResult(`Repository '${owner}/${repoName}' not found`);
    const pull = forge.getPull(repo, Number(pullNumber));
    if (pull === undefined) return errorResult(`Pull request #${pullNumber} not found`);
    const result = forge.mergePull(repo, pull);
    if (!result.ok) return errorResult(result.message);
    const payload = { number: pull.number, merged: true, sha: result.sha, state: pull.state };
    return toolResult(JSON.stringify(payload), payload);
  }
  return toolResult(`Unknown tool: ${name}`, undefined, true);
}

/** Handle POST /mcp. */
export function handleMcp(forge: Forge, req: McpRequest): McpReply {
  if (!tokenValid(req.headers.authorization ?? req.headers.Authorization)) {
    return jsonRpcError(null, -32000, 'unauthorized', 401);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return jsonRpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return jsonRpcError(null, -32600, 'Invalid Request', 400);
  }
  const request = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = request.id ?? null;
  const method = request.method;
  if (typeof method !== 'string') {
    return jsonRpcError(id, -32600, 'Invalid Request: missing method');
  }
  if (method === 'notifications/initialized') {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
  }
  if (method === 'server/discover') {
    // No modern discovery: the client falls back to the legacy initialize flow.
    return jsonRpcError(id, -32601, 'Method not found: server/discover');
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as { protocolVersion?: unknown };
    const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
    return jsonRpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== 'string') {
      return jsonRpcError(id, -32602, 'Invalid params: tools/call needs a tool name');
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return jsonRpcError(id, -32602, 'Invalid params: tools/call arguments must be an object');
    }
    const result = callTool(forge, params.name, args);
    // An unknown tool is a JSON-RPC error, never HTTP 500; a known tool that
    // fails reports isError inside its result.
    const known = TOOLS.some((tool) => tool.name === params.name);
    if (!known) return jsonRpcError(id, -32602, `Unknown tool: ${params.name}`);
    return jsonRpcResult(id, result);
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}
