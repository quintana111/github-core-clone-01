// mcp.ts — Model Context Protocol over Streamable HTTP (builder #3).
//
// JSON-RPC 2.0, answered as application/json (the client also accepts SSE,
// but one JSON body per request is the simpler legal answer). Speaks the
// modern 2026-07-28 era: server/discover answers identity, capabilities and
// supportedVersions; every request may declare its revision in _meta. The
// legacy handshake (initialize + notifications/initialized, 2025-11-25 and
// earlier) is answered too, so a client that predates discover still connects.
// Tools act on the same Store as REST and GraphQL. No clock, no randomness.

import type { HandlerCtx } from './app.ts';
import type { RestResult } from './rest.ts';
import type { Issue, Pull, Repo } from './store.ts';

type Json = Record<string, unknown>;

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strArg(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

// ---------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Json;
}

function tool(name: string, description: string, properties: Json, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, additionalProperties: false, required } };
}

const stringProp = (description: string): Json => ({ type: 'string', description });
const boolProp = (description: string): Json => ({ type: 'boolean', description });
const intProp = (description: string): Json => ({ type: 'integer', description });

const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    name: stringProp('The repository name.'),
    description: stringProp('A short description of the repository.'),
    private: boolProp('Whether the repository is private.'),
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: stringProp('The repository owner login.'),
    repo: stringProp('The repository name.'),
    full_name: stringProp('The repository full name, "owner/repo".'),
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: stringProp('The repository owner login.'),
    repo: stringProp('The repository name.'),
    full_name: stringProp('The repository full name, "owner/repo".'),
    title: stringProp('The issue title.'),
    body: stringProp('The issue body.'),
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository.', {
    owner: stringProp('The repository owner login.'),
    repo: stringProp('The repository name.'),
    full_name: stringProp('The repository full name, "owner/repo".'),
    state: stringProp('Filter by state: open, closed or all.'),
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: stringProp('The repository owner login.'),
    repo: stringProp('The repository name.'),
    full_name: stringProp('The repository full name, "owner/repo".'),
    title: stringProp('The pull request title.'),
    body: stringProp('The pull request body.'),
    head: stringProp('The head branch name.'),
    base: stringProp('The base branch name.'),
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge an open pull request with a squash merge.', {
    owner: stringProp('The repository owner login.'),
    repo: stringProp('The repository name.'),
    full_name: stringProp('The repository full name, "owner/repo".'),
    pull_number: intProp('The pull request number.'),
  }, ['owner', 'repo', 'pull_number']),
  tool('list_repos', 'List the repositories owned by the authenticated user.', {
    owner: stringProp('The owner login (defaults to the authenticated user).'),
  }, []),
  tool('get_issue', 'Get one issue by number.', {
    owner: stringProp('The repository owner login.'),
    repo: stringProp('The repository name.'),
    full_name: stringProp('The repository full name, "owner/repo".'),
    issue_number: intProp('The issue number.'),
    number: intProp('The issue number.'),
  }, ['owner', 'repo']),
]);

/** The tools array is one frozen constant, so two tools/list calls answer byte for byte. */

// ---------------------------------------------------------- store helpers

