// git.ts — the git smart-HTTP surface: info/refs advertisements (v0 + v2),
// protocol v2 ls-refs/fetch, and v0 receive-pack. Plain objects only, no deltas,
// no disk: every object lives in the Forge's Map.
//
// Wire notes (from the suite's git-client.ts, the authority here):
//   - info/refs?service=git-upload-pack with `Git-Protocol: version=2` answers v2;
//     without it, v0. receive-pack is v0-only. Missing repo is 404 on both.
//   - v2 advertisement: `# service=...` + flush, `version 2`, then `key=value`
//     capability lines: ls-refs=unborn, fetch=shallow wait-for-done, object-format=sha1.
//   - ls-refs answers `<oid> <name>[ symref-target:X][ peeled:Y]` lines, or
//     `unborn <name>[ symref-target:X]`; ref-prefix filters server-side.
//   - fetch answers sections in order — acknowledgments, shallow-info, wanted-refs,
//     packfile — each a header packet, its lines, and a delim; the packfile section
//     is sideband-64k band-1 packets, each pkt-line at most 65,520 bytes.
//   - receive-pack answers report-status in sideband band 1: `unpack ok` then
//     `ok <ref>` / `ng <ref> <reason>` per command, then a flush. A refused update
//     still unpacks (its objects are stored) and reports `ng <ref> non-fast-forward`.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  collectClosure,
  parseCommit,
  parsePack,
  parsePktLines,
  parseTag,
  pkt,
  pktLines,
  sidebandPackets,
  writePack,
  type GitObj,
} from './gitcore.ts';
import { Forge, type Repo } from './store.ts';

export interface GitRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonReply(status: number, body: unknown): GitReply {
  const text = `${JSON.stringify(body)}\n`;
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

function notFound(): GitReply {
  return jsonReply(404, { message: 'Not Found' });
}

/** The repository a git path names, or null when it is not this forge's. */
function repoOf(forge: Forge, owner: string, repo: string): Repo | null {
  return forge.getRepo(owner, repo) ?? null;
}

// ---------------------------------------------------------------- advertisements

const V2_CAPABILITIES = ['ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1', 'agent=forge/1.0'];

function v2Advertisement(service: string): Buffer {
  const lines: Array<string | 'flush'> = [
    `# service=${service}\n`,
    'flush',
    'version 2\n',
    ...V2_CAPABILITIES.map((cap) => `${cap}\n`),
    'flush',
  ];
  return pktLines(lines);
}

function v0Advertisement(forge: Forge, repo: Repo, service: string, capabilities: string): Buffer {
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = forge.refList(repo);
  const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} ${capabilities}`;
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = refs.find((r) => r.name === `refs/heads/${repo.defaultBranch}`);
    const ordered = head !== undefined ? [head, ...refs.filter((r) => r !== head)] : refs;
    ordered.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pkt(line));
    });
    parts.push(pkt(`${head?.oid ?? ZERO_OID} HEAD\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack v2

/** Parse a v2 command request's pkt-lines into the command and its arguments. */
function parseV2Request(body: Buffer): { command: string; args: string[] } | null {
  const { packets } = parsePktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (command === '') {
      if (!line.startsWith('command=')) return null;
      command = line.slice('command='.length).replace(/\n$/, '');
      continue;
    }
    if (!seenDelim) continue; // agent= / object-format= lines before the delim
    args.push(line.replace(/\n$/, ''));
  }
  return command === '' ? null : { command, args };
}

