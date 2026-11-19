// store.ts — the forge's whole state and every domain operation the four surfaces
// share (git, REST, GraphQL, MCP). One in-memory store, no disk, no clock: every
// timestamp comes from a logical counter, so two runs with the same requests make
// the same state.
//
// The viewer is the login the trial's token names. The scenario seed is fixed by
// the contest (wire.ts SCENARIO_SEED), so the viewer login is a constant:
// generateUsers(scenarioRng('users'), 12)[0] is adaiversen (id 1000).

import {
  ZERO_OID,
  buildTree,
  collectClosure,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  sha1Object,
  walkCommits,
  type GitObj,
  type ObjectGetter,
  type TreeEntry,
} from './gitcore.ts';

/** The login the bearer token names (the scenario's fixed viewer). */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The bearer token the entry accepts, from the trial's environment. */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Whether an Authorization header carries the trial's token. */
export function tokenValid(auth: string | undefined | null): boolean {
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length);
  if (token === '') return false;
  // Without the env var (a local run) any non-empty token is the viewer.
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

/** The logical clock's epoch: 2026-11-14T10:00:00Z, the competition's opening. */
export const EPOCH_SEC = Math.floor(Date.UTC(2026, 10, 14, 10, 0, 0) / 1000);

/** Base64url (no padding) of a UTF-8 string: the opaque global ids. */
export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a global id made by b64url, or null when it is not one. */
export function unb64url(value: string): string | null {
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdTick: number;
  updatedTick: number;
  /** The serialised REST body, cached so the read workload is one Map lookup. */
  json: string;
  jsonLen: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  createdTick: number;
  updatedTick: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  databaseId: number;
  /** The opaque global id: the same string REST and GraphQL answer. */
  gid: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
}

/** Count the lines of a text blob (a trailing newline does not add a line). */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** The forge: every object, repository, issue and pull request, in memory. */
export class Forge {
  objects = new Map<string, GitObj>();
  repos = new Map<string, Repo>();
  /** Logical clock: +1 per mutation; timestamps are EPOCH_SEC + tick. */
  tick = 0;
  reqSeq = 0;
  private repoSeq = 0;
  private dbIdSeq = 0;
  private issueIdSeq = 0;
  private pullIdSeq = 0;

  /** Advance the logical clock and answer the new tick. */
  nextTick(): number {
    this.tick += 1;
    return this.tick;
  }

  /** An ISO timestamp for a tick (the logical clock, never the wall clock). */
  isoAt(tick: number): string {
    return new Date((EPOCH_SEC + tick) * 1000).toISOString();
  }