function repoJson(ctx: HandlerCtx, repo: Repo): Json {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: ctx.store.viewerId, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}`,
    clone_url: `${ctx.origin}/${repo.owner}/${repo.name}.git`,
    has_issues: true,
  };
}

function issueJson(ctx: HandlerCtx, repo: Repo, issue: Issue): Json {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: ctx.store.viewerLogin, id: ctx.store.viewerId, type: 'User' },
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: issue.comments.length,
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(ctx: HandlerCtx, repo: Repo, pull: Pull): Json {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    html_url: `${ctx.origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** Resolve owner/repo from the many spellings the suite may send. */
function resolveRepoArgs(args: Json): { owner: string | null; repo: string | null } {
  let owner = strArg(args.owner) ?? strArg(args.owner_login) ?? null;
  let repo = strArg(args.repo) ?? strArg(args.repository) ?? strArg(args.repository_name) ?? null;
  const full = strArg(args.full_name) ?? strArg(args.repo_full_name) ?? null;
  if (full !== null && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    if (owner === null) owner = o ?? null;
    if (repo === null) repo = r ?? null;
  }
  return { owner, repo };
}

function loadRepo(ctx: HandlerCtx, args: Json): Repo | null {
  const { owner, repo } = resolveRepoArgs(args);
  if (owner === null || repo === null) return null;
  return ctx.store.getRepo(owner, repo);
}

function intArg(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

// ---------------------------------------------------------- tool calls

interface ToolOutcome {
  result: Json;
}

function toolResult(payload: unknown): ToolOutcome {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { result: { content: [{ type: 'text', text }], structuredContent: payload, isError: false } };
}

function toolError(message: string): ToolOutcome {
  return { result: { content: [{ type: 'text', text: message }], isError: true } };
}

function callTool(ctx: HandlerCtx, name: string, args: Json): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args.name) ?? strArg(args.repo) ?? strArg(args.repository);
      if (repoName === null) return toolError('create_repo: "name" is required.');
      const repo = ctx.store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      if (repo === null) return toolError(`create_repo: a repository named "${repoName}" already exists or the name is invalid.`);
      return toolResult(repoJson(ctx, repo));
    }
    case 'get_repo': {
      const repo = loadRepo(ctx, args);
      if (repo === null) return toolError('get_repo: the repository was not found.');
      return toolResult(repoJson(ctx, repo));
    }
    case 'create_issue': {
      const repo = loadRepo(ctx, args);
      if (repo === null) return toolError('create_issue: the repository was not found.');
      const title = strArg(args.title);
      if (title === null) return toolError('create_issue: "title" is required.');
      const body = typeof args.body === 'string' ? args.body : '';
      const created = ctx.store.createIssue(repo, title, body, []);
      if ('error' in created) return toolError('create_issue: the issue could not be created.');
      return toolResult(issueJson(ctx, repo, created));
    }
    case 'list_issues': {
      const repo = loadRepo(ctx, args);
      if (repo === null) return toolError('list_issues: the repository was not found.');
      const stateParam = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const state = stateParam === 'all' ? 'all' : stateParam === 'closed' ? 'closed' : 'open';
      const issues = ctx.store.listIssues(repo, state, false).map((issue) => issueJson(ctx, repo, issue));
      return toolResult({ issues });
    }
    case 'create_pull_request': {
      const repo = loadRepo(ctx, args);
      if (repo === null) return toolError('create_pull_request: the repository was not found.');
      const title = strArg(args.title);
      const head = strArg(args.head) ?? strArg(args.head_ref) ?? strArg(args.head_branch);
      const base = strArg(args.base) ?? strArg(args.base_ref) ?? strArg(args.base_branch);
      if (title === null) return toolError('create_pull_request: "title" is required.');
      if (head === null || base === null) return toolError('create_pull_request: "head" and "base" are required.');
      const body = typeof args.body === 'string' ? args.body : '';
      const created = ctx.store.createPull(repo, title, body, head, base);
      if ('error' in created) return toolError('create_pull_request: the head or base branch does not exist.');
      const out = pullJson(ctx, repo, created);
      out.head = head;
      out.base = base;
      out.head_ref = head;
      out.base_ref = base;
      return toolResult(out);
    }
    case 'merge_pull_request': {
      const repo = loadRepo(ctx, args);
      if (repo === null) return toolError('merge_pull_request: the repository was not found.');
      const number = intArg(args.pull_number) ?? intArg(args.pull_request_number) ?? intArg(args.number);
      if (number === null) return toolError('merge_pull_request: "pull_number" is required.');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`merge_pull_request: pull request #${number} does not exist.`);
      const result = ctx.store.mergePull(repo, pull);
      if ('error' in result) {
        if (result.error === 'conflict') return toolError(`merge_pull_request: pull request #${number} cannot be merged.`);
        return toolError(`merge_pull_request: pull request #${number} is already merged.`);
      }
      const out = pullJson(ctx, repo, pull);
      out.sha = result.sha;
      return toolResult(out);
    }
    case 'list_repos': {
      const repos = ctx.store.listViewerRepos().map((repo) => repoJson(ctx, repo));
      return toolResult({ repositories: repos });
    }
    case 'get_issue': {
      const repo = loadRepo(ctx, args);
      if (repo === null) return toolError('get_issue: the repository was not found.');
      const number = intArg(args.issue_number) ?? intArg(args.number);
      if (number === null) return toolError('get_issue: "issue_number" is required.');
      const issue = repo.issues.get(number);
      if (issue === undefined) return toolError(`get_issue: issue #${number} does not exist.`);
      return toolResult(issueJson(ctx, repo, issue));
    }
    default:
      // Unknown tools are a JSON-RPC error, never an HTTP 500; the caller
      // distinguishes this from a tool outcome via the `rpcError` field.
      return { result: { __rpcError: -32602, __rpcMessage: `Unknown tool: ${name}` } };
  }
}

// ---------------------------------------------------------- JSON-RPC

interface RpcResponse {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): RpcResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function discoverResult(): Json {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    resultType: 'discover',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
    serverInfo,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

function handleRpc(ctx: HandlerCtx, request: Json): RpcResponse {
  const id = 'id' in request ? request.id : null;
  const method = request.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request: "method" is required.');
  const params = isRecord(request.params) ? request.params : {};
  if (method.startsWith('notifications/')) {
    return { status: 202, body: {} };
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, discoverResult());
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const negotiated = offered !== null && LEGACY_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list': {
      // The tools array is one frozen constant, so two calls serialise
      // byte for byte identically.
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : null;
      if (toolName === null) return rpcError(id, -32602, 'Invalid params: tools/call needs a "name".');
      if (params.arguments !== undefined && !isRecord(params.arguments)) {
        return rpcError(id, -32602, 'Invalid params: "arguments" must be an object.');
      }
      const outcome = callTool(ctx, toolName, isRecord(params.arguments) ? params.arguments : {});
      const marker = outcome.result as Json;
      if (typeof marker.__rpcError === 'number') {
        return rpcError(id, marker.__rpcError as number, (marker.__rpcMessage as string) ?? 'Unknown tool.');
      }
      return rpcResult(id, outcome.result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Extract a JSON-RPC id from a body that failed to parse (for the -32700 answer). */
function extractId(text: string): unknown {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text);
  if (match === null) return null;
  const raw = match[1] as string;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return Number.parseInt(raw, 10);
}

/** Handle /mcp. Returns null when the path is not this module's. */
export async function handleMcp(ctx: HandlerCtx): Promise<RestResult | null> {
  if (ctx.segments.length !== 1 || ctx.segments[0] !== 'mcp') return null;
  if (ctx.method === 'DELETE') return { status: 204, body: undefined };
  if (ctx.method !== 'POST') return null;
  if (!ctx.tokenOk) return { status: 401, body: { message: 'Bad credentials' } };
  const text = ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: extractId(text), error: { code: -32700, message: 'Parse error: the request body is not valid JSON.' } },
    };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: the body must be a JSON-RPC object.' } } };
  }
  const response = handleRpc(ctx, parsed);
  return { status: response.status, body: response.body };
}
