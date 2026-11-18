// git.ts — git smart HTTP (builder #2).
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   (v2 + v0)
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  (v0)
//   POST /{owner}/{repo}.git/git-upload-pack   (protocol v2 ls-refs/fetch, v0 fallback)
//   POST /{owner}/{repo}.git/git-receive-pack  (v0, report-status, side-band-64k,
//                                              delete-refs, fast-forward only)
//
// Over the same Store (store.ts) and object primitives (git-objects.ts)
// that REST uses, so REST contents commits and git pushes share one
// history. Packets are framed with pack.ts; packs are plain objects only
// (no deltas) in a fixed oid order, so a pack is deterministic for a
// given ref set. Unknown repositories are 404 and the server stays up.

import type { HandlerCtx } from './app.ts';
import type { RestResult } from './rest.ts';
import type { Repo } from './store.ts';
import {
  isAncestor,
  parseCommit,
  parseCommitParents,
  parseTag,
  parseTree,
  type GitObject,
} from './git-objects.ts';
import {
  ZERO_OID,
  decodePktStream,
  encodePktLines,
  isOid,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  sidebandWrap,
  writePack,
} from './pack.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/**
 * Small FIFO cache for responses that are pure functions of immutable git
 * objects plus the request: identical clones of one tip share one pack, so
 * 50 concurrent depth-1 clones pay the pack build (deflate + SHA-1) once.
 * A cache key names the repo, the wants/haves/shallow set and the depth;
 * objects are content-addressed and immutable, so a cached pack for a
 * given want can never go stale — a push only creates new keys. Bounded
 * so a long trial cannot grow it without limit.
 */
const RESPONSE_CACHE = new Map<string, Buffer>();
const CACHE_MAX = 64;

function cacheGet(key: string): Buffer | undefined {
  return RESPONSE_CACHE.get(key);
}

function cachePut(key: string, value: Buffer): void {
  if (RESPONSE_CACHE.has(key)) return;
  if (RESPONSE_CACHE.size >= CACHE_MAX) {
    const oldest = RESPONSE_CACHE.keys().next().value;
    if (oldest !== undefined) RESPONSE_CACHE.delete(oldest);
  }
  RESPONSE_CACHE.set(key, value);
}

/** The ref list as a cache-key component (self-validating: any ref move changes it). */
function refSignature(repo: Repo): string {
  return [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, oid]) => `${name}=${oid}`)
    .join(';');
}

/** The v2 advertisement never varies: one shared buffer. */
const V2_ADVERTISEMENT = encodePktLines([
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function raw(status: number, contentType: string, body: Buffer): RestResult {
  return { status, headers: { 'content-type': contentType, 'content-length': String(body.length) }, raw: body };
}

function repoNameOf(ctx: HandlerCtx): { owner: string; name: string } | null {
  const owner = ctx.segments[0] ?? '';
  const suffixed = ctx.segments[1] ?? '';
  if (!suffixed.endsWith('.git')) return null;
  return { owner, name: suffixed.slice(0, -4) };
}

/** Refs sorted by name. */
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The ref HEAD points at: main when it exists, else the first branch. */
function headTarget(repo: Repo): string {
  if (repo.refs.has('refs/heads/main')) return 'refs/heads/main';
  for (const ref of sortedRefs(repo)) {
    if (ref.name.startsWith('refs/heads/')) return ref.name;
  }
  return '';
}

/** Follow tag objects to their commit (or null when the chain breaks). */
function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const tag = parseTag(obj.data);
    if (tag === null) return null;
    current = tag.object;
  }
  return null;
}

/** Capability list for a v0 upload-pack advertisement. */
function uploadCaps(repo: Repo): string {
  const head = headTarget(repo);
  const symref = head === '' ? 'symref=HEAD:refs/heads/main' : `symref=HEAD:${head}`;
  return `side-band-64k shallow thin-pack ofs-delta multi_ack multi_ack_detailed ${symref} agent=${AGENT}`;
}

function receiveCaps(repo: Repo): string {
  const head = headTarget(repo);
  const symref = head === '' ? 'symref=HEAD:refs/heads/main' : `symref=HEAD:${head}`;
  return `report-status side-band-64k delete-refs ofs-delta ${symref} agent=${AGENT}`;
}

