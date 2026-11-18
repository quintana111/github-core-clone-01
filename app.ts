// app.ts — thin HTTP router for the forge.
//
// This file owns plumbing only: reading the request body (bounded), parsing
// the URL, assigning a request id, checking the bearer token, and dispatching
// to the surface handlers (rest.ts, git.ts, graphql.ts, mcp.ts). It owns no
// business logic and no stored state beyond one Store and one request
// counter. Every reply is JSON and carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestResult } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface HandlerCtx {
  readonly store: Store;
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
  readonly origin: string;
  readonly tokenOk: boolean;
  readonly tokenPresent: boolean;
}

function tokenOf(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(auth.trim());
  return match === null ? null : (match[1] as string);
}

/** The shared store, created once per process. */
export function createStore(): Store {
  return new Store();
}

let requestSeq = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const requestId = `req-${String(requestSeq).padStart(8, '0')}`;
  const outHeaders: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId,
  };
  if (text !== '') outHeaders['content-length'] = String(Buffer.byteLength(text));
  for (const key of Object.keys(headers)) {
    outHeaders[key] = headers[key] as string;
  }
  res.writeHead(status, outHeaders);
  res.end(text);
}

function sendResult(res: ServerResponse, result: RestResult): void {
  sendJson(res, result.status, result.body, result.headers ?? {});
}

function pathSegments(req: IncomingMessage): string[] {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const out: string[] = [];
  for (const s of path.split('/')) {
    if (s === '') continue;
    if (s.includes('%')) {
      try {
        out.push(decodeURIComponent(s));
        continue;
      } catch {
        // Fall through to the raw segment, as before.
      }
    }
    out.push(s);
  }
  return out;
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  if (q === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(q + 1));
}

function readBody(req: IncomingMessage): Promise<Buffer | { error: 'too-large' }> {
  return new Promise((resolve) => {
    let firstChunk: Buffer | undefined;
    let chunks: Buffer[] | undefined;
    let total = 0;
    let done = false;

    const finish = (value: Buffer | { error: 'too-large' }): void => {
      if (done) return;
      done = true;
      resolve(value);
    };

    const bodySoFar = (): Buffer => {
      if (firstChunk === undefined) return Buffer.alloc(0);
      if (chunks === undefined) return firstChunk;
      return Buffer.concat(chunks, total);
    };

    req.on('data', (chunk: Buffer) => {
      if (done) return;

      total += chunk.length;

      if (total > MAX_BODY_BYTES) {
        finish({ error: 'too-large' });
        req.destroy();
        return;
      }

      if (firstChunk === undefined) {
        firstChunk = chunk;
      } else if (chunks === undefined) {
        chunks = [firstChunk, chunk];
      } else {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (!done) finish(bodySoFar());
    });

    req.on('error', () => {
      if (!done) finish(bodySoFar());
    });
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(store: Store = createStore()): Server {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestSeq += 1;
    void (async () => {
      const method = req.method ?? 'GET';
      const segments = pathSegments(req);
      const query = queryOf(req);
      const body = await readBody(req);
      if (typeof body === 'object' && 'error' in body) {
        sendJson(res, 413, { message: 'Request body too large' });
        return;
      }
      const host = req.headers.host ?? '127.0.0.1';
      const origin = `http://${host}`;
      const presented = tokenOf(req);
      const tokenOk = expectedToken !== '' && presented !== null && presented === expectedToken;
      const ctx: HandlerCtx = {
        store,
        method,
        segments,
        query,
        headers: req.headers,
        body: body as Buffer,
        origin,
        tokenOk,
        tokenPresent: presented !== null,
      };

      // The env's boot probe: no token, always 200.
      if (method === 'GET' && segments.length === 0) {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      try {
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const result = await handleRest(ctx);
          if (result !== null) {
            sendResult(res, result);
            return;
          }
        } else if (segments[0] === 'api' && segments[1] === 'graphql') {
          const result = await handleGraphql(ctx);
          if (result !== null) {
            sendResult(res, result);
            return;
          }
        } else if (segments[0] === 'mcp') {
          const result = await handleMcp(ctx);
          if (result !== null) {
            sendResult(res, result);
            return;
          }
        } else if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
          const result = await handleGit(ctx);
          if (result !== null) {
            if (result.raw !== undefined) {
              res.writeHead(result.status, result.headers);
              res.end(result.raw);
              return;
            }
            sendResult(res, result);
            return;
          }
        }
      } catch {
        sendJson(res, 500, { message: 'Internal Server Error' });
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })();
  });
}
