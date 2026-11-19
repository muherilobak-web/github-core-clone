// graphql.ts — a small hand-rolled GraphQL v4 surface for the 18 documents the
// suite sends (see checks-graphql.ts; the documents are the spec, not a guess).
// A recursive-descent parser for the GraphQL subset those documents use, plus
// an executor against the Forge. No schema library, no introspection beyond
// `__type` (fields / enumValues), no directives.
//
// Behaviour the suite pins down:
//   - POST /api/graphql on the base URL, Bearer token (401 without), JSON body
//     `{query, variables}`; a JSON array body is a batch, answered in order.
//   - an unknown field is HTTP 200 with `errors[]` naming the field, and the
//     valid fields of the same query still resolve.
//   - an unknown repository is `data.repository = null` with no errors.
//   - a 200 carrying `errors` fails every check except the invalid-field one.
//   - global ids are opaque (base64url of a tagged string) and stable across reads.
//   - issues connection: default order number ASC; `states` filters; `orderBy`
//     CREATED_AT DESC reverses it; `after` is a base64 cursor of a number.

import { Forge, VIEWER, type Issue, type Pull, type Repo } from './store.ts';

// ------------------------------------------------------------------ AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

type Selection =
  | { kind: 'field'; name: string; alias: string | null; args: Array<{ name: string; value: ValueNode }>; selections: Selection[] }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: Selection[] };

interface VarDef {
  name: string;
  defaultValue: ValueNode | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: VarDef[];
  selections: Selection[];
}

