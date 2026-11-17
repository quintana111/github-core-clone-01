// git-objects.ts — git object primitives shared by REST and git.
//
// Objects are content-addressed: the id is the SHA-1 of "<type> <len>\0" plus
// the raw bytes. Blobs hold file bytes; trees hold sorted entries; commits
// hold the tree, parents, author/committer lines and message. All bytes here
// follow git's own serialisation, so a SHA computed here equals the SHA a
// real git client computes for the same content. Nothing here reads a clock:
// commit timestamps are always the fixed epoch below.

import { createHash } from 'node:crypto';

export const FIXED_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, the wire contract's day one
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string; // '100644' file, '40000' directory, '160000' submodule (unused)
  readonly name: string;
  readonly oid: string;
}

/** The SHA-1 object id of `type` + `data`, as git computes it. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function makeBlob(data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject('blob', data), object: { type: 'blob', data } };
}

/** Git tree ordering: entries sort by name, a directory comparing as name + '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return entries.slice().sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Serialise tree entries in git order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's raw bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string; // "Name <email> epoch +0000"
  readonly committer: string;
  readonly message: string;
}

/** Serialise a commit object. Field order is git's: tree, parents, author, committer, blank, message. */
export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`, '');
  return Buffer.concat([Buffer.from(`${lines.join('\n')}\n`, 'utf8'), Buffer.from(info.message, 'utf8')]);
}

/** Parse a commit object's raw bytes. */
export function parseCommit(data: Buffer): CommitInfo | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  if (split === -1) return null;
  const head = text.slice(0, split);
  const message = text.slice(split + 2);
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
  if (tree === '') return null;
  return { tree, parents, author, committer, message };
}

/** "Name <email> epoch +0000" for the fixed epoch. */
export function identityLine(name: string, email: string): string {
  return `${name} <${email}> ${FIXED_EPOCH_SEC} +0000`;
}

/** Build a tag object (annotated tag). */
export function buildTag(object: string, type: ObjectType, tag: string, tagger: string, message: string): Buffer {
  return Buffer.from(`object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${message}`, 'utf8');
}

/** Parse a tag object; returns the target oid and type, or null. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  if (split === -1) return null;
  const head = text.slice(0, split);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
  }
  if (object === '') return null;
  return { object, type, tag, message: text.slice(split + 2) };
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Read one tree's entries; missing object or wrong type yields an empty list. */
export function treeEntriesOf(lookup: ObjectLookup, treeOid: string): TreeEntry[] {
  const obj = lookup(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

/**
 * Walk `path` (slash-separated, no leading slash) through nested trees from
 * `treeOid`. Returns the blob entry found, or the tree entry when the path
 * names a directory, or null.
 */
export function lookupPath(
  lookup: ObjectLookup,
  treeOid: string,
  path: string,
): { entry: TreeEntry; isDir: boolean } | null {
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return { entry: { mode: '40000', name: '', oid: treeOid }, isDir: true };
  let currentOid = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = treeEntriesOf(lookup, currentOid);
    const found = entries.find((e) => e.name === segments[i]);
    if (found === undefined) return null;
    if (i === segments.length - 1) return { entry: found, isDir: found.mode === '40000' };
    if (found.mode !== '40000') return null;
    currentOid = found.oid;
  }
  return null;
}

/** Collect every file path under a tree (recursive), as path -> blob oid. */
export function flattenTree(lookup: ObjectLookup, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of treeEntriesOf(lookup, treeOid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, oid] of flattenTree(lookup, entry.oid, path)) out.set(p, oid);
    } else {
      out.set(path, entry.oid);
    }
  }
  return out;
}

/**
 * Return a new tree oid with `path` set to `blobOid` (or removed when
 * `blobOid` is null), starting from `treeOid` (empty string = empty tree).
 * New tree/blob objects are handed to `put`; the returned oid is the new
 * root tree. Intermediate directories are created or pruned as needed.
 */
export function updateTreePath(
  lookup: ObjectLookup,
  put: (type: ObjectType, data: Buffer) => string,
  treeOid: string,
  path: string,
  blobOid: string | null,
): string {
  const segments = path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return treeOid;
  const build = (currentOid: string, depth: number): string | null => {
    const entries = currentOid === '' ? [] : treeEntriesOf(lookup, currentOid);
    const name = segments[depth] as string;
    const last = depth === segments.length - 1;
    const next: TreeEntry[] = [];
    let handled = false;
    for (const entry of entries) {
      if (entry.name !== name) {
        next.push(entry);
        continue;
      }
      handled = true;
      if (last) {
        if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
        // else: drop the entry (deletion)
      } else if (entry.mode === '40000') {
        const child = build(entry.oid, depth + 1);
        if (child !== null) next.push({ mode: '40000', name, oid: child });
        // else: child pruned away entirely
      } else {
        // A file sits where a directory is needed: replace it with a fresh subtree.
        const child = build('', depth + 1);
        if (child !== null) next.push({ mode: '40000', name, oid: child });
      }
    }
    if (!handled) {
      if (last) {
        if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
        else return currentOid === '' ? '' : currentOid; // deleting a missing path: unchanged
      } else {
        const child = build('', depth + 1);
        if (child !== null) next.push({ mode: '40000', name, oid: child });
        else return currentOid;
      }
    }
    if (next.length === 0) return null; // empty directory: pruned (git stores no empty dirs)
    return put('tree', buildTree(next));
  };
  return build(treeOid, 0) ?? '';
}

/** The empty tree's oid (git's well-known empty tree). */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

/**
 * All commit oids reachable from `tips`, newest-first by breadth of the
 * walk (parents after children). Each commit appears once.
 */
export function walkCommits(lookup: ObjectLookup, tips: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const queue: string[] = tips.slice();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    const info = parseCommit(obj.data);
    if (info !== null) {
      for (const parent of info.parents) {
        if (!seen.has(parent)) queue.push(parent);
      }
    }
  }
  return out;
}

/** True when `ancestor` is reachable from `tip` (or equals it). */
export function isAncestor(lookup: ObjectLookup, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>([tip]);
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    if (info === null) continue;
    for (const parent of info.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** First commit reachable from both `a` and `b` (walking `a`'s ancestry), or null. */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const ancestorsOfB = new Set(walkCommits(lookup, [b]));
  for (const oid of walkCommits(lookup, [a])) {
    if (ancestorsOfB.has(oid)) return oid;
  }
  return null;
}

/** All object oids reachable from `tips` (commits, their trees recursively, tags peeled). */
export function collectReachable(lookup: ObjectLookup, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = tips.slice();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      if (info === null) continue;
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag !== null) stack.push(tag.object);
    }
  }
  return seen;
}

/** Line counts for a changed file: additions/deletions by multiset line diff. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === '') return map;
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}
