/**
 * MCP over Streamable HTTP (#92).
 *
 * One engine, one process, many MCP clients. The REST server mounts this at `/mcp`; each client
 * session gets its own SDK `Server` + `StreamableHTTPServerTransport` pair, all sharing the
 * `EngineContext`. That is the answer to the one-process-per-SQLite-file rule in
 * docs/concurrency.md: several Claude Code sessions (a main checkout and its worktrees, or a
 * hosted instance) talk to one server instead of each spawning a stdio server on the same file.
 *
 * Stateful sessions, keyed by the SDK's `mcp-session-id` header:
 *   - POST /mcp with an `initialize` request and no session id opens a session.
 *   - POST /mcp with a session id routes to that session's transport.
 *   - GET /mcp with a session id opens the session's SSE stream (server → client notifications).
 *   - DELETE /mcp with a session id closes the session.
 * A session id the server does not know answers 404, as the SDK specifies.
 *
 * Auth is the REST server's: it checks the token before handing the request here.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { EngineContext } from './server.js';
import { createMcpServer } from './server.js';

export const MCP_PATH = '/mcp';

/** The request-body shape the SDK needs to tell an `initialize` from the rest. */
type JsonRpcBody = Record<string, unknown> | Record<string, unknown>[] | undefined;

export interface McpHttpHandler {
  /** Route one HTTP request. The body, when already read by the caller, is passed through. */
  handle(req: IncomingMessage, res: ServerResponse, body?: JsonRpcBody): Promise<void>;
  /** Open sessions right now (for the status line and tests). */
  sessionCount(): number;
  /** Close every session — called when the HTTP server shuts down. */
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<JsonRpcBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text.trim()) return undefined;
  return JSON.parse(text) as JsonRpcBody;
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** Build the `/mcp` handler over a shared engine. */
export function createMcpHttpHandler(engine: EngineContext): McpHttpHandler {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function openSession(): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, transport); },
      onsessionclosed: (id) => { sessions.delete(id); },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = createMcpServer(engine);
    await server.connect(transport);
    return transport;
  }

  return {
    async handle(req, res, body) {
      const method = req.method ?? 'GET';
      const sessionId = req.headers['mcp-session-id'];
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

      if (method === 'POST') {
        let parsed: JsonRpcBody;
        try {
          parsed = body ?? await readJson(req);
        } catch {
          jsonRpcError(res, 400, -32700, 'Parse error: body is not JSON');
          return;
        }
        if (existing) {
          await existing.handleRequest(req, res, parsed);
          return;
        }
        if (typeof sessionId === 'string') {
          jsonRpcError(res, 404, -32001, 'Session not found');
          return;
        }
        if (!isInitializeRequest(parsed)) {
          jsonRpcError(res, 400, -32000, 'Bad Request: no session; send an initialize request first');
          return;
        }
        const transport = await openSession();
        await transport.handleRequest(req, res, parsed);
        return;
      }

      if (method === 'GET' || method === 'DELETE') {
        if (!existing) {
          jsonRpcError(res, typeof sessionId === 'string' ? 404 : 400, -32001,
            typeof sessionId === 'string' ? 'Session not found' : 'Bad Request: mcp-session-id header required');
          return;
        }
        await existing.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { Allow: 'GET, POST, DELETE' });
      res.end();
    },

    sessionCount: () => sessions.size,

    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map((t) => t.close()));
    },
  };
}
