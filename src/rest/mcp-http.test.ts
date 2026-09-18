/**
 * mcp-http.test.ts — MCP over Streamable HTTP at /mcp on the REST server (#92).
 *
 * Drives the mounted endpoint with the SDK's own client transport: initialize → tools/list →
 * tools/call, the REST token gate, and two clients holding separate sessions over one engine.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startRestServer } from './server.js';
import type { EngineContext } from '../mcp/server.js';
import type { ToolDefinition } from '../mcp/tools.js';

const calls: string[] = [];

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echoes its input.',
  category: 'memory',
  whenToUse: 'In a test.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: async (args) => {
    calls.push(String(args['text']));
    return { echoed: args['text'], calls: calls.length };
  },
};

function fakeEngine(): EngineContext {
  return {
    ctx: {} as EngineContext['ctx'],
    activeTools: [echoTool],
    allTools: [echoTool],
    config: {} as EngineContext['config'],
  };
}

let server: HttpServer | undefined;
async function serve(token?: string): Promise<string> {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // The machine's token must not leak into an intentionally open test server.
  vi.stubEnv('CORTEX_API_TOKEN', '');
  vi.stubEnv('MARTY_API_TOKEN', '');
  server = await startRestServer(fakeEngine(), { port: 0, token, allowUnauthenticated: !token });
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('no address');
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function connect(url: string, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined));
  return client;
}

afterEach(async () => {
  calls.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('MCP over Streamable HTTP', () => {
  it('initializes, lists the active tools and calls one', async () => {
    const url = await serve();
    const client = await connect(url);
    expect(client.getServerVersion()?.name).toBe('cortex-engine');

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(tools[0]!.description).toContain('Echoes its input.');

    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual({ echoed: 'hi', calls: 1 });
    await client.close();
  });

  it('is behind the REST token', async () => {
    const url = await serve('s3cret');
    await expect(connect(url)).rejects.toThrow(/Unauthorized/);
    const client = await connect(url, { 'x-cortex-token': 's3cret' });
    expect((await client.listTools()).tools).toHaveLength(1);
    await client.close();
    const bearer = await connect(url, { Authorization: 'Bearer s3cret' });
    expect((await bearer.listTools()).tools).toHaveLength(1);
    await bearer.close();
  });

  it('gives each client its own session over the one engine', async () => {
    const url = await serve();
    const a = await connect(url);
    const b = await connect(url);
    const ta = a.transport as StreamableHTTPClientTransport;
    const tb = b.transport as StreamableHTTPClientTransport;
    expect(ta.sessionId).toBeDefined();
    expect(tb.sessionId).toBeDefined();
    expect(ta.sessionId).not.toBe(tb.sessionId);

    await a.callTool({ name: 'echo', arguments: { text: 'from a' } });
    await b.callTool({ name: 'echo', arguments: { text: 'from b' } });
    expect(calls).toEqual(['from a', 'from b']);
    await a.close();
    await b.close();
  });

  it('refuses a request for a session it does not know', async () => {
    const url = await serve();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const noSession = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(noSession.status).toBe(400);
  });
});
