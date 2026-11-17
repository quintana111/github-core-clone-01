// store.ts — the deterministic in-memory store.
//
// One Store holds everything: repositories, git objects, refs, issues,
// labels, pull requests and comments. All ids and numbers come from
// sequential counters in creation order; all timestamps are the fixed
// contract timestamp. Nothing here reads a clock or randomness, so two
// runs driven with the same requests in the same order hold identical state.
//
// Numbering: repository ids from 5000; issue and pull numbers share one
// per-repository counter from 1 (as on GitHub); comment ids are global
// from 1.

import { VIEWER } from './scenario.ts';
import {
  EMPTY_TREE_OID,
  FIXED_EPOCH_SEC,
  FIXED_ISO,
  buildCommit,
  buildTree,
  collectReachable,
  flattenTree,
  hashObject,
  identityLine,
  isAncestor,
  lineDiffCounts,
  lookupPath,
  mergeBase,
  parseCommit,
  parseTree,
  updateTreePath,
  walkCommits,
  type GitObject,
  type ObjectType,
} from './git-objects.ts';

export { EMPTY_TREE_OID, FIXED_ISO };

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  files: PullFile[];
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number; // creation order
  refs: Map<string, string>; // full ref name -> commit sha
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number; // shared issue + pull counter
}

export class Store {
  readonly repos = new Map<string, Repo>(); // "owner/name" -> Repo
  readonly viewerLogin = VIEWER.login;
  readonly viewerName = VIEWER.name;
  readonly viewerEmail = VIEWER.email;
  readonly viewerId = VIEWER.id;
  #nextRepoId = 5000;
  #nextRepoSeq = 0;
  #nextCommentId = 1;

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // ---------------------------------------------------------- repositories

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (name === '' || this.repos.has(Store.repoKey(this.viewerLogin, name))) return null;
    const repo: Repo = {
      id: this.#nextRepoId,
      owner: this.viewerLogin,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      seq: this.#nextRepoSeq,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.#nextRepoId += 1;
    this.#nextRepoSeq += 1;
    this.repos.set(Store.repoKey(this.viewerLogin, name), repo);
    return repo;
  }