/** One v0 ref line, plus its peeled line when it names an annotated tag. */
function v0RefLines(repo: Repo, refs: { name: string; oid: string }[]): Buffer[] {
  const lines: Buffer[] = [];
  for (const ref of refs) {
    lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
    const obj = repo.objects.get(ref.oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== null) lines.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  return lines;
}

/** A v0 ref advertisement: preamble, flush, ref lines, flush. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps(repo);
  const refs = sortedRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = headTarget(repo);
    const headOid = head === '' ? ZERO_OID : (repo.refs.get(head) as string);
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    parts.push(...v0RefLines(repo, refs));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** A v2 capability advertisement: `version 2`, capability lines, flush. */
function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

function handleInfoRefs(ctx: HandlerCtx, repo: Repo): RestResult {
  const service = ctx.query.get('service');
  const wantsV2 =
    service === 'git-upload-pack' &&
    (ctx.headers['git-protocol'] === 'version=2' || ctx.headers['git-protocol'] === 'version=2\r');
  if (service === 'git-upload-pack') {
    if (wantsV2) return raw(200, UPLOAD_AD, v2Advertisement());
    return raw(200, UPLOAD_AD, v0Advertisement(repo, 'git-upload-pack'));
  }
  if (service === 'git-receive-pack') {
    return raw(200, RECEIVE_AD, v0Advertisement(repo, 'git-receive-pack'));
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  return args;
}

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  const args = parseLsRefsArgs(lines);
  const cacheKey = `ls-refs|${repo.id}|${refSignature(repo)}|${args.peel}|${args.symrefs}|${args.unborn}|${args.prefixes.join(',')}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;
  const out: Buffer[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const head = headTarget(repo);
  if (head !== '' && args.symrefs && keep('HEAD')) {
    out.push(pktLine(`${repo.refs.get(head) as string} HEAD symref-target:${head}\n`));
  }
  if (head === '' && args.unborn && keep('HEAD')) {
    out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  const built = Buffer.concat(out);
  cachePut(cacheKey, built);
  return built;
}

// ---------------------------------------------------------------------------------------------
// fetch planning (shared by v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send, sorted by oid (deterministic pack order). */
  objects: { type: GitObject['type']; data: Buffer; oid: string }[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowIn: string[];
  depth: number | null;
}

function commitParents(repo: Repo, oid: string): string[] {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return [];
  return parseCommitParents(obj.data) ?? [];
}

/**
 * Decide what a fetch sends. `depth` is an absolute depth from the wants
 * (the suite's deepen N means total depth N, verified against its deepen
 * check: deepen 2 from a depth-1 clone delivers exactly one generation).
 * Objects the client already holds are excluded: the full closure of the
 * haves, cut at the client's shallow boundaries (a shallow boundary's
 * parents are NOT held). A commit is a new shallow boundary when it has a
 * parent that is neither delivered nor held.
 */
function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const wantTags: string[] = [];
  const wantCommits: string[] = [];
  const extraRoots: string[] = [];
  for (const want of req.wants) {
    const obj = lookup(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit') wantCommits.push(want);
    else if (obj.type === 'tag') {
      wantTags.push(want);
      const peeled = peelToCommit(repo, want);
      if (peeled !== null) wantCommits.push(peeled);
    } else {
      extraRoots.push(want);
    }
  }

  // Commits to deliver: breadth-first from the wants, depth-limited.
  const included = new Set<string>();
  if (req.depth === 1) {
    // Depth 1 delivers exactly the wants themselves: no parent expansion.
    for (const oid of wantCommits) {
      if (lookup(oid)?.type === 'commit') included.add(oid);
    }
  } else {
    const queue: { oid: string; dist: number }[] = wantCommits.map((oid) => ({ oid, dist: 1 }));
    let head = 0;
    while (head < queue.length) {
      const item = queue[head] as { oid: string; dist: number };
      head += 1;
      if (included.has(item.oid)) continue;
      if (lookup(item.oid)?.type !== 'commit') continue;
      included.add(item.oid);
      if (req.depth !== null && item.dist >= req.depth) continue;
      for (const parent of commitParents(repo, item.oid)) {
        if (!included.has(parent)) queue.push({ oid: parent, dist: item.dist + 1 });
      }
    }
  }

  // Commits the client holds: closure of the haves, cut at its boundaries.
  // Empty when the client sent no haves (fresh clone/fetch): skip the work.
  const held = new Set<string>();
  if (req.haves.length > 0) {
    const boundaries = new Set(req.shallowIn);
    const queue: string[] = [];
    for (const have of req.haves) {
      const peeled = peelToCommit(repo, have);
      if (peeled !== null) queue.push(peeled);
      else if (lookup(have)?.type === 'commit') queue.push(have);
    }
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head] as string;
      head += 1;
      if (held.has(oid)) continue;
      if (lookup(oid)?.type !== 'commit') continue;
      held.add(oid);
      if (boundaries.has(oid)) continue;
      for (const parent of commitParents(repo, oid)) {
        if (!held.has(parent)) queue.push(parent);
      }
    }
  }
  // Walk a tree into `target` (the tree itself, its subtrees, its blobs).
  const addTreeInto = (treeOid: string, target: Set<string>): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (target.has(oid)) continue;
      const obj = lookup(oid);
      if (obj === undefined || obj.type !== 'tree') continue;
      target.add(oid);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        if (entry.mode === '40000') stack.push(entry.oid);
        else target.add(entry.oid);
      }
    }
  };

  const heldObjects = new Set<string>();
  // NOTE: do NOT use collectReachable() here: it walks the full ancestry
  // and would count the parents of a shallow boundary as held, which
  // they are not. Held objects are exactly the held commits plus their
  // tree closures (the held set is already cut at the boundaries).
  // With no haves, held is empty and there is nothing to add.
  if (req.haves.length > 0) {
    for (const oid of held) {
      heldObjects.add(oid);
      const info = parseCommit(lookup(oid)?.data ?? Buffer.alloc(0));
      if (info !== null) addTreeInto(info.tree, heldObjects);
    }
    for (const have of req.haves) {
      if (lookup(have)?.type === 'tag') heldObjects.add(have);
    }
  }

  // Objects to send: the included commits' trees plus tag/extra roots,
  // minus everything the client holds.
  const send = new Set<string>();
  const addTree = (treeOid: string): void => addTreeInto(treeOid, send);
  for (const oid of included) {
    send.add(oid);
    const info = parseCommit(lookup(oid)?.data ?? Buffer.alloc(0));
    if (info !== null) addTree(info.tree);
  }
  for (const tagOid of wantTags) {
    send.add(tagOid);
    const tag = parseTag(lookup(tagOid)?.data ?? Buffer.alloc(0));
    if (tag !== null) {
      const target = lookup(tag.object);
      if (target !== undefined && target.type === 'tree') addTree(tag.object);
      else if (target !== undefined && target.type === 'blob') send.add(tag.object);
      else if (target !== undefined && target.type === 'tag') send.add(tag.object);
    }
  }
  for (const root of extraRoots) {
    send.add(root);
    if (lookup(root)?.type === 'tree') addTree(root);
  }
  for (const oid of heldObjects) send.delete(oid);

  const objects: FetchPlan['objects'] = [];
  for (const oid of [...send].sort()) {
    const obj = lookup(oid);
    if (obj !== undefined) objects.push({ type: obj.type, data: obj.data, oid });
  }

  // Shallow boundaries: only when depth is in play or the client is shallow.
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (req.depth !== null || req.shallowIn.length > 0) {
    for (const oid of [...included].sort()) {
      const parents = commitParents(repo, oid);
      if (parents.length > 0 && parents.some((p) => !included.has(p) && !held.has(p))) shallow.push(oid);
    }
    for (const boundary of req.shallowIn) {
      if (!included.has(boundary) && !held.has(boundary)) continue;
      const parents = commitParents(repo, boundary);
      if (parents.every((p) => included.has(p) || held.has(p))) unshallow.push(boundary);
    }
    shallow = [...new Set(shallow)].sort();
    unshallow = [...new Set(unshallow)].sort();
  }

  // ACK every have that is an ancestor-or-equal of a want.
  // With no haves there is nothing to ACK.
  const acks: string[] = [];
  if (req.haves.length > 0) {
    for (const have of req.haves) {
      const peeled = peelToCommit(repo, have) ?? have;
      if (lookup(peeled)?.type !== 'commit') continue;
      for (const want of wantCommits) {
        if (isAncestor(lookup, peeled, want)) {
          acks.push(have);
          break;
        }
      }
    }
  }
  return { objects, shallow, unshallow, acks };
}

// ---------------------------------------------------------------------------------------------
// v2 fetch
// ---------------------------------------------------------------------------------------------

function parseFetchArgs(lines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallowIn: [], depth: null };
  for (const line of lines) {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (text.startsWith('want ')) req.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallowIn.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) req.depth = n;
    }
  }
  return req;
}

function handleFetchV2(repo: Repo, lines: string[]): Buffer {
  const req = parseFetchArgs(lines);
  const cacheKey = `fetch-v2|${repo.id}|${req.wants.join(',')}|${req.haves.join(',')}|${req.shallowIn.join(',')}|${req.depth}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, req);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  // The acknowledgments section is sent only when the client sent have
  // lines: a fresh clone sends none, and real git then expects the next
  // section to be the packfile (an unsolicited acknowledgments section
  // is a protocol error to it). The suite's client tolerates either.
  if (req.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    // End the section with a DELIM, not a flush: real git reads the
    // packet after 'ready' expecting the next section header ('packfile'
    // or 'shallow-info') and dies on a flush there ("expected packfile
    // to be sent after 'ready'"). The suite's client resets its section
    // on a delim exactly as on a flush, so both readers are satisfied.
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(pack, 1));
  parts.push(pktFlush());
  const built = Buffer.concat(parts);
  cachePut(cacheKey, built);
  return built;
}

