/**
 * serve-cmd.ts — `fozikio serve`.
 *
 * Extracted verbatim from the inline block that used to live in cli.ts, so the
 * entry point can be a router. Behaviour and flags are unchanged.
 */

import { loadConfig } from './config-loader.js';
import { createContext, startServer } from '../mcp/server.js';
import { startRestServer } from '../rest/server.js';
import { rawFlag } from '../cli/args.js';
import { c } from '../cli/ui/color.js';
import { mark } from '../cli/ui/symbols.js';

export async function runServe(argv: string[]): Promise<void> {
  const agentName = rawFlag(argv, '--agent');
  const useRest = argv.includes('--rest');
  const restPort = Number(rawFlag(argv, '--port') ?? 3000);
  const restToken = rawFlag(argv, '--token');
  const restHost = rawFlag(argv, '--host');
  const allowUnauthenticated = argv.includes('--allow-unauthenticated');
  const allowCorsLocalhost = argv.includes('--allow-cors-localhost');

  let config;
  try {
    config = loadConfig(undefined, agentName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      console.error('');
      console.error(`  ${mark.fail()} config not found`);
      console.error(`    ${c.dim('run `fozikio init` first, or use --workspace <path>')}`);
      console.error('');
    } else {
      console.error(`[fozikio] ${msg}`);
    }
    process.exit(1);
  }

  if (useRest) {
    // REST-only mode — HTTP server, no stdio MCP.
    const engine = await createContext(config);
    await startRestServer(engine, {
      port: restPort,
      host: restHost,
      token: restToken,
      allowUnauthenticated,
      allowCorsLocalhost,
    });
  } else {
    // Default: MCP stdio server.
    await startServer(config);
  }
}
