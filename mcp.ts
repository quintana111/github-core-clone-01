// mcp.ts — Model Context Protocol over streamable HTTP (builder #3).
//
// STUB: builder #1 leaves this unimplemented. Builder #3 implements:
//   POST /mcp  JSON-RPC 2.0, revision 2026-07-28 (or the 2025-11-25
//   handshake via initialize + notifications/initialized), tools/list with
//   at least create_repo, get_repo, create_issue, list_issues,
//   create_pull_request, merge_pull_request (byte-identical across calls),
//   tools/call acting on the same Store as REST, unknown tools as -32602 /
//   -32601 (never HTTP 500), missing arguments as isError:true or -32602,
//   non-JSON bodies as HTTP 400 with -32700, no token as 401, and
//   concurrent calls keeping their own JSON-RPC ids.

import type { HandlerCtx } from './app.ts';
import type { RestResult } from './rest.ts';

export async function handleMcp(_ctx: HandlerCtx): Promise<RestResult | null> {
  // TODO(builder #3): implement MCP. Returning null lets app.ts answer the
  // generic JSON 404 for now.
  return null;
}
