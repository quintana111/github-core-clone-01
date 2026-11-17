// graphql.ts — GitHub GraphQL v4 (builder #3).
//
// STUB: builder #1 leaves this unimplemented. Builder #3 implements:
//   POST /api/graphql  {query, variables} with the bearer token (401 without)
// The documents gh and github-mcp-server send: viewer{login},
// repository(owner:, name:) fields, __type introspection for Issue /
// PullRequest / Repository / SearchType, issues(first, after, states,
// orderBy) with cursor pagination, issue(number:), pullRequests(first),
// createIssue / closeIssue / addComment / createPullRequest /
// mergePullRequest mutations, node(id:) Relay global ids, batched operation
// documents, unknown-field errors as HTTP 200 with an errors array, and
// unknown repositories as data.repository = null with no errors.
// All reads and writes go through the same Store as REST.

import type { HandlerCtx } from './app.ts';
import type { RestResult } from './rest.ts';

export async function handleGraphql(_ctx: HandlerCtx): Promise<RestResult | null> {
  // TODO(builder #3): implement GraphQL v4. Returning null lets app.ts
  // answer the generic JSON 404 for now.
  return null;
}
