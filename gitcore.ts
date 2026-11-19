// gitcore.ts — the pure git primitives: object ids, commit/tree/tag parsing, pack
// reading (plain objects only; the suite never sends deltas) and writing, pkt-line
// framing and sideband-64k. No store, no HTTP: every function here is deterministic
// and side-effect free, so the forge's behaviour replays byte for byte.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The all-zero object id: an unborn ref, a create's old oid, a delete's new oid. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 of `<type> <size>\0<data>`: the object id git computes. */
export function sha1Object(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Whether `value` is a 40-hex object id. */
export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

// ---------------------------------------------------------------- commits, trees, tags

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit's bytes: header lines, then the message after the blank line. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree's binary entries: `<mode> <name>\0<20-byte oid>`. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(off, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries ordered by name, directories compared as `name/`. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/** Serialise tree entries (sorted git-style) to a tree object's bytes. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = sortTreeEntries(entries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag's bytes. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packs (plain objects only)

/** Serialise objects as a packfile version 2: header, one zlib entry each, SHA-1 trailer. */
export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = TYPE_CODE[object.type];
    const size = object.data.length;
    const headBytes: number[] = [];
    let rest = size >>> 4;
    let first = (code << 4) | (size & 0x0f);
    while (rest > 0) {
      headBytes.push(first | 0x80);
      first = rest & 0x7f;
      rest >>>= 7;
    }
    headBytes.push(first);
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Inflate exactly one zlib stream starting at `off`: inflateSync ignores trailing
 * bytes, so one inflation of the remainder yields the data — and the stream's last
 * four bytes are the Adler-32 of that data, which locates the stream's end. The
 * candidate end is verified by re-inflating exactly that prefix, so a stray
 * Adler match inside the deflate bytes can never be mistaken for the end.
 */
function inflateOne(buf: Buffer, off: number): { data: Buffer; next: number } {
  const end = buf.length;
  let data: Buffer;
  try {
    data = inflateSync(buf.subarray(off, end));
  } catch {
    throw new Error('truncated zlib stream in pack');
  }
  const adler = adler32(data);
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler, 0);
  let pos = off + 2;
  for (;;) {
    const found = buf.indexOf(needle, pos);
    if (found < 0 || found + 4 > end) break;
    const candidate = found + 4;
    try {
      const check = inflateSync(buf.subarray(off, candidate));
      if (check.equals(data)) return { data, next: candidate };
    } catch {
      // Not the stream's end: keep scanning.
    }
    pos = found + 1;
  }
  throw new Error('zlib stream end not found in pack');
}

/** Adler-32, the checksum a zlib stream ends with. */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Parse a packfile: verify the trailer checksum, then read each entry. Delta entries
 * (OFS/REF) are refused — the suite's client only ever writes plain objects.
 */
export function parsePack(buf: Buffer): GitObj[] {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  if (actual !== trailer) throw new Error('pack trailer checksum mismatch');
  const objects: GitObj[] = [];
  let off = 12;
  const end = buf.length - 20;
  for (let i = 0; i < count; i += 1) {
    if (off >= end) throw new Error('pack ends before its declared count');
    let byte = buf[off];
    off += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (off >= end) throw new Error('pack entry header overruns the pack');
      byte = buf[off];
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (code === 6) throw new Error('OFS_DELTA entries are not supported');
    if (code === 7) throw new Error('REF_DELTA entries are not supported');
    const type = CODE_TYPE[code];
    if (type === undefined) throw new Error(`unknown pack entry type ${code}`);
    const inflated = inflateOne(buf.subarray(0, end), off);
    off = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    objects.push({ type, data: inflated.data });
  }
  return objects;
}

// ---------------------------------------------------------------- object graph walks

export type ObjectGetter = (oid: string) => GitObj | undefined;

/**
 * The full closure of `roots`: commits (their trees and parents), tags (their target),
 * trees (their entries, recursively). Returns the set of oids, in walk order.
 */
export function collectClosure(get: ObjectGetter, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree !== '') stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.object !== '') stack.push(tag.object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `tip` (or is the tip itself). */
export function isAncestor(get: ObjectGetter, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/**
 * The merge-base of two commits: the nearest common ancestor, by breadth-first walk
 * from both tips. Null when the histories share nothing.
 */
export function mergeBase(get: ObjectGetter, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, depth] = queueA.shift() as [string, number];
    if (ancestorsA.has(oid)) continue;
    ancestorsA.set(oid, depth);
    const object = get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
  }
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const [oid, depth] = queueB.shift() as [string, number];
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const depthA = ancestorsA.get(oid);
    if (depthA !== undefined && depthA + depth < bestDepth) {
      best = oid;
      bestDepth = depthA + depth;
    }
    const object = get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, depth + 1]);
  }
  return best;
}

/** All commit oids reachable from `tip`, newest-first by walk order (tip first). */
export function walkCommits(get: ObjectGetter, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

// ---------------------------------------------------------------- pkt-lines and sideband

/** One pkt-line: a 4-hex length (payload + 4) and the payload. */
export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, body]);
}

/** The flush packet, `0000`. */
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
/** The delimiter packet, `0001`. */
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode lines as pkt-lines, with `flush`/`delim` as control packets. */
export function pktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pkt(line));
  }
  return Buffer.concat(parts);
}

export type PktPacket =
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' }
  | { kind: 'data'; payload: Buffer };

/**
 * Parse a pkt-line stream into packets. Stops at the end of the buffer; a truncated
 * final packet is dropped (the caller treats a short body as malformed).
 */
export function parsePktLines(buf: Buffer): { packets: PktPacket[]; consumed: number } {
  const packets: PktPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    const len = Number.parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, consumed: off };
}

/**
 * Wrap `data` as sideband-64k band-1 packets: each pkt-line holds one band byte plus
 * at most 32 KiB of data, so no pkt-line ever approaches the 65,520-byte ceiling.
 */
export function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  if (data.length === 0) {
    out.push(pkt(Buffer.from([band])));
    return out;
  }
  for (let off = 0; off < data.length; off += CHUNK) {
    const piece = data.subarray(off, Math.min(data.length, off + CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([band]), piece])));
  }
  return out;
}