  /** The viewer's repository, or null (also null for any other owner). */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== this.viewerLogin) return null;
    return this.repos.get(Store.repoKey(owner, name)) ?? null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(Store.repoKey(repo.owner, repo.name));
  }

  /** The viewer's repositories in creation order. */
  listViewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // ---------------------------------------------------------- git objects

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  objectLookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Resolve a ref name (short branch name, full ref, or SHA) to a commit SHA. */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      const obj = repo.objects.get(ref.toLowerCase());
      if (obj !== undefined && obj.type === 'commit') return ref.toLowerCase();
      return null;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const asHead = repo.refs.get(`refs/heads/${ref}`);
    if (asHead !== undefined) return asHead;
    return repo.refs.get(`refs/tags/${ref}`) ?? null;
  }

  refTip(repo: Repo, refName: string): string | null {
    return repo.refs.get(refName) ?? null;
  }

  /** All branch names (short), sorted. */
  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** Commits reachable from `tip`, newest first (walk order), each once. */
  commitsFrom(repo: Repo, tip: string): string[] {
    return walkCommits(this.objectLookup(repo), [tip]);
  }

  // ---------------------------------------------------------- contents commits

  /**
   * Commit a file write on `branch` (default branch when undefined).
   * Returns the new commit SHA and blob SHA, or an error kind:
   * 'no-repo' is impossible here (caller checks), 'no-branch' when the
   * named branch has no tip, 'stale-sha' when `sha` mismatches the current
   * blob, 'missing' when updating/deleting a path that does not exist.
   */
  commitContent(
    repo: Repo,
    options: {
      path: string;
      content: Buffer | null; // null = delete
      message: string;
      branch?: string;
      sha?: string;
    },
  ): { commitSha: string; contentSha: string } | { error: 'no-branch' | 'stale-sha' | 'missing' } {
    const branch = options.branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName) ?? null;
    const lookup = this.objectLookup(repo);
    let parentTree = '';
    const parents: string[] = [];
    if (tip !== null) {
      const info = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0));
      if (info === null) return { error: 'no-branch' };
      parentTree = info.tree;
      parents.push(tip);
    } else if (options.content === null) {
      return { error: 'missing' };
    }
    // Validate the expected sha / existence against the current tree.
    let currentBlob: string | null = null;
    if (tip !== null && parentTree !== '') {
      const found = lookupPath(lookup, parentTree, options.path);
      if (found !== null && !found.isDir) currentBlob = found.entry.oid;
    }
    if (options.sha !== undefined && options.sha.toLowerCase() !== (currentBlob ?? '')) {
      return { error: 'stale-sha' };
    }
    if (options.content !== null && currentBlob === null && options.sha !== undefined) {
      return { error: 'stale-sha' };
    }
    if (options.content === null && currentBlob === null) return { error: 'missing' };
    if (options.content === null && options.sha !== undefined && options.sha.toLowerCase() !== currentBlob) {
      return { error: 'stale-sha' };
    }

    let blobOid = currentBlob ?? '';
    let newTree = parentTree;
    if (options.content !== null) {
      blobOid = this.putObject(repo, 'blob', options.content);
      newTree = updateTreePath(lookup, (t, d) => this.putObject(repo, t, d), parentTree, options.path, blobOid);
    } else {
      newTree = updateTreePath(lookup, (t, d) => this.putObject(repo, t, d), parentTree, options.path, null);
      blobOid = currentBlob as string;
    }
    const identity = identityLine(this.viewerName, this.viewerEmail);
    const message = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
    // A tree pruned to nothing is the well-known empty tree, stored as an object.
    if (newTree === '') newTree = this.putObject(repo, 'tree', Buffer.alloc(0));
    const commitData = buildCommit({ tree: newTree, parents, author: identity, committer: identity, message });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitSha);
    return { commitSha, contentSha: blobOid };
  }

  /** Read a path at a ref: file bytes + blob sha, or the directory entries, or null. */
  readPath(
    repo: Repo,
    ref: string | undefined,
    path: string,
  ):
    | { kind: 'file'; content: Buffer; sha: string }
    | { kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] }
    | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const lookup = this.objectLookup(repo);
    const info = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0));
    if (info === null) return null;
    const clean = path.split('/').filter((s) => s !== '' && s !== '.').join('/');
    if (clean === '') {
      // Root directory listing: immediate children of the root tree.
      return { kind: 'dir', entries: directChildren(lookup, info.tree, '') };
    }
    const found = lookupPath(lookup, info.tree, clean);
    if (found === null) return null;
    if (found.isDir) {
      return { kind: 'dir', entries: directChildren(lookup, found.entry.oid, clean) };
    }
    const blob = repo.objects.get(found.entry.oid);
    if (blob === undefined || blob.type !== 'blob') return null;
    return { kind: 'file', content: blob.data, sha: found.entry.oid };
  }

  // ---------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  // ---------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: 'bad-label' } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: 'bad-label' };
      labels.push(label);
    }
    const issue: Issue = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  listIssues(repo: Repo, state: 'open' | 'closed' | 'all', sortAsc: boolean): Issue[] {
    const all = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    const filtered = state === 'all' ? all : all.filter((i) => i.state === state);
    return sortAsc ? filtered : filtered.reverse();
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: this.#nextCommentId, body };
    this.#nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------- pull requests

  /** Diff base tree vs head tree into the pull file list. */
  computePullFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
    const lookup = this.objectLookup(repo);
    const baseTree = parseCommit(repo.objects.get(baseSha)?.data ?? Buffer.alloc(0))?.tree ?? '';
    const headTree = parseCommit(repo.objects.get(headSha)?.data ?? Buffer.alloc(0))?.tree ?? '';
    const baseFiles = baseTree === '' ? new Map<string, string>() : flattenTree(lookup, baseTree);
    const headFiles = headTree === '' ? new Map<string, string>() : flattenTree(lookup, headTree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const files: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const inBase = baseFiles.get(path);
      const inHead = headFiles.get(path);
      if (inBase !== undefined && inHead === undefined) {
        const oldText = repo.objects.get(inBase)?.data.toString('utf8') ?? '';
        const { deletions } = lineDiffCounts(oldText, '');
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (inBase === undefined && inHead !== undefined) {
        const newText = repo.objects.get(inHead)?.data.toString('utf8') ?? '';
        const { additions } = lineDiffCounts('', newText);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (inBase !== inHead) {
        const oldText = repo.objects.get(inBase as string)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(inHead as string)?.data.toString('utf8') ?? '';
        const { additions, deletions } = lineDiffCounts(oldText, newText);
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): Pull | { error: 'no-branch' } {
    const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? null;
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? null;
    if (headSha === null || baseSha === null) return { error: 'no-branch' };
    const pull: Pull = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      files: this.computePullFiles(repo, baseSha, headSha),
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  listPulls(repo: Repo, state: 'open' | 'closed' | 'all'): Pull[] {
    const all = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
    if (state === 'all') return all;
    return all.filter((p) => p.state === state);
  }

  /** Is this open pull currently mergeable (no path-level conflict)? */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    return this.mergeConflictPaths(repo, pull).length === 0;
  }

  /** Paths where base and head both changed differently vs the merge-base.
   *  The base side is the CURRENT base branch tip (not the frozen base SHA
   *  from creation): a merge after another merge must see the moved base,
   *  or a conflict created by the first merge would be invisible. */
  mergeConflictPaths(repo: Repo, pull: Pull): string[] {
    const lookup = this.objectLookup(repo);
    const currentBaseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = mergeBase(lookup, currentBaseSha, pull.headSha);
    const treeOf = (sha: string): Map<string, string> => {
      const tree = parseCommit(repo.objects.get(sha)?.data ?? Buffer.alloc(0))?.tree ?? '';
      return tree === '' ? new Map() : flattenTree(lookup, tree);
    };
    const baseTree = treeOf(currentBaseSha);
    const headTree = treeOf(pull.headSha);
    const mergeTree = base === null ? new Map<string, string>() : treeOf(base);
    const conflicts: string[] = [];
    for (const path of new Set([...baseTree.keys(), ...headTree.keys(), ...mergeTree.keys()])) {
      const m = mergeTree.get(path);
      const b = baseTree.get(path);
      const h = headTree.get(path);
      const baseChanged = b !== m;
      const headChanged = h !== m;
      if (baseChanged && headChanged && b !== h) conflicts.push(path);
    }
    return conflicts.sort();
  }

  /**
   * Squash-merge an open pull onto its base branch. Returns the merge commit
   * SHA, or an error kind: 'unknown' (no such pull), 'closed' (already
   * merged/closed), 'conflict' (path-level conflict — nothing changes).
   */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: 'closed' | 'conflict' } {
    if (pull.state !== 'open') return { error: 'closed' };
    if (this.mergeConflictPaths(repo, pull).length > 0) return { error: 'conflict' };
    const lookup = this.objectLookup(repo);
    // Merge onto the CURRENT base tip, not the frozen creation-time base.
    const currentBaseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = mergeBase(lookup, currentBaseSha, pull.headSha);
    const treeOf = (sha: string): Map<string, string> => {
      const tree = parseCommit(repo.objects.get(sha)?.data ?? Buffer.alloc(0))?.tree ?? '';
      return tree === '' ? new Map() : flattenTree(lookup, tree);
    };
    const baseTree = treeOf(currentBaseSha);
    const headTree = treeOf(pull.headSha);
    const mergeTree = base === null ? new Map<string, string>() : treeOf(base);
    // Merged tree = current base tree with the head side's changes applied.
    let mergedTreeOid = parseCommit(repo.objects.get(currentBaseSha)?.data ?? Buffer.alloc(0))?.tree ?? '';
    for (const path of new Set([...headTree.keys(), ...mergeTree.keys()])) {
      const m = mergeTree.get(path);
      const h = headTree.get(path);
      if (h === m) continue; // head did not change this path
      mergedTreeOid = updateTreePath(lookup, (t, d) => this.putObject(repo, t, d), mergedTreeOid, path, h ?? null);
    }
    void baseTree;
    if (mergedTreeOid === '') mergedTreeOid = this.putObject(repo, 'tree', Buffer.alloc(0));
    const identity = identityLine(this.viewerName, this.viewerEmail);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const commitData = buildCommit({
      tree: mergedTreeOid,
      parents: [currentBaseSha],
      author: identity,
      committer: identity,
      message,
    });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = FIXED_ISO;
    pull.merge_commit_sha = mergeSha;
    return { sha: mergeSha };
  }

  /** Objects reachable from all refs (for the git layer's clone walk). */
  reachableFromRefs(repo: Repo): Set<string> {
    return collectReachable(this.objectLookup(repo), [...repo.refs.values()]);
  }

  /** True when `ancestor` is an ancestor of (or equal to) `tip`. */
  isAncestorOf(repo: Repo, ancestor: string, tip: string): boolean {
    return isAncestor(this.objectLookup(repo), ancestor, tip);
  }
}

/** Immediate children of a tree object, as contents-API directory entries. */
function directChildren(
  lookup: (oid: string) => GitObject | undefined,
  treeOid: string,
  prefix: string,
): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] {
  const obj = lookup(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data)
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => ({
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
    }));
}