/** The ref lines ls-refs answers, honouring peel/symrefs/unborn/ref-prefix. */
function lsRefsLines(forge: Forge, repo: Repo, args: readonly string[]): string[] {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const refs = forge.refList(repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
    }
    return lines;
  }
  if (keep('HEAD') && defaultTip !== undefined) {
    lines.push(`${defaultTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = forge.peelRef(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return lines;
}

interface FetchPlan {
  /** Objects to send (plain objects, already minus what the client holds). */
  send: Map<string, GitObj>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  wantedRefs: Array<{ name: string; oid: string }>;
}

/**
 * What the client already holds: the closure of its haves, except the walk
 * stops at a shallow boundary — a shallow clone holds the boundary commit, its
 * tree and its blobs, but NOT the boundary's parents (that is what makes it
 * shallow). Without the stop, a deepen fetch would subtract the whole history
 * and answer an empty pack.
 */
function collectHeld(
  get: (oid: string) => GitObj | undefined,
  haves: readonly string[],
  shallow: readonly string[],
): Set<string> {
  const boundaries = new Set(shallow);
  const held = new Set<string>();
  const seen = new Set<string>();
  const stack = [...haves, ...shallow];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = get(oid);
    if (object === undefined) continue;
    if (object.type !== 'commit') {
      for (const reachable of collectClosure(get, [oid])) held.add(reachable);
      continue;
    }
    held.add(oid);
    const commit = parseCommit(object.data);
    if (commit.tree !== '') {
      for (const reachable of collectClosure(get, [commit.tree])) held.add(reachable);
    }
    if (!boundaries.has(oid)) {
      for (const parent of commit.parents) stack.push(parent);
    }
  }
  return held;
}

/**
 * The fetch computation. Rules (from checks-git.ts):
 *   - send = closure(wants, depth) minus closure(haves ∪ old shallow boundaries)
 *   - with deepen N, the new shallow boundaries are the included commits at
 *     generation exactly N; an old boundary that is now included and is not a
 *     new boundary becomes `unshallow`
 *   - acks: each have that shares history with a want; otherwise NAK
 */
function computeFetch(forge: Forge, repo: Repo, wants: string[], haves: string[], shallow: string[], deepen: number | null): FetchPlan {
  const get = forge.getObject;
  // Resolve wants to commits (a want may name an annotated tag: peel it, and
  // remember to send the tag object itself).
  const tagObjects = new Map<string, GitObj>();
  const wantCommits: string[] = [];
  for (const want of wants) {
    const object = get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.set(want, { type: 'tag', data: object.data });
      const target = parseTag(object.data).object;
      const targetObject = get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') wantCommits.push(target);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    }
  }
  // Walk the wanted commits, counting generations (a want is generation 1).
  const generation = new Map<string, number>();
  const queue: Array<[string, number]> = wantCommits.map((oid) => [oid, 1] as [string, number]);
  while (queue.length > 0) {
    const [oid, gen] = queue.shift() as [string, number];
    if (generation.has(oid)) continue;
    if (deepen !== null && gen > deepen) continue;
    const object = get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    generation.set(oid, gen);
    if (deepen === null || gen < deepen) {
      for (const parent of parseCommit(object.data).parents) queue.push([parent, gen + 1]);
    }
  }
  const includedCommits = [...generation.keys()];
  // The send set is the included commits plus the closure of their trees
  // (trees and blobs only — never the parents: a depth limit is a limit on
  // the commits, and collectClosure would walk every ancestor).
  const send = new Map<string, GitObj>();
  for (const oid of includedCommits) {
    const object = get(oid);
    if (object === undefined) continue;
    send.set(oid, object);
    if (object.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      if (tree !== '') {
        for (const treeOid of collectClosure(get, [tree])) {
          const treeObject = get(treeOid);
          if (treeObject !== undefined) send.set(treeOid, treeObject);
        }
      }
    }
  }
  for (const [oid, tag] of tagObjects) send.set(oid, tag);
  const held = collectHeld(get, haves, shallow);
  for (const oid of held) send.delete(oid);
  // Shallow boundaries.
  const newShallow: string[] = [];
  if (deepen !== null) {
    for (const [oid, gen] of generation) if (gen === deepen) newShallow.push(oid);
  }
  const newShallowSet = new Set(newShallow);
  const unshallow = shallow.filter((oid) => generation.has(oid) && !newShallowSet.has(oid));
  // Acknowledgements: a have that is an ancestor of (or equal to) a want.
  const wantClosure = collectClosure(get, wantCommits);
  const acks = haves.filter((have) => wantClosure.has(have));
  // Refs whose oid is wanted (for the optional wanted-refs section).
  const wantedRefs = forge.refList(repo).filter((ref) => wants.includes(ref.oid));
  return { send, shallow: newShallow, unshallow, acks, wantedRefs };
}

function fetchResponse(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice('want '.length).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice('have '.length).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice('shallow '.length).trim());
    else if (arg.startsWith('deepen ')) deepen = Number(arg.slice('deepen '.length).trim());
    // thin-pack, no-progress, ofs-delta, done: acknowledged, no behaviour change
    // (plain objects are already thin; there is no progress output).
  }
  const plan = computeFetch(forge, repo, wants, haves, shallow, deepen);
  const sections: Buffer[] = [];
  // acknowledgments
  const ackLines: string[] = plan.acks.length > 0 ? [...plan.acks.map((oid) => `ACK ${oid}`), 'ready'] : ['NAK'];
  sections.push(pkt('acknowledgments\n'), ...ackLines.map((line) => pkt(`${line}\n`)), PKT_DELIM);
  // shallow-info
  const shallowLines = [...plan.shallow.map((oid) => `shallow ${oid}`), ...plan.unshallow.map((oid) => `unshallow ${oid}`)];
  if (shallowLines.length > 0) {
    sections.push(pkt('shallow-info\n'), ...shallowLines.map((line) => pkt(`${line}\n`)), PKT_DELIM);
  }
  // wanted-refs
  if (plan.wantedRefs.length > 0) {
    sections.push(
      pkt('wanted-refs\n'),
      ...plan.wantedRefs.map((ref) => pkt(`${ref.oid} ${ref.name}\n`)),
      PKT_DELIM,
    );
  }
  // packfile (sideband band 1)
  sections.push(pkt('packfile\n'), ...sidebandPackets(writePack([...plan.send.values()])), PKT_FLUSH);
  return Buffer.concat(sections);
}

function handleUploadPack(forge: Forge, repo: Repo, body: Buffer): GitReply {
  const request = parseV2Request(body);
  if (request === null) {
    return jsonReply(400, { message: 'malformed pkt-line stream' });
  }
  if (request.command === 'ls-refs') {
    const lines = lsRefsLines(forge, repo, request.args);
    const parts = lines.map((line) => pkt(`${line}\n`));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  if (request.command === 'fetch') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(forge, repo, request.args) };
  }
  return jsonReply(400, { message: `unknown command ${request.command}` });
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse the command pkt-lines and return the pack offset (or -1 on garbage). */
function parseReceiveBody(body: Buffer): { commands: PushCommand[]; caps: string; packOffset: number } | null {
  const { packets, consumed } = parsePktLines(body);
  const commands: PushCommand[] = [];
  let caps = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    if (caps === '' && commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(line);
    if (match === null) return null;
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  if (commands.length === 0) return null;
  return { commands, caps, packOffset: consumed };
}

function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): GitReply {
  const parsed = parseReceiveBody(body);
  if (parsed === null) {
    return jsonReply(400, { message: 'malformed push command stream' });
  }
  const { commands, caps, packOffset } = parsed;
  const sideband = caps.includes('side-band-64k');
  const packBytes = body.subarray(packOffset);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes);
      for (const object of objects) forge.putObject(object.type, object.data);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : String(error);
    }
  }
  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}`);
    for (const cmd of commands) report.push(`ng ${cmd.ref} unpack failed`);
  } else {
    report.push('unpack ok');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let failure: string | null = null;
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined) failure = 'ref does not exist';
        else if (cmd.oldOid !== current) failure = 'non-fast-forward';
      } else if (cmd.oldOid === ZERO_OID) {
        // create
        if (current !== undefined) failure = 'already exists';
        else if (!forge.refsComplete(cmd.newOid)) failure = 'unresolved objects';
      } else {
        // update
        if (current === undefined) failure = 'ref does not exist';
        else if (cmd.oldOid !== current) failure = 'non-fast-forward';
        else if (!forge.isFastForward(current, cmd.newOid)) failure = 'non-fast-forward';
        else if (!forge.refsComplete(cmd.newOid)) failure = 'unresolved objects';
      }
      if (failure !== null) {
        report.push(`ng ${cmd.ref} ${failure}`);
        continue;
      }
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}`);
    }
  }
  const lines = report.map((line) => `${line}\n`);
  let response: Buffer;
  if (sideband) {
    response = Buffer.concat([...sidebandPackets(Buffer.from(lines.join(''), 'utf8')), PKT_FLUSH]);
  } else {
    response = Buffer.concat([...lines.map((line) => pkt(line)), PKT_FLUSH]);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: response };
}

// ---------------------------------------------------------------- router

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * Handle a git smart-HTTP request. Returns null when the path is not a git
 * endpoint (so the REST router can try), otherwise a reply.
 */
export function handleGit(forge: Forge, req: GitRequest): GitReply | null {
  const match = GIT_PATH.exec(req.path);
  if (match === null) return null;
  const [, owner, repoName, endpoint] = match;
  const repo = repoOf(forge, owner, repoName);
  if (repo === null) return notFound();
  if (endpoint === 'info/refs') {
    if (req.method !== 'GET') return jsonReply(405, { message: 'Method Not Allowed' });
    const service = req.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      if (req.headers['git-protocol'] === 'version=2') {
        return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement('git-upload-pack') };
      }
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: v0Advertisement(forge, repo, 'git-upload-pack', 'agent=forge/1.0'),
      };
    }
    if (service === 'git-receive-pack') {
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-advertisement',
        body: v0Advertisement(forge, repo, 'git-receive-pack', 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0'),
      };
    }
    return jsonReply(400, { message: 'unknown service' });
  }
  if (endpoint === 'git-upload-pack') {
    if (req.method !== 'POST') return jsonReply(405, { message: 'Method Not Allowed' });
    return handleUploadPack(forge, repo, req.body);
  }
  if (endpoint === 'git-receive-pack') {
    if (req.method !== 'POST') return jsonReply(405, { message: 'Method Not Allowed' });
    return handleReceivePack(forge, repo, req.body);
  }
  return null;
}

// Re-export for the app wiring.
export type { Repo };