  /** A request id: a counter, so replies are deterministic in shape. */
  nextRequestId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq}`;
  }

  getObject: ObjectGetter = (oid: string) => this.objects.get(oid);

  putObject(type: GitObj['type'], data: Buffer): string {
    const oid = sha1Object(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  // ------------------------------------------------------------ repositories

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Forge.repoKey(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = Forge.repoKey(VIEWER.login, name);
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    this.dbIdSeq += 1;
    const repo: Repo = {
      owner: VIEWER.login,
      name,
      fullName: key,
      description,
      isPrivate,
      defaultBranch: 'main',
      databaseId: this.dbIdSeq,
      gid: b64url(`repo:${key}`),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: this.repoSeq,
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(Forge.repoKey(repo.owner, repo.name));
  }

  /** The REST view of a repository. */
  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.gid,
      databaseId: repo.databaseId,
      node_id: repo.gid,
      name: repo.name,
      full_name: repo.fullName,
      owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      has_issues: true,
      has_pull_requests: true,
      fork: false,
      created_at: this.isoAt(1),
      updated_at: this.isoAt(Math.max(1, this.tick)),
    };
  }

  /** The viewer's repositories in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === VIEWER.login)
      .sort((a, b) => a.seq - b.seq);
  }

  // ------------------------------------------------------------ git objects

  /** One commit object, built from the logical clock; returns its oid. */
  makeCommit(treeOid: string, parents: readonly string[], message: string): string {
    const tick = this.nextTick();
    const stamp = EPOCH_SEC + tick;
    const ident = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
    const text = `tree ${treeOid}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
    return this.putObject('commit', Buffer.from(text, 'utf8'));
  }

  /** The root tree oid of a commit, or null. */
  treeOf(commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Resolve a ref-ish to a commit oid: branch name, full ref, or an oid itself. */
  resolveRef(repo: Repo, ref?: string): string | null {
    if (ref === undefined || ref === '') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const object = this.objects.get(ref);
    return object !== undefined && object.type === 'commit' ? ref : null;
  }

  /** The flat path map of a tree: path -> {oid, mode}. */
  flattenTree(treeOid: string | null): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (treeOid === null) return out;
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Set (or replace) one file in a tree, creating intermediate trees; returns the new root tree oid. */
  setInTree(treeOid: string | null, path: string, blobOid: string): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (oid: string | null, depth: number): string => {
      const entries: TreeEntry[] = [];
      if (oid !== null) {
        const object = this.objects.get(oid);
        if (object !== undefined && object.type === 'tree') entries.push(...parseTree(object.data));
      }
      const name = segments[depth] as string;
      if (depth === segments.length - 1) {
        const at = entries.findIndex((e) => e.name === name);
        const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
        if (at >= 0) entries[at] = entry;
        else entries.push(entry);
      } else {
        const at = entries.findIndex((e) => e.name === name);
        const child = at >= 0 ? entries[at] : undefined;
        const next = build(child !== undefined && child.mode === '40000' ? child.oid : null, depth + 1);
        const entry: TreeEntry = { mode: '40000', name, oid: next };
        if (at >= 0) entries[at] = entry;
        else entries.push(entry);
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build(treeOid, 0);
  }

  /** Remove one file from a tree (dropping directories left empty); returns the new root tree oid. */
  deleteInTree(treeOid: string | null, path: string): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (oid: string | null, depth: number): string | null => {
      if (oid === null) return null;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return null;
      const entries = parseTree(object.data);
      const name = segments[depth] as string;
      const at = entries.findIndex((e) => e.name === name);
      if (at < 0) return oid;
      if (depth === segments.length - 1) {
        entries.splice(at, 1);
      } else {
        const child = entries[at] as TreeEntry;
        if (child.mode !== '40000') return oid;
        const next = build(child.oid, depth + 1);
        if (next === null || next === child.oid) return oid;
        const sub = this.objects.get(next);
        if (sub !== undefined && sub.type === 'tree' && parseTree(sub.data).length === 0) entries.splice(at, 1);
        else entries[at] = { mode: '40000', name, oid: next };
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build(treeOid, 0) ?? this.putObject('tree', buildTree([]));
  }

  /** Build a tree from a flat path map (used by the squash merge). */
  treeFromFlat(flat: Map<string, { oid: string; mode: string }>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, value] of flat) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: value.mode, name: rest, oid: value.oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build('');
  }

  // ------------------------------------------------------------ issues

  /** The REST view of an issue (also what the cache holds). */
  issueView(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { name, color: label?.color ?? 'ededed' };
      }),
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      created_at: this.isoAt(issue.createdTick),
      updated_at: this.isoAt(issue.updatedTick),
    };
  }

  refreshIssueJson(repo: Repo, issue: Issue): void {
    const text = JSON.stringify(this.issueView(repo, issue));
    issue.json = text;
    issue.jsonLen = Buffer.byteLength(text);
  }

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue | { error: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: `Label '${name}' does not exist` };
    }
    const tick = this.nextTick();
    this.issueIdSeq += 1;
    const issue: Issue = {
      id: this.issueIdSeq,
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdTick: tick,
      updatedTick: tick,
      json: '',
      jsonLen: 0,
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    this.refreshIssueJson(repo, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  /** Append a comment to an issue (advances the logical clock, refreshes the cache). */
  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const tick = this.nextTick();
    const comment: IssueComment = { id: repo.nextComment, body, seq: tick };
    repo.nextComment += 1;
    issue.comments.push(comment);
    issue.updatedTick = tick;
    this.refreshIssueJson(repo, issue);
    return comment;
  }

  /** Set an issue's state ('open' | 'closed'), refreshing the cached REST body. */
  setIssueState(repo: Repo, issue: Issue, state: 'open' | 'closed'): void {
    issue.state = state;
    issue.updatedTick = this.nextTick();
    this.refreshIssueJson(repo, issue);
  }

  // ------------------------------------------------------------ pull requests

  /** The REST view of a pull request (head/base shas read live, falling back to creation time). */
  pullView(repo: Repo, pull: Pull): Record<string, unknown> {
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate;
    return {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      created_at: this.isoAt(pull.createdTick),
      updated_at: this.isoAt(pull.updatedTick),
    };
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    if (headSha === undefined) return { error: `Head branch '${head}' does not exist` };
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (baseSha === undefined) return { error: `Base branch '${base}' does not exist` };
    const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (duplicate !== undefined) return { error: `A pull request already exists for ${head} into ${base}` };
    const tick = this.nextTick();
    this.pullIdSeq += 1;
    const pull: Pull = {
      id: this.pullIdSeq,
      number: repo.nextPull,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headShaAtCreate: headSha,
      baseShaAtCreate: baseSha,
      createdTick: tick,
      updatedTick: tick,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** MERGEABLE when the three-way merge is clean, CONFLICTING otherwise. */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    return this.mergeConflict(repo, headTip, baseTip) === null ? 'MERGEABLE' : 'CONFLICTING';
  }

  /**
   * The conflicting paths of a three-way merge (headTip onto baseTip), or null when
   * the merge is clean. A path conflicts when both sides changed it differently
   * since the merge-base.
   */
  mergeConflict(repo: Repo, headTip: string, baseTip: string): string[] | null {
    const base = mergeBase(this.getObject, headTip, baseTip);
    const baseTree = base === null ? null : this.treeOf(base);
    const headTree = this.treeOf(headTip);
    const baseTipTree = this.treeOf(baseTip);
    const orig = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const tip = this.flattenTree(baseTipTree);
    const conflicts: string[] = [];
    const paths = new Set<string>([...orig.keys(), ...head.keys(), ...tip.keys()]);
    for (const path of paths) {
      const o = orig.get(path)?.oid;
      const h = head.get(path)?.oid;
      const t = tip.get(path)?.oid;
      const changedHead = h !== o;
      const changedTip = t !== o;
      if (changedHead && changedTip && h !== t) conflicts.push(path);
    }
    return conflicts.length === 0 ? null : conflicts.sort();
  }

  /**
   * Squash-merge a pull request onto its base branch: one new commit whose tree is
   * the three-way result and whose parent is the base tip. Returns the merge commit
   * oid, or null with a reason when the merge cannot run.
   */
  mergePull(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; status: number; message: string } {
    if (pull.merged || pull.state !== 'open') {
      return { ok: false, status: 405, message: 'Pull request is already merged' };
    }
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) {
      return { ok: false, status: 422, message: 'Head or base branch does not exist' };
    }
    const conflicts = this.mergeConflict(repo, headTip, baseTip);
    if (conflicts !== null) {
      return { ok: false, status: 405, message: `Merge conflict in ${conflicts.join(', ')}` };
    }
    const base = mergeBase(this.getObject, headTip, baseTip);
    const orig = this.flattenTree(base === null ? null : this.treeOf(base));
    const head = this.flattenTree(this.treeOf(headTip));
    const tip = this.flattenTree(this.treeOf(baseTip));
    const merged = new Map(tip);
    for (const [path, value] of head) {
      if (orig.get(path)?.oid !== value.oid) merged.set(path, value);
    }
    // Paths the head deleted (present in the base, absent in the head, unchanged
    // on the base side — a base-side change there would already be a conflict).
    for (const path of [...orig.keys()]) {
      if (!head.has(path) && tip.get(path)?.oid === orig.get(path)?.oid) merged.delete(path);
    }
    const tree = this.treeFromFlat(merged);
    const sha = this.makeCommit(tree, [baseTip], `Merge pull request #${pull.number} — ${pull.title}`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    const tick = this.nextTick();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.isoAt(tick);
    pull.mergeCommitSha = sha;
    pull.updatedTick = tick;
    return { ok: true, sha };
  }

  /** The changed files of a pull request: base tip tree vs head tip tree. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const head = this.flattenTree(headTip === undefined ? null : this.treeOf(headTip));
    const base = this.flattenTree(baseTip === undefined ? null : this.treeOf(baseTip));
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) {
        const text = this.objectText(h.oid);
        const additions = lineCount(text);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const text = this.objectText(b.oid);
        const deletions = lineCount(text);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const additions = lineCount(this.objectText(h.oid));
        const deletions = lineCount(this.objectText(b.oid));
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** A blob's text, or '' when the object is missing or not a blob. */
  objectText(oid: string): string {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  // ------------------------------------------------------------ contents

  /** The tree entries of a directory path, or null when the path is not a directory. */
  dirEntries(repo: Repo, ref: string | undefined, dirPath: string): Array<{ type: string; name: string; path: string; sha: string; size?: number }> | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const root = this.treeOf(tip);
    if (root === null) return null;
    let oid: string | null = root;
    const segments = dirPath.split('/').filter((s) => s !== '');
    for (const segment of segments) {
      const obj: GitObj | undefined = oid === null ? undefined : this.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return null;
      const entry: TreeEntry | undefined = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
      if (entry === undefined) return null;
      oid = entry.oid;
    }
    const obj: GitObj | undefined = oid === null ? undefined : this.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return null;
    const out: Array<{ type: string; name: string; path: string; sha: string; size?: number }> = [];
    for (const entry of parseTree(obj.data)) {
      const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
      if (entry.mode === '40000') out.push({ type: 'dir', name: entry.name, path, sha: entry.oid });
      else {
        const blob = this.objects.get(entry.oid);
        out.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 });
      }
    }
    return out;
  }

  /** Read one path at a ref: a file's blob, a directory's entries, or null. */
  readPath(
    repo: Repo,
    ref: string | undefined,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ type: string; name: string; path: string; sha: string; size?: number }> } | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const root = this.treeOf(tip);
    if (root === null) return null;
    if (path === '') {
      const entries = this.dirEntries(repo, ref, '');
      return entries === null ? null : { kind: 'dir', entries };
    }
    const flat = this.flattenTree(root);
    const file = flat.get(path);
    if (file !== undefined) {
      const blob = this.objects.get(file.oid);
      if (blob === undefined || blob.type !== 'blob') return null;
      return { kind: 'file', oid: file.oid, data: blob.data };
    }
    const entries = this.dirEntries(repo, ref, path);
    if (entries !== null) return { kind: 'dir', entries };
    return null;
  }

  /** Write one file (create or update) and commit it; creates the branch when missing. */
  putFile(
    repo: Repo,
    path: string,
    contentB64: string,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { status: 200 | 201 | 409 | 422; contentSha?: string; commitSha?: string; message?: string } {
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return { status: 422, message: 'content is not valid base64' };
    }
    const branchName = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branchName}`;
    let tip = repo.refs.get(refName);
    if (tip === undefined && branch !== undefined) {
      // A new branch starts at the default branch's tip (or unborn).
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? undefined;
    }
    const root = tip === undefined ? null : this.treeOf(tip);
    const flat = this.flattenTree(root);
    const existing = flat.get(path);
    if (sha !== undefined && sha !== '') {
      if (existing === undefined || existing.oid.toLowerCase() !== sha.toLowerCase()) {
        return { status: 409, message: 'sha does not match the current file' };
      }
    }
    const isUpdate = existing !== undefined;
    const blobOid = this.putObject('blob', content);
    const tree = this.setInTree(root, path, blobOid);
    const commit = this.makeCommit(tree, tip === undefined ? [] : [tip], message);
    repo.refs.set(refName, commit);
    return { status: isUpdate ? 200 : 201, contentSha: blobOid, commitSha: commit };
  }

  /** Delete one file and commit it on the default branch. */
  deleteFile(
    repo: Repo,
    path: string,
    message: string,
    sha: string | undefined,
  ): { status: 200 | 404 | 409; commitSha?: string; message?: string } {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (tip === undefined) return { status: 404, message: 'Not Found' };
    const root = this.treeOf(tip);
    const flat = this.flattenTree(root);
    const existing = flat.get(path);
    if (existing === undefined) return { status: 404, message: 'Not Found' };
    if (sha !== undefined && sha !== '' && existing.oid.toLowerCase() !== sha.toLowerCase()) {
      return { status: 409, message: 'sha does not match the current file' };
    }
    const tree = this.deleteInTree(root, path);
    const commit = this.makeCommit(tree, [tip], message);
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
    return { status: 200, commitSha: commit };
  }

  // ------------------------------------------------------------ global ids

  /** Decode a global id into its entity, or null. */
  decodeGlobalId(id: string): { kind: 'repo'; repo: Repo } | { kind: 'issue'; repo: Repo; issue: Issue } | { kind: 'pull'; repo: Repo; pull: Pull } | null {
    const text = unb64url(id);
    if (text === null) return null;
    const repoMatch = /^repo:(.+)\/(.+)$/.exec(text);
    if (repoMatch !== null) {
      const repo = this.getRepo(repoMatch[1] as string, repoMatch[2] as string);
      return repo === undefined ? null : { kind: 'repo', repo };
    }
    const issueMatch = /^issue:(.+)\/(.+)\/(\d+)$/.exec(text);
    if (issueMatch !== null) {
      const repo = this.getRepo(issueMatch[1] as string, issueMatch[2] as string);
      if (repo === undefined) return null;
      const issue = this.getIssue(repo, Number(issueMatch[3]));
      return issue === undefined ? null : { kind: 'issue', repo, issue };
    }
    const pullMatch = /^pr:(.+)\/(.+)\/(\d+)$/.exec(text);
    if (pullMatch !== null) {
      const repo = this.getRepo(pullMatch[1] as string, pullMatch[2] as string);
      if (repo === undefined) return null;
      const pull = this.getPull(repo, Number(pullMatch[3]));
      return pull === undefined ? null : { kind: 'pull', repo, pull };
    }
    return null;
  }

  repoGlobalId(repo: Repo): string {
    return repo.gid;
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return b64url(`issue:${repo.fullName}/${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return b64url(`pr:${repo.fullName}/${pull.number}`);
  }

  // ------------------------------------------------------------ helpers for the git surface

  /** The ref list of a repository, sorted by name (HEAD excluded; ls-refs adds it). */
  refList(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The peeled commit of a ref: for an annotated tag, its target commit. */
  peelRef(repo: Repo, oid: string): string | null {
    const object = this.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      return tag.type === 'commit' ? tag.object : null;
    }
    return null;
  }

  /** The closure of objects reachable from `roots`, as GitObjs in deterministic order. */
  closureObjects(roots: readonly string[]): GitObj[] {
    const oids = [...collectClosure(this.getObject, roots)].sort();
    const out: GitObj[] = [];
    for (const oid of oids) {
      const object = this.objects.get(oid);
      if (object !== undefined) out.push(object);
    }
    return out;
  }

  /** Whether `newOid` is a fast-forward from `oldOid` (or a create from nothing). */
  isFastForward(oldOid: string, newOid: string): boolean {
    if (oldOid === ZERO_OID) return true;
    return isAncestor(this.getObject, oldOid, newOid);
  }

  /**
   * Whether an oid's direct references resolve: a commit's tree and parents, a
   * tag's target. The suite only ever pushes complete packs, so a full transitive
   * closure walk per push would be O(history) for nothing; one level catches a
   * pack that is missing the objects its new tip names outright.
   */
  refsComplete(oid: string): boolean {
    const object = this.objects.get(oid);
    if (object === undefined) return false;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree !== '' && !this.objects.has(commit.tree)) return false;
      for (const parent of commit.parents) if (!this.objects.has(parent)) return false;
      return true;
    }
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      return tag.object === '' || this.objects.has(tag.object);
    }
    return true;
  }
}
