// rest.ts — the GitHub REST v3 surface (/api/v3).
//
// Every handler returns a RestResult or null (null = not a route this module
// owns, so app.ts falls through to the JSON 404). Auth: every route below
// except the API root and /meta requires the bearer token (see design.md);
// a missing or wrong token is 401 JSON, a repository under another owner is
// 404 JSON, never 403. A malformed JSON body is 400 JSON. All timestamps in
// bodies are the fixed contract timestamp — never the wall clock.

import type { HandlerCtx } from './app.ts';
import { FIXED_ISO, parseCommit } from './git-objects.ts';
import type { Issue, IssueJsonCache, Label, Pull, Repo } from './store.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: Buffer;
}

type JsonObj = Record<string, unknown>;

const SCOPES = 'repo, read:org';

function ok(status: number, body: unknown, headers: Record<string, string> = {}): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is JsonObj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the request body as JSON. Empty body = {}. Bad JSON = null (caller answers 400). */
function parseBody(ctx: HandlerCtx): JsonObj | null {
  const text = ctx.body.toString('utf8').trim();
  if (text === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function intParam(ctx: HandlerCtx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Slice a list into a page and build the Link header (next/first/prev/last). */
function paginate<T>(ctx: HandlerCtx, items: readonly T[]): { page: T[]; link: string | null } {
  const perPage = Math.min(intParam(ctx, 'per_page', 30), 100);
  const page = intParam(ctx, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (totalPages <= 1) return { page: slice, link: null };
  const base = `${ctx.origin}/api/v3${restPath(ctx)}`;
  const linkFor = (p: number, rel: string): string => `<${base}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page > 1) parts.push(linkFor(1, 'first'), linkFor(page - 1, 'prev'));
  if (page < totalPages) parts.push(linkFor(page + 1, 'next'));
  parts.push(linkFor(totalPages, 'last'));
  return { page: slice, link: parts.join(', ') };
}

/** The REST path after /api/v3, without the query string (for Link headers). */
function restPath(ctx: HandlerCtx): string {
  return `/${ctx.segments.slice(2).map((s) => encodeURIComponent(s)).join('/')}`;
}

// ---------------------------------------------------------- JSON shapes

function userJson(ctx: HandlerCtx): JsonObj {
  const store = ctx.store;
  return {
    login: store.viewerLogin,
    id: store.viewerId,
    node_id: Buffer.from(`User:${store.viewerId}`).toString('base64'),
    avatar_url: '',
    html_url: `${ctx.origin}/${store.viewerLogin}`,
    type: 'User',
    name: store.viewerName,
    email: store.viewerEmail,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function repoJson(ctx: HandlerCtx, repo: Repo): JsonObj {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: {
      login: repo.owner,
      id: ctx.store.viewerId,
      type: 'User',
      html_url: `${ctx.origin}/${repo.owner}`,
    },
    private: repo.private,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    clone_url: `${ctx.origin}/${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function labelJson(label: Label): JsonObj {
  return { id: 0, name: label.name, color: label.color, description: '', default: false };
}

function issueJsonCacheIsValid(cache: IssueJsonCache, issue: Issue): boolean {
  return (
    cache.title === issue.title &&
    cache.body === issue.body &&
    cache.state === issue.state &&
    cache.commentsLength === issue.comments.length &&
    cache.labelsRef === issue.labels &&
    cache.labelsLength === issue.labels.length
  );
}

function issueJson(ctx: HandlerCtx, repo: Repo, issue: Issue): JsonObj {
  const origin = ctx.origin;

  let cacheByOrigin = issue._jsonCache;
  if (cacheByOrigin === undefined) {
    cacheByOrigin = new Map<string, IssueJsonCache>();
    issue._jsonCache = cacheByOrigin;
  }

  const cached = cacheByOrigin.get(origin);
  if (cached !== undefined && issueJsonCacheIsValid(cached, issue)) {
    return cached.json;
  }

  const json: JsonObj = {
    id: repo.id * 100000 + issue.number,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: ctx.store.viewerLogin, id: ctx.store.viewerId, type: 'User' },
    labels: issue.labels.map(labelJson),
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}`,
  };

  cacheByOrigin.set(origin, {
    title: issue.title,
    body: issue.body,
    state: issue.state,
    commentsLength: issue.comments.length,
    labelsRef: issue.labels,
    labelsLength: issue.labels.length,
    json,
  });

  return json;
}

function pullJson(ctx: HandlerCtx, repo: Repo, pull: Pull): JsonObj {
  const base = {
    id: repo.id * 100000 + pull.number,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: ctx.store.viewerLogin, id: ctx.store.viewerId, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? ctx.store.pullMergeable(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (ctx.store.pullMergeable(repo, pull) ? 'clean' : 'dirty') : 'unknown',
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      repo: repoJson(ctx, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      repo: repoJson(ctx, repo),
    },
  };
  return base;
}

function commitJson(ctx: HandlerCtx, repo: Repo, sha: string): JsonObj | null {
  const obj = ctx.store.getObject(repo, sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  if (info === null) return null;
  const authorLine = info.author;
  const name = authorLine.slice(0, authorLine.indexOf(' <'));
  const email = authorLine.slice(authorLine.indexOf('<') + 1, authorLine.indexOf('>'));
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    commit: {
      // GitHub's API presents the message without the object's trailing newline.
      message: info.message.replace(/\n$/, ''),
      author: { name, email, date: FIXED_ISO },
      committer: { name, email, date: FIXED_ISO },
      tree: { sha: info.tree },
    },
    author: { login: ctx.store.viewerLogin, id: ctx.store.viewerId, type: 'User' },
    committer: { login: ctx.store.viewerLogin, id: ctx.store.viewerId, type: 'User' },
    parents: info.parents.map((p) => ({ sha: p })),
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `${ctx.origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

// ---------------------------------------------------------- route handlers

/** Segments after /api/v3. */
function restSegs(ctx: HandlerCtx): string[] {
  return ctx.segments.slice(2);
}

function needAuth(ctx: HandlerCtx): RestResult | null {
  return ctx.tokenOk ? null : err(401, 'Bad credentials');
}

function needBody(ctx: HandlerCtx): JsonObj | RestResult {
  const body = parseBody(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  return body;
}

function isBadBody(value: JsonObj | RestResult): value is RestResult {
  return 'status' in value;
}

/** Load the repo or answer 404 (wrong owner counts as missing, never 403). */
function loadRepo(ctx: HandlerCtx, owner: string, name: string): Repo | RestResult {
  const repo = ctx.store.getRepo(owner, name);
  return repo === null ? err(404, 'Not Found') : repo;
}

function isRepoResult(value: Repo | RestResult): value is RestResult {
  return 'status' in value;
}

async function handleRoot(ctx: HandlerCtx): Promise<RestResult> {
  return ok(
    200,
    {
      current_user_url: `${ctx.origin}/api/v3/user`,
      current_user_authorizations_html_url: `${ctx.origin}/settings/applications`,
      authorizations_url: `${ctx.origin}/api/v3/authorizations`,
      code_search_url: `${ctx.origin}/api/v3/search/code?q={query}`,
      commit_search_url: `${ctx.origin}/api/v3/search/commits?q={query}`,
      emails_url: `${ctx.origin}/api/v3/user/emails`,
      emojis_url: `${ctx.origin}/api/v3/emojis`,
      events_url: `${ctx.origin}/api/v3/events`,
      feeds_url: `${ctx.origin}/api/v3/feeds`,
      followers_url: `${ctx.origin}/api/v3/user/followers`,
      following_url: `${ctx.origin}/api/v3/user/following{/other_user}`,
      gists_url: `${ctx.origin}/api/v3/gists{/gist_id}`,
      hub_url: `${ctx.origin}/api/v3/hub`,
      issue_search_url: `${ctx.origin}/api/v3/search/issues?q={query}`,
      issues_url: `${ctx.origin}/api/v3/issues`,
      keys_url: `${ctx.origin}/api/v3/user/keys`,
      label_search_url: `${ctx.origin}/api/v3/search/labels?q={query}&repository_id={repository_id}`,
      notifications_url: `${ctx.origin}/api/v3/notifications`,
      organization_url: `${ctx.origin}/api/v3/orgs/{org}`,
      organization_repositories_url: `${ctx.origin}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_teams_url: `${ctx.origin}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${ctx.origin}/api/v3/gists/public`,
      rate_limit_url: `${ctx.origin}/api/v3/rate_limit`,
      repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${ctx.origin}/api/v3/search/repositories?q={query}`,
      current_user_repositories_url: `${ctx.origin}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${ctx.origin}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${ctx.origin}/api/v3/gists/starred`,
      topic_search_url: `${ctx.origin}/api/v3/search/topics?q={query}`,
      user_url: `${ctx.origin}/api/v3/users/{user}`,
      user_organizations_url: `${ctx.origin}/api/v3/users/{user}/orgs`,
      user_repositories_url: `${ctx.origin}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${ctx.origin}/api/v3/search/users?q={query}`,
    },
    { 'x-oauth-scopes': SCOPES },
  );
}

async function handleUserRepos(ctx: HandlerCtx): Promise<RestResult> {
  const { method } = ctx;
  if (method === 'GET') {
    const auth = needAuth(ctx);
    if (auth !== null) return auth;
    const repos = ctx.store.listViewerRepos();
    const { page, link } = paginate(ctx, repos);
    const headers: Record<string, string> = {};
    if (link !== null) headers.link = link;
    return ok(200, page.map((r) => repoJson(ctx, r)), headers);
  }
  if (method === 'POST') {
    const auth = needAuth(ctx);
    if (auth !== null) return auth;
    const body = needBody(ctx);
    if (isBadBody(body)) return body;
    const name = str(body.name).trim();
    if (name === '' || name.includes('/') || name.length > 100) {
      return err(422, 'Validation Failed: name is invalid');
    }
    const repo = ctx.store.createRepo(name, bool(body.private), str(body.description));
    if (repo === null) return err(422, 'Validation Failed: name already exists on this account');
    return ok(201, repoJson(ctx, repo));
  }
  return err(404, 'Not Found');
}

async function handleRepo(ctx: HandlerCtx, owner: string, name: string): Promise<RestResult> {
  const auth = needAuth(ctx);
  if (auth !== null) return auth;
  const repo = loadRepo(ctx, owner, name);
  if (isRepoResult(repo)) return repo;
  if (ctx.method === 'GET') return ok(200, repoJson(ctx, repo));
  if (ctx.method === 'PATCH') {
    const body = needBody(ctx);
    if (isBadBody(body)) return body;
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.private = body.private;
    return ok(200, repoJson(ctx, repo));
  }
  if (ctx.method === 'DELETE') {
    ctx.store.deleteRepo(repo);
    return { status: 204, body: undefined };
  }
  return err(404, 'Not Found');
}

async function handleGitRefs(ctx: HandlerCtx, owner: string, name: string): Promise<RestResult> {
  const auth = needAuth(ctx);
  if (auth !== null) return auth;
  const repo = loadRepo(ctx, owner, name);
  if (isRepoResult(repo)) return repo;
  if (ctx.method !== 'POST') return err(404, 'Not Found');
  const body = needBody(ctx);
  if (isBadBody(body)) return body;
  const ref = str(body.ref);
  const sha = str(body.sha).toLowerCase();
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
    return err(422, 'Validation Failed: ref and sha are required');
  }
  if (ctx.store.getObject(repo, sha) === undefined) return err(422, 'Validation Failed: sha does not exist');
  if (repo.refs.has(ref)) return err(422, 'Validation Failed: ref already exists');
  repo.refs.set(ref, sha);
  return ok(201, { ref, node_id: Buffer.from(`Ref:${ref}`).toString('base64'), url: `${ctx.origin}/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref.slice(5))}`, object: { sha, type: 'commit', url: `${ctx.origin}/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
}

async function handleBranches(ctx: HandlerCtx, owner: string, name: string): Promise<RestResult> {
  const auth = needAuth(ctx);
  if (auth !== null) return auth;
  const repo = loadRepo(ctx, owner, name);
  if (isRepoResult(repo)) return repo;
  if (ctx.method !== 'GET') return err(404, 'Not Found');
  const out = ctx.store.branchNames(repo).map((branch) => ({
    name: branch,
    commit: { sha: ctx.store.refTip(repo, `refs/heads/${branch}`), url: `${ctx.origin}/api/v3/repos/${owner}/${name}/commits/${ctx.store.refTip(repo, `refs/heads/${branch}`)}` },
    protected: false,
  }));
  const { page, link } = paginate(ctx, out);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return ok(200, page, headers);
}

async function handleCommits(ctx: HandlerCtx, owner: string, name: string): Promise<RestResult> {
  const auth = needAuth(ctx);
  if (auth !== null) return auth;
  const repo = loadRepo(ctx, owner, name);
  if (isRepoResult(repo)) return repo;
  if (ctx.method !== 'GET') return err(404, 'Not Found');
  const tip = ctx.store.resolveRef(repo, ctx.query.get('sha') ?? undefined);
  if (tip === null) return ok(200, []);
  const shas = ctx.store.commitsFrom(repo, tip);
  const items: JsonObj[] = [];
  for (const sha of shas) {
    const item = commitJson(ctx, repo, sha);
    if (item !== null) items.push(item);
  }
  const { page, link } = paginate(ctx, items);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return ok(200, page, headers);
}

async function handleContents(ctx: HandlerCtx, owner: string, name: string, pathParts: string[]): Promise<RestResult> {
  const auth = needAuth(ctx);
  if (auth !== null) return auth;
  const repo = loadRepo(ctx, owner, name);
  if (isRepoResult(repo)) return repo;
  const path = pathParts.join('/');
  if (ctx.method === 'GET') {
    const ref = ctx.query.get('ref') ?? undefined;
    const read = ctx.store.readPath(repo, ref, path);
    if (read === null) return err(404, 'Not Found');
    if (read.kind === 'dir') {
      return ok(
        200,
        read.entries.map((e) => ({
          type: e.type,
          size: e.type === 'file' ? (ctx.store.getObject(repo, e.sha)?.data.length ?? 0) : 0,
          name: e.name,
          path: e.path,
          sha: e.sha,
          url: `${ctx.origin}/api/v3/repos/${owner}/${name}/contents/${e.path}`,
          html_url: `${ctx.origin}/${owner}/${name}/blob/${repo.defaultBranch}/${e.path}`,
          download_url: null,
          _links: { self: `${ctx.origin}/api/v3/repos/${owner}/${name}/contents/${e.path}` },
        })),
      );
    }
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      size: read.content.length,
      name: path.split('/').pop() ?? path,
      path,
      content: read.content.toString('base64'),
      sha: read.sha,
      url: `${ctx.origin}/api/v3/repos/${owner}/${name}/contents/${path}`,
      html_url: `${ctx.origin}/${owner}/${name}/blob/${repo.defaultBranch}/${path}`,
      download_url: `${ctx.origin}/api/v3/repos/${owner}/${name}/contents/${path}`,
      _links: { self: `${ctx.origin}/api/v3/repos/${owner}/${name}/contents/${path}` },
    });
  }
  if (ctx.method === 'PUT') {
    const body = needBody(ctx);
    if (isBadBody(body)) return body;
    const message = str(body.message);
    const contentB64 = str(body.content);
    if (message === '' || contentB64 === '') return err(422, 'Validation Failed: message and content are required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    } catch {
      return err(422, 'Validation Failed: content is not valid base64');
    }
    const branch = typeof body.branch === 'string' ? body.branch : undefined;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const existed = ctx.store.readPath(repo, branch, path);
    const result = ctx.store.commitContent(repo, { path, content, message, branch, sha });
    if ('error' in result) {
      if (result.error === 'no-branch') return err(404, 'Not Found');
      if (result.error === 'stale-sha') return err(409, 'Conflict: sha does not match the current file');
      return err(404, 'Not Found');
    }
    const status = existed !== null && existed.kind === 'file' ? 200 : 201;
    return ok(status, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: result.contentSha,
        size: content.length,
        url: `${ctx.origin}/api/v3/repos/${owner}/${name}/contents/${path}`,
        html_url: `${ctx.origin}/${owner}/${name}/blob/${repo.defaultBranch}/${path}`,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: result.commitSha, message },
    });
  }
  if (ctx.method === 'DELETE') {
    const body = needBody(ctx);
    if (isBadBody(body)) return body;
    const message = str(body.message);
    if (message === '') return err(422, 'Validation Failed: message is required');
    const branch = typeof body.branch === 'string' ? body.branch : undefined;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const result = ctx.store.commitContent(repo, { path, content: null, message, branch, sha });
    if ('error' in result) {
      if (result.error === 'no-branch') return err(404, 'Not Found');
      if (result.error === 'stale-sha') return err(409, 'Conflict: sha does not match the current file');
      return err(404, 'Not Found');
    }
    return ok(200, { content: null, commit: { sha: result.commitSha, message } });
  }
  return err(404, 'Not Found');
}

async function handleLabels(ctx: HandlerCtx, owner: string, name: string): Promise<RestResult> {
  const auth = needAuth(ctx);
  if (auth !== null) return auth;
  const repo = loadRepo(ctx, owner, name);
  if (isRepoResult(repo)) return repo;
  if (ctx.method === 'GET') {
    return ok(200, [...repo.labels.values()].map(labelJson));
  }
  if (ctx.method !== 'POST') return err(404, 'Not Found');
  const body = needBody(ctx);
  if (isBadBody(body)) return body;
  const labelName = str(body.name).trim();
  if (labelName === '') return err(422, 'Validation Failed: name is required');
  const color = str(body.color, 'ededed').replace(/^#/, '');
  const label = ctx.store.createLabel(repo, labelName, color);
  return ok(201, labelJson(label));
}

function parseIssueNumber(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 1 && String(n) === raw ? n : null;
}

async function handleIssues(ctx: HandlerCtx, owner: string, name: string, rest: string[]): Promise<RestResult> {
  const auth = needAuth(ctx);
  if (auth !== null) return auth;
  const repo = loadRepo(ctx, owner, name);
  if (isRepoResult(repo)) return repo;

  // /issues/{n} and /issues/{n}/comments
  if (rest.length >= 2) {
    const number = parseIssueNumber(rest[1] as string);
    if (number === null) return err(404, 'Not Found');
    const issue = repo.issues.get(number) ?? repo.pulls.get(number) as unknown as Issue | undefined;
    if (rest.length === 2) {
      if (ctx.method === 'GET') {
        if (issue === undefined || !('comments' in issue)) return err(404, 'Not Found');
        return ok(200, issueJson(ctx, repo, issue));
      }
      if (ctx.method === 'PATCH') {
        if (issue === undefined || !('comments' in issue)) return err(404, 'Not Found');
        const body = needBody(ctx);
        if (isBadBody(body)) return body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        return ok(200, issueJson(ctx, repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined || !('comments' in issue)) return err(404, 'Not Found');
      if (ctx.method === 'GET') {
        return ok(
          200,
          issue.comments.map((c) => ({
            id: c.id,
            node_id: Buffer.from(`IssueComment:${c.id}`).toString('base64'),
            body: c.body,
            user: { login: ctx.store.viewerLogin, id: ctx.store.viewerId, type: 'User' },
            created_at: FIXED_ISO,
            updated_at: FIXED_ISO,
            html_url: `${ctx.origin}/${owner}/${name}/issues/${number}#issuecomment-${c.id}`,
          })),
        );
      }
      if (ctx.method === 'POST') {
        const body = needBody(ctx);
        if (isBadBody(body)) return body;
        if (typeof body.body !== 'string' || body.body === '') return err(422, 'Validation Failed: body is required');
        const comment = ctx.store.addComment(repo, issue, body.body);
        return ok(201, {
          id: comment.id,
          node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
          body: comment.body,
          user: { login: ctx.store.viewerLogin, id: ctx.store.viewerId, type: 'User' },
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
          html_url: `${ctx.origin}/${owner}/${name}/issues/${number}#issuecomment-${comment.id}`,
        });
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // /issues (list + create)
  if (ctx.method === 'GET') {
    const stateParam = ctx.query.get('state') ?? 'open';
    const state = stateParam === 'all' ? 'all' : stateParam === 'closed' ? 'closed' : 'open';
    const direction = ctx.query.get('direction') ?? 'desc';
    const sortAsc = ctx.query.get('sort') === 'created' ? direction === 'asc' : false;
    const issues = ctx.store.listIssues(repo, state, sortAsc);
    const { page, link } = paginate(ctx, issues);
    const headers: Record<string, string> = {};
    if (link !== null) headers.link = link;
    return ok(200, page.map((i) => issueJson(ctx, repo, i)), headers);
  }
  if (ctx.method === 'POST') {
    const body = needBody(ctx);
    if (isBadBody(body)) return body;
    const title = str(body.title);
    if (title === '') return err(422, 'Validation Failed: title is required');
    const labelNames: string[] = Array.isArray(body.labels)
      ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string')
      : typeof body.labels === 'string'
        ? [body.labels]
        : [];
    const created = ctx.store.createIssue(repo, title, str(body.body), labelNames);
    if ('error' in created) return err(422, 'Validation Failed: a named label does not exist');
    return ok(201, issueJson(ctx, repo, created));
  }
  return err(404, 'Not Found');
}

async function handlePulls(ctx: HandlerCtx, owner: string, name: string, rest: string[]): Promise<RestResult> {
  const auth = needAuth(ctx);
  if (auth !== null) return auth;
  const repo = loadRepo(ctx, owner, name);
  if (isRepoResult(repo)) return repo;

  // /pulls/{n}, /pulls/{n}/files, /pulls/{n}/merge
  if (rest.length >= 2) {
    const number = parseIssueNumber(rest[1] as string);
    if (number === null) return err(404, 'Not Found');
    const pull = repo.pulls.get(number);
    if (rest.length === 3 && rest[2] === 'files') {
      if (ctx.method !== 'GET') return err(404, 'Not Found');
      if (pull === undefined) return err(404, 'Not Found');
      return ok(
        200,
        pull.files.map((f) => ({
          sha: '',
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          blob_url: `${ctx.origin}/${owner}/${name}/blob/${pull.headSha}/${f.filename}`,
          raw_url: `${ctx.origin}/${owner}/${name}/raw/${pull.headSha}/${f.filename}`,
          contents_url: `${ctx.origin}/api/v3/repos/${owner}/${name}/contents/${f.filename}?ref=${pull.headSha}`,
        })),
      );
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (ctx.method !== 'PUT') return err(404, 'Not Found');
      if (pull === undefined) return err(404, 'Not Found');
      const body = needBody(ctx);
      if (isBadBody(body)) return body;
      const result = ctx.store.mergePull(repo, pull);
      if ('error' in result) {
        if (result.error === 'conflict') return err(405, 'Conflict: pull request cannot be merged');
        return err(405, 'Conflict: pull request is already merged');
      }
      return ok(200, { sha: result.sha, merged: true, message: `Pull Request successfully merged` });
    }
    if (rest.length === 2) {
      if (ctx.method !== 'GET') return err(404, 'Not Found');
      if (pull === undefined) return err(404, 'Not Found');
      return ok(200, pullJson(ctx, repo, pull));
    }
    return err(404, 'Not Found');
  }

  // /pulls (list + create)
  if (ctx.method === 'GET') {
    const stateParam = ctx.query.get('state') ?? 'open';
    const state = stateParam === 'all' ? 'all' : stateParam === 'closed' ? 'closed' : 'open';
    const pulls = ctx.store.listPulls(repo, state);
    const { page, link } = paginate(ctx, pulls);
    const headers: Record<string, string> = {};
    if (link !== null) headers.link = link;
    return ok(200, page.map((p) => pullJson(ctx, repo, p)), headers);
  }
  if (ctx.method === 'POST') {
    const body = needBody(ctx);
    if (isBadBody(body)) return body;
    const title = str(body.title);
    const head = str(body.head);
    const base = str(body.base, repo.defaultBranch);
    if (title === '' || head === '') return err(422, 'Validation Failed: title and head are required');
    const created = ctx.store.createPull(repo, title, str(body.body), head, base);
    if ('error' in created) return err(422, 'Validation Failed: head or base branch does not exist');
    return ok(201, pullJson(ctx, repo, created));
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------- dispatcher

/** Handle a /api/v3 request. Returns null when the path is not a REST route. */
export async function handleRest(ctx: HandlerCtx): Promise<RestResult | null> {
  const segs = restSegs(ctx);
  const { method } = ctx;

  // API root: public, with scopes. Trailing slash already stripped by the router.
  if (segs.length === 0) {
    if (method === 'GET') return handleRoot(ctx);
    return err(404, 'Not Found');
  }
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method === 'GET') return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return err(404, 'Not Found');
  }
  if (segs.length === 1 && segs[0] === 'user') {
    if (method === 'GET') {
      const auth = needAuth(ctx);
      if (auth !== null) return auth;
      return ok(200, userJson(ctx));
    }
    return err(404, 'Not Found');
  }
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    return handleUserRepos(ctx);
  }
  if (segs.length >= 2 && segs[0] === 'repos') {
    const owner = segs[1] as string;
    const name = segs[2] as string;
    if (name === undefined || name === '') return err(404, 'Not Found');
    const rest = segs.slice(3);
    if (rest.length === 0) return handleRepo(ctx, owner, name);
    if (rest.length >= 1 && rest[0] === 'git' && rest.length >= 2 && rest[1] === 'refs') {
      return handleGitRefs(ctx, owner, name);
    }
    if (rest.length === 1 && rest[0] === 'branches') return handleBranches(ctx, owner, name);
    if (rest.length === 1 && rest[0] === 'commits') return handleCommits(ctx, owner, name);
    if (rest.length >= 1 && rest[0] === 'contents') return handleContents(ctx, owner, name, rest.slice(1));
    if (rest.length === 1 && rest[0] === 'labels') return handleLabels(ctx, owner, name);
    if (rest.length >= 1 && rest[0] === 'issues') return handleIssues(ctx, owner, name, rest);
    if (rest.length >= 1 && rest[0] === 'pulls') return handlePulls(ctx, owner, name, rest);
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}
