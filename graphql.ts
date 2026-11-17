// graphql.ts — GitHub GraphQL v4 (builder #3).
//
// A small, dependency-free GraphQL executor for exactly the documents gh and
// github-mcp-server send: viewer/repository/node reads, __type introspection,
// issue and pull-request connections with cursor pagination, and the five
// mutations the suite drives. All reads and writes go through the same Store
// as REST and git, so ids and numbers match across surfaces. Relay global ids
// are base64 of `Type:…` (the same encoding REST uses for node_id), stable
// across reads. No clock, no randomness: every timestamp is FIXED_ISO.

import { FIXED_ISO } from './git-objects.ts';
import type { HandlerCtx } from './app.ts';
import type { RestResult } from './rest.ts';
import type { Store } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';

type Json = Record<string, unknown>;

interface GqlError {
  message: string;
  path?: (string | number)[];
}

// ---------------------------------------------------------- schema tables

/** Fields each type answers (introspection reads these; execution validates against them). */
const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'comments', 'labels', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'status', 'additions', 'deletions', 'changes'],
  Ref: ['name'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType'],
  __Schema: ['queryType', 'mutationType', 'types'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type'],
  Node: ['id'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  Ref: 'OBJECT',
  IssueComment: 'OBJECT',
  IssueEdge: 'OBJECT',
  PullRequestEdge: 'OBJECT',
  PageInfo: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  CommentEdge: 'OBJECT',
  __Type: 'OBJECT',
  __Schema: 'OBJECT',
  __Field: 'OBJECT',
  __EnumValue: 'OBJECT',
  __InputValue: 'OBJECT',
  Node: 'INTERFACE',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  OrderDirection: 'ENUM',
  IssueOrderField: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

/** The object type a field's selection set is applied to. */
const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Issue: { author: 'User', comments: 'IssueConnection' },
  PullRequest: { author: 'User', headRef: 'Ref', baseRef: 'Ref', files: 'PullRequestConnection' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequestEdge: { node: 'PullRequest' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge', comment: 'IssueComment' },
  CommentEdge: { node: 'IssueComment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue', ofType: '__Type' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
  __Field: { type: '__Type' },
  __InputValue: { type: '__Type' },
};

// ---------------------------------------------------------- global ids / cursors

function gid(type: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${type}:${parts.join(':')}`).toString('base64');
}

function decodeGid(id: unknown): { type: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const segments = text.split(':');
  const type = segments[0];
  if (type === undefined || type === '' || segments.length < 2) return null;
  return { type, parts: segments.slice(1) };
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^cursor:(\d+)$/.exec(text);
  return match === null ? null : Number.parseInt(match[1] as string, 10);
}

// ---------------------------------------------------------- lexer

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
interface Tok {
  kind: TokKind;
  value: string;
}

function lex(src: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  const push = (kind: TokKind, value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      push('punct', '...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      push('punct', ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new Error('Syntax Error: unterminated block string.');
        push('string', src.slice(i + 3, end));
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= src.length) throw new Error('Syntax Error: unterminated string.');
        const c = src[j] as string;
        if (c === '"') break;
        if (c === '\\') {
          const esc = src[j + 1] as string;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            const hex = src.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Syntax Error: invalid unicode escape.');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else if (esc in simple) {
            out += simple[esc] as string;
            j += 2;
          } else {
            throw new Error(`Syntax Error: invalid escape \\${esc}.`);
          }
          continue;
        }
        out += c;
        j += 1;
      }
      push('string', out);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (match === null) throw new Error(`Syntax Error: invalid number at offset ${i}.`);
      const text = match[0];
      push(text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', text);
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i));
      const text = (match as RegExpExecArray)[0];
      push('name', text);
      i += text.length;
      continue;
    }
    throw new Error(`Syntax Error: unexpected character ${JSON.stringify(ch)}.`);
  }
  push('eof', '');
  return tokens;
}

// ---------------------------------------------------------- parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'lit'; value: unknown }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}
interface SpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineNode {
  kind: 'inline';
  typeCond: string | null;
  selections: SelectionNode[];
}
type SelectionNode = FieldNode | SpreadNode | InlineNode;

interface VarDef {
  name: string;
  defaultValue: ValueNode | null;
}
interface OperationDef {
  op: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VarDef[];
  selections: SelectionNode[];
}
interface FragmentDef {
  name: string;
  typeCond: string;
  selections: SelectionNode[];
}
interface Document {
  operations: OperationDef[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  readonly tokens: Tok[];
  pos = 0;

  constructor(tokens: Tok[]) {
    this.tokens = tokens;
  }

  peek(): Tok {
    return this.tokens[this.pos] as Tok;
  }

  next(): Tok {
    const tok = this.tokens[this.pos] as Tok;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return tok;
  }

  expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`Syntax Error: expected "${value}", got ${tok.value || 'end of document'}.`);
  }

  acceptPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  expectName(what = 'a name'): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`Syntax Error: expected ${what}, got ${tok.value || 'end of document'}.`);
    return tok.value;
  }

  parseDocument(): Document {
    const operations: OperationDef[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ op: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name');
        const on = this.expectName('"on"');
        if (on !== 'on') throw new Error('Syntax Error: expected "on" after a fragment name.');
        const typeCond = this.expectName('a type condition');
        this.skipDirectives();
        fragments.set(name, { name, typeCond, selections: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
        const op = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        this.skipDirectives();
        operations.push({ op, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Syntax Error: unexpected ${tok.value || 'end of document'} at the top level.`);
    }
    if (operations.length === 0) throw new Error('Syntax Error: the document holds no operation.');
    return { operations, fragments };
  }

  parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    if (!this.acceptPunct('(')) return defs;
    while (!this.acceptPunct(')')) {
      if (this.peek().kind === 'eof') throw new Error('Syntax Error: unterminated variable definitions.');
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue(true);
      defs.push({ name, defaultValue });
    }
    return defs;
  }

  parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    this.acceptPunct('!');
  }

  skipDirectives(): void {
    while (this.acceptPunct('@')) {
      this.expectName('a directive name');
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          if (this.peek().kind === 'eof') throw new Error('Syntax Error: unterminated directive arguments.');
          this.expectName('an argument name');
          this.expectPunct(':');
          this.parseValue(true);
        }
      }
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('Syntax Error: unterminated selection set.');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCond = this.expectName('a type condition');
        this.skipDirectives();
        return { kind: 'inline', typeCond, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCond: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName('a field name');
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        if (this.peek().kind === 'eof') throw new Error('Syntax Error: unterminated arguments.');
        const argName = this.expectName('an argument name');
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue(false) });
      }
    }
    this.skipDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(constLiteral: boolean): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      if (constLiteral) throw new Error('Syntax Error: a variable is not allowed in a constant value.');
      return { kind: 'var', name: this.expectName('a variable name') };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (!this.acceptPunct(']')) {
        if (this.peek().kind === 'eof') throw new Error('Syntax Error: unterminated list.');
        items.push(this.parseValue(constLiteral));
      }
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.acceptPunct('}')) {
        if (this.peek().kind === 'eof') throw new Error('Syntax Error: unterminated input object.');
        const name = this.expectName('an input field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(constLiteral) });
      }
      return { kind: 'object', fields };
    }
    if (tok.kind === 'int') return { kind: 'lit', value: Number.parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'lit', value: Number.parseFloat(tok.value) };
    if (tok.kind === 'string') return { kind: 'lit', value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'lit', value: true };
      if (tok.value === 'false') return { kind: 'lit', value: false };
      if (tok.value === 'null') return { kind: 'lit', value: null };
      return { kind: 'lit', value: tok.value }; // enum value
    }
    throw new Error(`Syntax Error: unexpected ${tok.value || 'end of document'} as a value.`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'lit':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------- execution

interface ExecCtx {
  store: Store;
  origin: string;
  errors: GqlError[];
  fragments: Map<string, FragmentDef>;
  variables: Record<string, unknown>;
}

type AnyObj = Record<string, unknown>;

function userObj(ctx: ExecCtx): AnyObj {
  return { __typename: 'User', _login: ctx.store.viewerLogin, _id: ctx.store.viewerId, _name: ctx.store.viewerName, _email: ctx.store.viewerEmail };
}

function repoObj(repo: Repo): AnyObj {
  return { __typename: 'Repository', _repo: repo };
}

function issueObj(repo: Repo, issue: Issue): AnyObj {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullObj(repo: Repo, pull: Pull): AnyObj {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function commentObj(repo: Repo, issue: Issue, comment: { id: number; body: string }): AnyObj {
  return { __typename: 'IssueComment', _repo: repo, _issue: issue, _comment: comment };
}

function connectionObj(nodeType: string, items: unknown[], pageInfo: AnyObj, total: number): AnyObj {
  return { __typename: `${nodeType}Connection`, _kind: 'connection', _nodeType: nodeType, _items: items, _pageInfo: pageInfo, _total: total };
}

function pageInfoObj(hasNextPage: boolean, startCursor: string | null, endCursor: string | null): AnyObj {
  return { __typename: 'PageInfo', _hasNextPage: hasNextPage, _hasPreviousPage: false, _startCursor: startCursor, _endCursor: endCursor };
}

interface PageSlice<T> {
  page: T[];
  pageInfo: AnyObj;
}

function paginate<T>(items: readonly T[], first: unknown, after: unknown): PageSlice<T> {
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const decoded = decodeCursor(after);
    if (decoded !== null) start = decoded + 1;
  }
  if (start > items.length) start = items.length;
  const count = typeof first === 'number' && Number.isFinite(first) && first >= 0 ? Math.floor(first) : items.length;
  const page = items.slice(start, start + count);
  const endIndex = start + page.length - 1;
  return {
    page,
    pageInfo: pageInfoObj(endIndex < items.length - 1, page.length > 0 ? encodeCursor(start) : null, page.length > 0 ? encodeCursor(endIndex) : null),
  };
}

function repoById(ctx: ExecCtx, id: number): Repo | null {
  for (const repo of ctx.store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

function findRepo(ctx: ExecCtx, owner: unknown, name: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  return ctx.store.getRepo(owner, name);
}

/** Resolve one field on one wrapper object. May throw an Error for a failed mutation. */
function resolveField(ctx: ExecCtx, typeName: string, fieldName: string, value: AnyObj, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  switch (typeName) {
    case 'Query': {
      if (fieldName === 'viewer') return userObj(ctx);
      if (fieldName === 'repository') {
        const repo = findRepo(ctx, args.owner, args.name);
        return repo === null ? null : repoObj(repo);
      }
      if (fieldName === 'node') {
        const decoded = decodeGid(args.id);
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = repoById(ctx, Number.parseInt(decoded.parts[0] ?? '', 10));
          return repo === null ? null : repoObj(repo);
        }
        if (decoded.type === 'Issue') {
          const repo = repoById(ctx, Number.parseInt(decoded.parts[0] ?? '', 10));
          const issue = repo?.issues.get(Number.parseInt(decoded.parts[1] ?? '', 10));
          return repo !== undefined && repo !== null && issue !== undefined ? issueObj(repo, issue) : null;
        }
        if (decoded.type === 'PullRequest') {
          const repo = repoById(ctx, Number.parseInt(decoded.parts[0] ?? '', 10));
          const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1] ?? '', 10));
          return repo !== undefined && repo !== null && pull !== undefined ? pullObj(repo, pull) : null;
        }
        return null;
      }
      if (fieldName === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
        return { __typename: '__Type', _typeName: name };
      }
      if (fieldName === '__schema') return { __typename: '__Schema' };
      return null;
    }
    case 'Mutation':
      return resolveMutation(ctx, fieldName, args);
    case 'User': {
      if (fieldName === 'id') return gid('User', value._id as number);
      if (fieldName === 'login') return value._login;
      if (fieldName === 'name') return value._name;
      if (fieldName === 'email') return value._email;
      return null;
    }
    case 'Repository': {
      const repo = value._repo as Repo;
      switch (fieldName) {
        case 'id':
          return gid('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userObj(ctx);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { __typename: 'Ref', _name: repo.defaultBranch };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issues.get(args.number as number);
          return issue === undefined ? null : issueObj(repo, issue);
        }
        case 'issues': {
          let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
          if (Array.isArray(args.states)) {
            const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          if (isRecord(args.orderBy) && args.orderBy.direction === 'DESC') list = [...list].reverse();
          const { page, pageInfo } = paginate(list, args.first, args.after);
          return connectionObj('Issue', page.map((issue) => issueObj(repo, issue)), pageInfo, list.length);
        }
        case 'pullRequests': {
          const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
          const { page, pageInfo } = paginate(list, args.first, args.after);
          return connectionObj('PullRequest', page.map((pull) => pullObj(repo, pull)), pageInfo, list.length);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(args.number as number);
          return pull === undefined ? null : pullObj(repo, pull);
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const repo = value._repo as Repo;
      const issue = value._issue as Issue;
      switch (fieldName) {
        case 'id':
          return gid('Issue', repo.id, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        case 'author':
          return userObj(ctx);
        case 'createdAt':
        case 'updatedAt':
          return FIXED_ISO;
        case 'url':
          return `${ctx.origin}/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'labels':
          return [];
        case 'comments': {
          const { page, pageInfo } = paginate(issue.comments, args.first, args.after);
          return connectionObj('IssueComment', page.map((c) => commentObj(repo, issue, c)), pageInfo, issue.comments.length);
        }
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = value._repo as Repo;
      const pull = value._pull as Pull;
      switch (fieldName) {
        case 'id':
          return gid('PullRequest', repo.id, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef':
          return { __typename: 'Ref', _name: pull.headRef };
        case 'baseRef':
          return { __typename: 'Ref', _name: pull.baseRef };
        case 'files': {
          const items = pull.files.map((f) => ({ __typename: 'PullRequestChangedFile', _file: f }));
          const { page, pageInfo } = paginate(items, args.first, args.after);
          return connectionObj('PullRequestChangedFile', page, pageInfo, items.length);
        }
        case 'author':
          return userObj(ctx);
        case 'createdAt':
        case 'updatedAt':
          return FIXED_ISO;
        case 'url':
          return `${ctx.origin}/${repo.owner}/${repo.name}/pull/${pull.number}`;
        default:
          return null;
      }
    }
    case 'PullRequestChangedFile': {
      const f = value._file as unknown as { filename: string; status: string; additions: number; deletions: number; changes: number };
      switch (fieldName) {
        case 'path':
        case 'filename':
          return f.filename;
        case 'status':
          return f.status;
        case 'additions':
          return f.additions;
        case 'deletions':
          return f.deletions;
        case 'changes':
          return f.changes;
        default:
          return null;
      }
    }
    case 'Ref':
      return fieldName === 'name' ? value._name : null;
    case 'IssueComment': {
      const repo = value._repo as Repo;
      const comment = value._comment as { id: number; body: string };
      switch (fieldName) {
        case 'id':
          return gid('IssueComment', comment.id);
        case 'body':
          return comment.body;
        case 'author':
          return userObj(ctx);
        case 'createdAt':
          return FIXED_ISO;
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      if (fieldName === 'nodes') return value._items;
      if (fieldName === 'edges') {
        const items = value._items as unknown[];
        return items.map((item, index) => ({ __typename: `${value._nodeType as string}Edge`, _node: item, _cursor: encodeCursor(index) }));
      }
      if (fieldName === 'pageInfo') return value._pageInfo;
      if (fieldName === 'totalCount') return value._total;
      return null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'CommentEdge': {
      if (fieldName === 'node') return value._node;
      if (fieldName === 'cursor') return value._cursor;
      return null;
    }
    case 'PageInfo': {
      if (fieldName === 'hasNextPage') return value._hasNextPage;
      if (fieldName === 'hasPreviousPage') return value._hasPreviousPage;
      if (fieldName === 'startCursor') return value._startCursor;
      if (fieldName === 'endCursor') return value._endCursor;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (fieldName === 'issue') return value._issue;
      if (fieldName === 'clientMutationId') return value._clientMutationId ?? null;
      return null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (fieldName === 'pullRequest') return value._pull;
      if (fieldName === 'clientMutationId') return value._clientMutationId ?? null;
      return null;
    case 'AddCommentPayload':
      if (fieldName === 'commentEdge') return { __typename: 'CommentEdge', _node: value._comment, _cursor: encodeCursor(0) };
      if (fieldName === 'comment') return value._comment;
      if (fieldName === 'clientMutationId') return value._clientMutationId ?? null;
      return null;
    case '__Type': {
      const typeName = value._typeName as string;
      switch (fieldName) {
        case 'name':
          return typeName;
        case 'kind':
          return TYPE_KIND[typeName] ?? 'OBJECT';
        case 'description':
          return null;
        case 'fields':
          return (TYPE_FIELDS[typeName] ?? []).map((name) => ({ __typename: '__Field', _name: name }));
        case 'enumValues':
          return (ENUM_VALUES[typeName] ?? []).map((name) => ({ __typename: '__EnumValue', _name: name }));
        case 'inputFields':
        case 'interfaces':
        case 'possibleTypes':
          return [];
        case 'ofType':
          return null;
        default:
          return null;
      }
    }
    case '__Schema': {
      if (fieldName === 'queryType') return { __typename: '__Type', _typeName: 'Query' };
      if (fieldName === 'mutationType') return { __typename: '__Type', _typeName: 'Mutation' };
      if (fieldName === 'types') return Object.keys(TYPE_FIELDS).map((name) => ({ __typename: '__Type', _typeName: name }));
      return null;
    }
    case '__Field':
      if (fieldName === 'name') return value._name;
      if (fieldName === 'description') return null;
      if (fieldName === 'args') return [];
      if (fieldName === 'type') return { __typename: '__Type', _typeName: 'String' };
      return null;
    case '__EnumValue':
      if (fieldName === 'name') return value._name;
      if (fieldName === 'description') return null;
      return null;
    case '__InputValue':
      if (fieldName === 'name') return value._name;
      if (fieldName === 'description') return null;
      if (fieldName === 'type') return { __typename: '__Type', _typeName: 'String' };
      return null;
    default:
      return null;
  }
}

/** Apply a selection set to a wrapper value of the given type. */
function applySelections(ctx: ExecCtx, typeName: string, value: AnyObj, selections: SelectionNode[], path: (string | number)[]): Json {
  const out: Json = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path: [...path] });
        continue;
      }
      if (frag.typeCond === typeName || frag.typeCond === (value.__typename as string)) {
        Object.assign(out, applySelections(ctx, typeName, value, frag.selections, path));
      }
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCond === null || sel.typeCond === typeName || sel.typeCond === (value.__typename as string)) {
        Object.assign(out, applySelections(ctx, typeName, value, sel.selections, path));
      }
      continue;
    }
    const outKey = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[outKey] = typeName === 'Node' ? (value.__typename as string) : typeName;
      continue;
    }
    const known = (TYPE_FIELDS[typeName] ?? []).includes(sel.name) || sel.name === '__typename';
    if (!known) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".`, path: [...path, outKey] });
      out[outKey] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of sel.args) args[arg.name] = evalValue(arg.value, ctx.variables);
    let fieldValue: unknown;
    try {
      fieldValue = resolveField(ctx, typeName, sel.name, value, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, outKey] });
      out[outKey] = null;
      continue;
    }
    // A connection wrapper names the type its nodes/edges hold; the generic
    // field table cannot (files nodes are PullRequestChangedFile, issue
    // comments are IssueComment), so pass it down explicitly.
    let hint: string | undefined;
    if (value._kind === 'connection') {
      if (sel.name === 'nodes') hint = value._nodeType as string;
      if (sel.name === 'edges') hint = `${value._nodeType as string}Edge`;
    }
    out[outKey] = applyValue(ctx, typeName, sel.name, fieldValue, sel.selections, [...path, outKey], hint);
  }
  return out;
}

/** Apply a field's sub-selections (if any) to the resolved value. */
function applyValue(
  ctx: ExecCtx,
  typeName: string,
  fieldName: string,
  fieldValue: unknown,
  selections: SelectionNode[] | null,
  path: (string | number)[],
  childTypeHint?: string,
): unknown {
  if (fieldValue === null || fieldValue === undefined) return null;
  if (selections === null) return fieldValue;
  if (Array.isArray(fieldValue)) {
    const childType = childTypeHint ?? childTypeOf(typeName, fieldName, fieldValue);
    return fieldValue.map((item) => {
      if (item === null || typeof item !== 'object') return item;
      return applySelections(ctx, childType, item as AnyObj, selections, path);
    });
  }
  if (typeof fieldValue !== 'object') return fieldValue;
  const obj = fieldValue as AnyObj;
  let childType = childTypeHint ?? childTypeOf(typeName, fieldName, fieldValue);
  if (childType === 'Node') childType = (obj.__typename as string) ?? 'Node';
  if (typeName === 'PullRequest' && fieldName === 'files') childType = 'PullRequestConnection';
  return applySelections(ctx, childType, obj, selections, path);
}

function childTypeOf(typeName: string, fieldName: string, fieldValue: unknown): string {
  const mapped = FIELD_TYPE[typeName]?.[fieldName];
  if (mapped !== undefined) return mapped;
  if (isRecord(fieldValue) && typeof fieldValue.__typename === 'string') return fieldValue.__typename;
  return 'String';
}

// ---------------------------------------------------------- mutations

function resolveMutation(ctx: ExecCtx, fieldName: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  const input = isRecord(args.input) ? args.input : {};
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  if (fieldName === 'createIssue') {
    const decoded = decodeGid(input.repositoryId);
    if (decoded === null || decoded.type !== 'Repository') throw new Error('createIssue: the repositoryId does not name a repository.');
    const repo = repoById(ctx, Number.parseInt(decoded.parts[0] ?? '', 10));
    if (repo === null) throw new Error('createIssue: the repository does not exist.');
    const title = input.title;
    if (typeof title !== 'string' || title === '') throw new Error('createIssue: a title is required.');
    const body = typeof input.body === 'string' ? input.body : '';
    const created = store.createIssue(repo, title, body, []);
    if ('error' in created) throw new Error('createIssue: the issue could not be created.');
    return { __typename: 'CreateIssuePayload', _issue: issueObj(repo, created), _clientMutationId: clientMutationId };
  }
  if (fieldName === 'closeIssue') {
    const decoded = decodeGid(input.issueId);
    if (decoded === null || decoded.type !== 'Issue') throw new Error('closeIssue: the issueId does not name an issue.');
    const repo = repoById(ctx, Number.parseInt(decoded.parts[0] ?? '', 10));
    const issue = repo?.issues.get(Number.parseInt(decoded.parts[1] ?? '', 10));
    if (repo === null || issue === undefined) throw new Error('closeIssue: the issue does not exist.');
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', _issue: issueObj(repo, issue), _clientMutationId: clientMutationId };
  }
  if (fieldName === 'createPullRequest') {
    const decoded = decodeGid(input.repositoryId);
    if (decoded === null || decoded.type !== 'Repository') throw new Error('createPullRequest: the repositoryId does not name a repository.');
    const repo = repoById(ctx, Number.parseInt(decoded.parts[0] ?? '', 10));
    if (repo === null) throw new Error('createPullRequest: the repository does not exist.');
    const title = input.title;
    const head = input.headRefName;
    const base = input.baseRefName;
    if (typeof title !== 'string' || title === '') throw new Error('createPullRequest: a title is required.');
    if (typeof head !== 'string' || typeof base !== 'string') throw new Error('createPullRequest: headRefName and baseRefName are required.');
    const body = typeof input.body === 'string' ? input.body : '';
    const created = store.createPull(repo, title, body, head, base);
    if ('error' in created) throw new Error('createPullRequest: the head or base branch does not exist.');
    return { __typename: 'CreatePullRequestPayload', _pull: pullObj(repo, created), _clientMutationId: clientMutationId };
  }
  if (fieldName === 'mergePullRequest') {
    const decoded = decodeGid(input.pullRequestId);
    if (decoded === null || decoded.type !== 'PullRequest') throw new Error('mergePullRequest: the pullRequestId does not name a pull request.');
    const repo = repoById(ctx, Number.parseInt(decoded.parts[0] ?? '', 10));
    const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1] ?? '', 10));
    if (repo === null || pull === undefined) throw new Error('mergePullRequest: the pull request does not exist.');
    const result = store.mergePull(repo, pull);
    if ('error' in result) {
      if (result.error === 'conflict') throw new Error('mergePullRequest: the pull request cannot be merged.');
      throw new Error('mergePullRequest: the pull request is already merged.');
    }
    return { __typename: 'MergePullRequestPayload', _pull: pullObj(repo, pull), _clientMutationId: clientMutationId };
  }
  if (fieldName === 'addComment') {
    const decoded = decodeGid(input.subjectId);
    if (decoded === null || decoded.type !== 'Issue') throw new Error('addComment: the subjectId does not name an issue.');
    const repo = repoById(ctx, Number.parseInt(decoded.parts[0] ?? '', 10));
    const issue = repo?.issues.get(Number.parseInt(decoded.parts[1] ?? '', 10));
    if (repo === null || issue === undefined) throw new Error('addComment: the issue does not exist.');
    const body = input.body;
    if (typeof body !== 'string' || body === '') throw new Error('addComment: a body is required.');
    const comment = store.addComment(repo, issue, body);
    return { __typename: 'AddCommentPayload', _comment: commentObj(repo, issue, comment), _clientMutationId: clientMutationId };
  }
  throw new Error(`Unknown mutation "${fieldName}".`);
}