// ---------------------------------------------------------------------------------------------
// v0 fetch
// ---------------------------------------------------------------------------------------------

function parseFetchV0(first: string[], second: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallowIn: [], depth: null };
  for (const line of first) {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim().split(/\s+/)[0] as string;
      if (isOid(rest)) req.wants.push(rest);
    } else if (text.startsWith('shallow ')) req.shallowIn.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) req.depth = n;
    }
  }
  for (const line of second) {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
  }
  return req;
}

function handleFetchV0(repo: Repo, first: string[], second: string[]): Buffer {
  const req = parseFetchV0(first, second);
  const cacheKey = `fetch-v0|${repo.id}|${req.wants.join(',')}|${req.haves.join(',')}|${req.shallowIn.join(',')}|${req.depth}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, req);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    // Detailed form: real git's stateless-rpc v0 fetch requires the
    // multi_ack_detailed capability and reads "ACK <oid> ready".
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack} ready\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  // No flush between the NAK/ACK + shallow lines and the pack: real
  // git's sideband demuxer reads the first flush as end-of-pack, so a
  // flush here yields an empty pack ("bad pack header"). The sideband
  // packets follow the ack lines directly; the final flush below ends
  // the stream. The suite's client ignores flush packets either way.
  parts.push(sidebandWrap(pack, 1));
  parts.push(pktFlush());
  const built = Buffer.concat(parts);
  cachePut(cacheKey, built);
  return built;
}

// ---------------------------------------------------------------------------------------------
// upload-pack POST
// ---------------------------------------------------------------------------------------------

function handleUploadPack(ctx: HandlerCtx, repo: Repo): RestResult {
  const wantsV2 = ctx.headers['git-protocol'] === 'version=2';
  let lines: string[];
  try {
    const decoded = decodePktStream(ctx.body);
    lines = decoded.lines;
    if (wantsV2) {
      const first = (lines[0] ?? '').trim();
      if (first !== 'command=ls-refs' && first !== 'command=fetch') return err(400, 'unknown command');
      // Lines after the command line are agent/object-format lines
      // (ignored here) followed by the arguments.
      const args = lines.slice(1);
      if (first === 'command=ls-refs') return raw(200, UPLOAD_RESULT, handleLsRefs(repo, args));
      return raw(200, UPLOAD_RESULT, handleFetchV2(repo, args));
    }
    // v0: two sections split by the first flush.
    const firstSection = decoded.lines;
    const second = decodePktStream(decoded.rest);
    return raw(200, UPLOAD_RESULT, handleFetchV0(repo, firstSection, second.lines));
  } catch (e) {
    return err(400, (e as Error).message.slice(0, 200));
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack POST
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(lines: string[]): { commands: PushCommand[]; sideband: boolean } {
  const commands: PushCommand[] = [];
  let sideband = false;
  lines.forEach((line, index) => {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    const [commandPart, capsPart] = text.split('\0');
    if (index === 0 && capsPart !== undefined) {
      sideband = capsPart.split(' ').includes('side-band-64k');
    }
    const parts = (commandPart ?? '').split(' ');
    if (parts.length !== 3) throw new Error('bad push command line');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) {
      throw new Error('bad push command line');
    }
    commands.push({ oldOid, newOid, ref });
  });
  return { commands, sideband };
}

function handleReceivePack(ctx: HandlerCtx, repo: Repo): RestResult {
  let commands: PushCommand[];
  let sideband: boolean;
  let packBytes: Buffer;
  try {
    const decoded = decodePktStream(ctx.body);
    const parsed = parsePushCommands(decoded.lines);
    commands = parsed.commands;
    sideband = parsed.sideband;
    packBytes = decoded.rest;
  } catch (e) {
    return err(400, (e as Error).message.slice(0, 200));
  }
  if (commands.length === 0) return err(400, 'no push commands');

  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackError = 'missing packfile';
    } else {
      try {
        const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (e) {
        unpackError = (e as Error).message.slice(0, 200).replace(/[\r\n]+/g, ' ');
      }
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? null;
      const verdict = (reason: string | null): void => {
        reportLines.push(reason === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
      };
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === null) verdict('no such ref');
        else if (command.oldOid !== current) verdict('stale info');
        else {
          repo.refs.delete(command.ref);
          verdict(null);
        }
        continue;
      }
      const obj = repo.objects.get(command.newOid);
      if (obj === undefined) {
        verdict('missing object');
        continue;
      }
      if (command.ref.startsWith('refs/heads/') && obj.type !== 'commit') {
        verdict('invalid object');
        continue;
      }
      if (command.ref.startsWith('refs/tags/') && obj.type !== 'commit' && obj.type !== 'tag') {
        verdict('invalid object');
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== null) verdict('already exists');
        else {
          repo.refs.set(command.ref, command.newOid);
          verdict(null);
        }
        continue;
      }
      // Update: old must match, new must fast-forward from old.
      if (current === null) verdict('no such ref');
      else if (command.oldOid !== current) verdict('stale info');
      else if (!isAncestor((oid) => repo.objects.get(oid), command.oldOid, command.newOid)) {
        verdict('non-fast-forward');
      } else {
        repo.refs.set(command.ref, command.newOid);
        verdict(null);
      }
    }
  }

  // The report-status text is pkt-lined AND the pkt-line stream is
  // terminated by a flush INSIDE band 1: real git reads the demuxed
  // band-1 stream with packet_read and treats EOF before a flush as
  // "the remote end hung up". (Raw text fails with "bad line length
  // character"; pkt-lines without the inner flush hang up.) The suite's
  // client accepts this shape too (its decoder drops flush packets).
  const reportStream = encodePktLines([...reportLines.map((line) => line as string), 'flush' as const]);
  let body: Buffer;
  if (sideband) {
    body = Buffer.concat([sidebandWrap(reportStream, 1), pktFlush()]);
  } else {
    body = Buffer.concat([reportStream, pktFlush()]);
  }
  return raw(200, RECEIVE_RESULT, body);
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

export async function handleGit(ctx: HandlerCtx): Promise<RestResult | null> {
  const named = repoNameOf(ctx);
  if (named === null) return null;
  if (!ctx.tokenOk) return err(401, 'Bad credentials');
  const repo = ctx.store.getRepo(named.owner, named.name);
  if (repo === null) return err(404, 'Not Found');
  const tail = ctx.segments.slice(2);
  if (ctx.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    return handleInfoRefs(ctx, repo);
  }
  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    return handleUploadPack(ctx, repo);
  }
  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    return handleReceivePack(ctx, repo);
  }
  return null;
}