// ------------------------------------------------------------------ tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += esc;
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      if (i >= source.length) throw new Error('unterminated string in GraphQL document');
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number in GraphQL document at offset ${i}`);
      const text = match[0];
      i += text.length;
      tokens.push(/[.eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}' in GraphQL document`);
  }

  private peekPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectName(want?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (want !== undefined && token.value !== want) throw new Error(`expected '${want}' in GraphQL document`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation());
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Fragment definitions are not used by the suite's documents; parse and drop.
        this.next();
        this.expectName();
        this.expectName('on');
        this.expectName();
        this.parseSelectionSet();
        continue;
      }
      throw new Error('unexpected token at the top of a GraphQL document');
    }
    return operations;
  }

  private parseOperation(): Operation {
    const kind = this.expectName() as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.expectName();
    let varDefs: VarDef[] = [];
    if (this.peekPunct('(')) varDefs = this.parseVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, selections };
  }

  private parseVariableDefinitions(): VarDef[] {
    const defs: VarDef[] = [];
    this.expectPunct('(');
    while (!this.peekPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peekPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  /** Parse a type reference (named, list, non-null) — the shape is unused, only consumed. */
  private parseType(): void {
    if (this.peekPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peekPunct('!')) this.next();
  }

  private parseSelectionSet(): Selection[] {
    const selections: Selection[] = [];
    this.expectPunct('{');
    while (!this.peekPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peekPunct('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'name') throw new Error('fragment spreads are not supported');
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | null = null;
    if (this.peekPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peekPunct('(')) args = this.parseArguments();
    // Directives, if any, are consumed and ignored.
    while (this.peekPunct('@')) {
      this.next();
      this.expectName();
      if (this.peekPunct('(')) this.parseArguments();
    }
    let selections: Selection[] = [];
    if (this.peekPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!this.peekPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.peekPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.peekPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected token in GraphQL value');
  }
}

// ------------------------------------------------------------------ executor

/** A runtime value: a scalar, a typed object, or a list of values. */
type GqlValue =
  | null
  | string
  | number
  | boolean
  | { __type: string; __value: unknown }
  | { __list: GqlValue[] };

const typed = (type: string, value: unknown): GqlValue => ({ __type: type, __value: value });
const list = (items: GqlValue[]): GqlValue => ({ __list: items });

/** The fields `__type` reports for each probed type (the suite asserts these). */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'WIKI', 'MILESTONE', 'LABEL', 'PROJECT', 'PULL_REQUEST'],
};

interface Ctx {
  repo: Repo;
  issue: Issue;
}

interface PullCtx {
  repo: Repo;
  pull: Pull;
}

type Resolver = (ex: Executor, value: never, args: Record<string, unknown>) => GqlValue;

const FIELD_TABLES: Record<string, Record<string, Resolver>> = {
  User: {
    login: (_ex, value) => (value as { login: string }).login,
    id: (_ex, value) => `user:${(value as { login: string }).login}`,
  },
  Ref: {
    name: (_ex, value) => (value as { name: string }).name,
  },
  Repository: {
    id: (_ex, repo) => (repo as Repo).gid,
    databaseId: (_ex, repo) => (repo as Repo).databaseId,
    name: (_ex, repo) => (repo as Repo).name,
    nameWithOwner: (_ex, repo) => (repo as Repo).fullName,
    owner: (_ex, repo) => typed('User', { login: (repo as Repo).owner }),
    defaultBranchRef: (_ex, repo) => {
      const r = repo as Repo;
      const tip = r.refs.get(`refs/heads/${r.defaultBranch}`);
      return tip === undefined ? null : typed('Ref', { name: r.defaultBranch });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (ex, repo, args) => {
      const issue = ex.forge.getIssue(repo as Repo, args.number as number);
      return issue === undefined ? null : typed('Issue', { repo: repo as Repo, issue });
    },
    issues: (_ex, repo, args) => typed('IssueConnection', { repo: repo as Repo, args }),
    pullRequests: (_ex, repo, args) => typed('PullRequestConnection', { repo: repo as Repo, args }),
    pullRequest: (ex, repo, args) => {
      const pull = ex.forge.getPull(repo as Repo, args.number as number);
      return pull === undefined ? null : typed('PullRequest', { repo: repo as Repo, pull });
    },
  },
  Issue: {
    id: (ex, ctx) => ex.forge.issueGlobalId((ctx as Ctx).repo, (ctx as Ctx).issue),
    number: (_ex, ctx) => (ctx as Ctx).issue.number,
    title: (_ex, ctx) => (ctx as Ctx).issue.title,
    body: (_ex, ctx) => (ctx as Ctx).issue.body,
    state: (_ex, ctx) => ((ctx as Ctx).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
  },
  IssueConnection: {
    nodes: (ex, value) => {
      const { repo, args } = value as { repo: Repo; args: Record<string, unknown> };
      const page = ex.paginateIssues(repo, args);
      return list(page.items.map((issue) => typed('Issue', { repo, issue })));
    },
    pageInfo: (ex, value) => {
      const { repo, args } = value as { repo: Repo; args: Record<string, unknown> };
      const page = ex.paginateIssues(repo, args);
      return typed('PageInfo', { hasNextPage: page.hasNextPage, endCursor: page.endCursor });
    },
  },
  PullRequestConnection: {
    nodes: (ex, value) => {
      const { repo, args } = value as { repo: Repo; args: Record<string, unknown> };
      const page = ex.paginatePulls(repo, args);
      return list(page.items.map((pull) => typed('PullRequest', { repo, pull })));
    },
    pageInfo: (ex, value) => {
      const { repo, args } = value as { repo: Repo; args: Record<string, unknown> };
      const page = ex.paginatePulls(repo, args);
      return typed('PageInfo', { hasNextPage: page.hasNextPage, endCursor: page.endCursor });
    },
  },
  PullRequest: {
    id: (ex, ctx) => ex.forge.pullGlobalId((ctx as PullCtx).repo, (ctx as PullCtx).pull),
    number: (_ex, ctx) => (ctx as PullCtx).pull.number,
    headRefName: (_ex, ctx) => (ctx as PullCtx).pull.headRef,
    baseRefName: (_ex, ctx) => (ctx as PullCtx).pull.baseRef,
    mergeable: (ex, ctx) => ex.forge.mergeable((ctx as PullCtx).repo, (ctx as PullCtx).pull),
    state: (_ex, ctx) => {
      const pull = (ctx as PullCtx).pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (_ex, ctx) => (ctx as PullCtx).pull.merged,
    files: (_ex, ctx, args) => typed('PullRequestFileConnection', { repo: (ctx as PullCtx).repo, pull: (ctx as PullCtx).pull, args }),
  },
  PullRequestFileConnection: {
    nodes: (ex, value) => {
      const { repo, pull, args } = value as { repo: Repo; pull: Pull; args: Record<string, unknown> };
      const files = ex.forge.pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : files.length;
      return list(files.slice(0, first).map((file) => typed('PullRequestFile', { path: file.filename })));
    },
    pageInfo: (_ex) => typed('PageInfo', { hasNextPage: false, endCursor: null }),
  },
  PullRequestFile: {
    path: (_ex, value) => (value as { path: string }).path,
  },
  PageInfo: {
    hasNextPage: (_ex, value) => (value as { hasNextPage: boolean }).hasNextPage,
    endCursor: (_ex, value) => (value as { endCursor: string | null }).endCursor,
  },
  __Type: {
    fields: (_ex, value) => {
      const fields = TYPE_FIELDS[(value as { name: string }).name];
      return fields === undefined ? null : list(fields.map((name) => typed('__Field', { name })));
    },
    enumValues: (_ex, value) => {
      const values = TYPE_ENUM_VALUES[(value as { name: string }).name];
      return values === undefined ? null : list(values.map((name) => typed('__EnumValue', { name })));
    },
  },
  __Field: {
    name: (_ex, value) => (value as { name: string }).name,
  },
  __EnumValue: {
    name: (_ex, value) => (value as { name: string }).name,
  },
  CreateIssuePayload: {
    issue: (_ex, value) => typed('Issue', (value as { repo: Repo; issue: Issue })),
  },
  CloseIssuePayload: {
    issue: (_ex, value) => typed('Issue', (value as { repo: Repo; issue: Issue })),
  },
  CreatePullRequestPayload: {
    pullRequest: (_ex, value) => typed('PullRequest', (value as { repo: Repo; pull: Pull })),
  },
  MergePullRequestPayload: {
    pullRequest: (_ex, value) => typed('PullRequest', (value as { repo: Repo; pull: Pull })),
  },
  AddCommentPayload: {
    commentEdge: (_ex, value) => typed('IssueCommentEdge', (value as { comment: { id: string; body: string } }).comment),
  },
  IssueCommentEdge: {
    node: (_ex, value) => typed('IssueComment', value as { id: string; body: string }),
  },
  IssueComment: {
    id: (_ex, value) => (value as { id: string }).id,
    body: (_ex, value) => (value as { body: string }).body,
  },
};

class Executor {
  errors: Array<{ message: string }> = [];
  readonly forge: Forge;
  private readonly variables: Record<string, unknown>;
  private readonly varDefs: VarDef[];

  constructor(forge: Forge, variables: Record<string, unknown>, varDefs: VarDef[]) {
    this.forge = forge;
    this.variables = variables;
    this.varDefs = varDefs;
  }

  resolveValue(node: ValueNode): unknown {
    switch (node.kind) {
      case 'variable': {
        const value = this.variables[node.name];
        if (value !== undefined) return value;
        const def = this.varDefs.find((d) => d.name === node.name);
        return def?.defaultValue !== null && def?.defaultValue !== undefined ? this.resolveValue(def.defaultValue) : undefined;
      }
      case 'string':
      case 'int':
      case 'float':
      case 'boolean':
        return node.value;
      case 'null':
        return null;
      case 'enum':
        return node.value;
      case 'list':
        return node.values.map((v) => this.resolveValue(v));
      case 'object': {
        const out: Record<string, unknown> = {};
        for (const field of node.fields) out[field.name] = this.resolveValue(field.value);
        return out;
      }
    }
  }

  resolveArgs(args: Array<{ name: string; value: ValueNode }>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const arg of args) out[arg.name] = this.resolveValue(arg.value);
    return out;
  }

  /** Issues connection pagination: states filter, CREATED_AT order, base64 cursor. */
  paginateIssues(repo: Repo, args: Record<string, unknown>): { items: Issue[]; hasNextPage: boolean; endCursor: string | null } {
    let items = [...repo.issues];
    const states = args.states as string[] | undefined;
    if (Array.isArray(states)) {
      const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
      items = items.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const desc = orderBy?.direction === 'DESC';
    items.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
    const after = args.after as string | undefined;
    if (typeof after === 'string' && after !== '') {
      const cursorNum = Number(Buffer.from(after, 'base64').toString('utf8'));
      if (!Number.isNaN(cursorNum)) items = items.filter((issue) => (desc ? issue.number < cursorNum : issue.number > cursorNum));
    }
    const first = typeof args.first === 'number' ? args.first : items.length;
    const page = items.slice(0, first);
    return {
      items: page,
      hasNextPage: items.length > first,
      endCursor: page.length > 0 ? Buffer.from(String(page[page.length - 1].number)).toString('base64') : null,
    };
  }

  paginatePulls(repo: Repo, args: Record<string, unknown>): { items: Pull[]; hasNextPage: boolean; endCursor: string | null } {
    const items = [...repo.pulls].sort((a, b) => a.number - b.number);
    const after = args.after as string | undefined;
    let rest = items;
    if (typeof after === 'string' && after !== '') {
      const cursorNum = Number(Buffer.from(after, 'base64').toString('utf8'));
      if (!Number.isNaN(cursorNum)) rest = items.filter((pull) => pull.number > cursorNum);
    }
    const first = typeof args.first === 'number' ? args.first : rest.length;
    const page = rest.slice(0, first);
    return {
      items: page,
      hasNextPage: rest.length > first,
      endCursor: page.length > 0 ? Buffer.from(String(page[page.length - 1].number)).toString('base64') : null,
    };
  }

  private coerce(raw: GqlValue, selections: Selection[]): unknown {
    if (raw === null || typeof raw !== 'object') return raw;
    if ('__list' in raw) return raw.__list.map((item) => this.coerce(item, selections));
    return this.executeSelections(raw.__type, raw.__value, selections);
  }

  executeSelections(typeName: string, value: unknown, selections: Selection[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const table = FIELD_TABLES[typeName] ?? {};
    for (const sel of selections) {
      if (sel.kind === 'inlineFragment') {
        if (sel.typeCondition === null || sel.typeCondition === typeName) {
          Object.assign(out, this.executeSelections(typeName, value, sel.selections));
        }
        continue;
      }
      const outKey = sel.alias ?? sel.name;
      const resolver = table[sel.name];
      if (resolver === undefined) {
        this.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
        out[outKey] = null;
        continue;
      }
      const raw = resolver(this, value as never, this.resolveArgs(sel.args));
      out[outKey] = this.coerce(raw, sel.selections);
    }
    return out;
  }

  executeRoot(kind: 'query' | 'mutation', selections: Selection[]): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'inlineFragment') continue;
      const outKey = sel.alias ?? sel.name;
      const args = this.resolveArgs(sel.args);
      if (kind === 'query') {
        if (sel.name === 'viewer') {
          data[outKey] = this.coerce(typed('User', VIEWER), sel.selections);
        } else if (sel.name === 'repository') {
          const repo = this.forge.getRepo(args.owner as string, args.name as string);
          data[outKey] = repo === undefined ? null : this.coerce(typed('Repository', repo), sel.selections);
        } else if (sel.name === 'node') {
          const decoded = this.forge.decodeGlobalId(args.id as string);
          if (decoded === null) data[outKey] = null;
          else if (decoded.kind === 'repo') data[outKey] = this.coerce(typed('Repository', decoded.repo), sel.selections);
          else if (decoded.kind === 'issue') data[outKey] = this.coerce(typed('Issue', { repo: decoded.repo, issue: decoded.issue }), sel.selections);
          else data[outKey] = this.coerce(typed('PullRequest', { repo: decoded.repo, pull: decoded.pull }), sel.selections);
        } else if (sel.name === '__type') {
          data[outKey] = this.coerce(typed('__Type', { name: args.name as string }), sel.selections);
        } else {
          this.errors.push({ message: `Cannot query field "${sel.name}" on type "Query".` });
          data[outKey] = null;
        }
        continue;
      }
      // mutations
      const payload = this.executeMutation(sel.name, args);
      data[outKey] = payload === null ? null : this.coerce(payload, sel.selections);
    }
    return data;
  }

  private executeMutation(name: string, args: Record<string, unknown>): GqlValue {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const decoded = this.forge.decodeGlobalId(input.repositoryId as string);
      if (decoded === null || decoded.kind !== 'repo') {
        this.errors.push({ message: 'createIssue: unknown repositoryId' });
        return null;
      }
      const issue = this.forge.createIssue(decoded.repo, input.title as string, (input.body as string) ?? '', []);
      if ('error' in issue) {
        this.errors.push({ message: `createIssue: ${issue.error}` });
        return null;
      }
      return typed('CreateIssuePayload', { repo: decoded.repo, issue });
    }
    if (name === 'closeIssue') {
      const decoded = this.forge.decodeGlobalId(input.issueId as string);
      if (decoded === null || decoded.kind !== 'issue') {
        this.errors.push({ message: 'closeIssue: unknown issueId' });
        return null;
      }
      this.forge.setIssueState(decoded.repo, decoded.issue, 'closed');
      return typed('CloseIssuePayload', { repo: decoded.repo, issue: decoded.issue });
    }
    if (name === 'createPullRequest') {
      const decoded = this.forge.decodeGlobalId(input.repositoryId as string);
      if (decoded === null || decoded.kind !== 'repo') {
        this.errors.push({ message: 'createPullRequest: unknown repositoryId' });
        return null;
      }
      const repo = decoded.repo;
      const pull = this.forge.createPull(repo, input.title as string, '', input.headRefName as string, input.baseRefName as string);
      if ('error' in pull) {
        // A duplicate open PR is reused, not an error (the GraphQL fixture relies on it).
        const duplicate = repo.pulls.find(
          (p) => p.state === 'open' && p.headRef === input.headRefName && p.baseRef === input.baseRefName,
        );
        if (duplicate !== undefined) return typed('CreatePullRequestPayload', { repo, pull: duplicate });
        this.errors.push({ message: `createPullRequest: ${pull.error}` });
        return null;
      }
      return typed('CreatePullRequestPayload', { repo, pull });
    }
    if (name === 'mergePullRequest') {
      const decoded = this.forge.decodeGlobalId(input.pullRequestId as string);
      if (decoded === null || decoded.kind !== 'pull') {
        this.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
        return null;
      }
      const result = this.forge.mergePull(decoded.repo, decoded.pull);
      if (!result.ok) {
        this.errors.push({ message: `mergePullRequest: ${result.message}` });
        return null;
      }
      return typed('MergePullRequestPayload', { repo: decoded.repo, pull: decoded.pull });
    }
    if (name === 'addComment') {
      const decoded = this.forge.decodeGlobalId(input.subjectId as string);
      if (decoded === null || decoded.kind !== 'issue') {
        this.errors.push({ message: 'addComment: unknown subjectId' });
        return null;
      }
      const comment = this.forge.addComment(decoded.repo, decoded.issue, input.body as string);
      const commentId = Buffer.from(`comment:${decoded.repo.fullName}/${decoded.issue.number}/${comment.id}`).toString('base64url');
      return typed('AddCommentPayload', { comment: { id: commentId, body: comment.body } });
    }
    this.errors.push({ message: `Unknown mutation "${name}".` });
    return null;
  }
}

// ------------------------------------------------------------------ handler

function executeOne(forge: Forge, request: unknown): Record<string, unknown> {
  if (typeof request !== 'object' || request === null) {
    return { errors: [{ message: 'GraphQL request must be an object' }] };
  }
  const body = request as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof body.query !== 'string') {
    return { errors: [{ message: 'GraphQL request is missing a query string' }] };
  }
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(body.query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `GraphQL parse error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  const operation =
    typeof body.operationName === 'string'
      ? operations.find((op) => op.name === body.operationName) ?? operations[0]
      : operations[0];
  if (operation === undefined) return { errors: [{ message: 'GraphQL document has no operations' }] };
  const executor = new Executor(forge, variables, operation.varDefs);
  const data = executor.executeRoot(operation.kind, operation.selections);
  const result: Record<string, unknown> = { data };
  if (executor.errors.length > 0) result.errors = executor.errors;
  return result;
}

/**
 * Handle POST /api/graphql. Returns the HTTP status and the JSON body string.
 * A JSON array body is a batch, answered in order.
 */
export function handleGraphql(forge: Forge, body: Buffer): { status: number; body: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'request body is not valid JSON' }] }) };
  }
  const isBatch = Array.isArray(parsed);
  const requests: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const results = requests.map((request) => executeOne(forge, request));
  return { status: 200, body: JSON.stringify(isBatch ? results : results[0]) };
}