// ---------------------------------------------------------- handler

interface OperationResult {
  data: Json | null;
  errors?: GqlError[];
}

function runOperation(ctx: HandlerCtx, operation: unknown): OperationResult {
  if (!isRecord(operation) || typeof operation.query !== 'string') {
    return { data: null, errors: [{ message: 'The request body must be an object with a "query" string.' }] };
  }
  const variables = isRecord(operation.variables) ? (operation.variables as Record<string, unknown>) : {};
  const operationName = typeof operation.operationName === 'string' ? operation.operationName : undefined;
  let doc: Document;
  try {
    doc = new Parser(lex(operation.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let selected: OperationDef | undefined;
  if (operationName !== undefined) {
    selected = doc.operations.find((op) => op.name === operationName);
    if (selected === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else {
    if (doc.operations.length > 1) {
      return { data: null, errors: [{ message: 'The document holds more than one operation and no operationName was given.' }] };
    }
    selected = doc.operations[0] as OperationDef;
  }
  const mergedVariables: Record<string, unknown> = {};
  for (const def of selected.varDefs) {
    if (def.defaultValue !== null) mergedVariables[def.name] = evalValue(def.defaultValue, variables);
  }
  for (const [key, value] of Object.entries(variables)) mergedVariables[key] = value;
  const exec: ExecCtx = {
    store: ctx.store,
    origin: ctx.origin,
    errors: [],
    fragments: doc.fragments,
    variables: mergedVariables,
  };
  const rootType = selected.op === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyObj = { __typename: rootType };
  const data = applySelections(exec, rootType, root, selected.selections, []);
  const result: OperationResult = { data };
  if (exec.errors.length > 0) result.errors = exec.errors;
  return result;
}

/** Handle POST /api/graphql. Returns null when the path is not this module's. */
export async function handleGraphql(ctx: HandlerCtx): Promise<RestResult | null> {
  if (ctx.segments.length !== 2 || ctx.segments[0] !== 'api' || ctx.segments[1] !== 'graphql') return null;
  if (ctx.method !== 'POST') return null;
  if (!ctx.tokenOk) return { status: 401, body: { message: 'Bad credentials' } };
  const text = ctx.body.toString('utf8').trim();
  if (text === '') {
    return { status: 400, body: { errors: [{ message: 'The request body must be a JSON object with a "query" string.' }] } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Syntax Error: the request body is not valid JSON.' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => runOperation(ctx, entry)) };
  }
  return { status: 200, body: runOperation(ctx, parsed) };
}
