// git.ts — git smart HTTP (builder #2).
//
// STUB: builder #1 leaves this unimplemented. Builder #2 implements:
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   (v2 + v0)
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  (v0)
//   POST /{owner}/{repo}.git/git-upload-pack   (protocol v2, v0 fallback)
//   POST /{owner}/{repo}.git/git-receive-pack  (v0, report-status, side-band-64k,
//                                              delete-refs, fast-forward only)
// over the same Store (store.ts) and object primitives (git-objects.ts) that
// REST uses, so REST contents commits and git pushes share one history.
// Unknown repositories are 404 and the server stays up.

import type { HandlerCtx } from './app.ts';
import type { RestResult } from './rest.ts';

export async function handleGit(_ctx: HandlerCtx): Promise<RestResult | null> {
  // TODO(builder #2): implement git smart HTTP. Returning null lets app.ts
  // answer the generic JSON 404 for now.
  return null;
}
