/**
 * MCP Server for cortex-engine.
 *
 * Wires providers, stores, namespaces, triggers, and bridges together
 * and exposes them as MCP tools over stdio.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CortexConfig } from '../core/config.js';
import { Session } from '../core/session.js';
import { NamespaceManager } from '../namespace/manager.js';
import { TriggerRegistry } from '../triggers/registry.js';
import { BridgeRegistry } from '../bridges/registry.js';
import { SqliteCortexStore } from '../stores/sqlite.js';
import { OllamaEmbedProvider, OllamaLLMProvider } from '../providers/ollama.js';
import { createTools, CORE_TOOLS } from './tools.js';
import type { ToolContext } from './tools.js';

// ─── Server Factory ───────────────────────────────────────────────────────────

export async function createServer(config: CortexConfig): Promise<Server> {
  // 1. Create providers based on config
  const embed = createEmbedProvider(config);
  const llm = createLLMProvider(config);

  // 2. Create namespace manager with store factory
  const namespaces = new NamespaceManager(config, (_namespace, prefix) => {
    if (config.store === 'sqlite') {
      return new SqliteCortexStore(
        config.store_options?.sqlite_path ?? './cortex.db',
        prefix,
      );
    }
    throw new Error(`Unsupported store: ${config.store}`);
  });

  // 3. Create registries
  const triggers = new TriggerRegistry(config.namespaces);
  const bridges = new BridgeRegistry(config.bridges ?? []);

  // 4. Create session (auto-detect model)
  const detected = Session.detectModel();
  const provenanceConfig = config.model_provenance ?? {
    default_model: 'unknown',
    confidence_tiers: { high: [], medium: [], low: [] },
    conflict_policy: 'latest_wins' as const,
  };
  const session = new Session(
    detected.modelId,
    detected.modelFamily,
    detected.client,
    provenanceConfig.default_model,
    provenanceConfig,
  );

  // 5. Build tool context
  const ctx: ToolContext = { namespaces, embed, llm, session, triggers, bridges };

  // 6. Get all tools and filter by config + core
  const allTools = createTools();
  const activeToolNames = namespaces.getActiveTools();
  for (const t of CORE_TOOLS) {
    activeToolNames.add(t);
  }
  const activeTools = allTools.filter(t => activeToolNames.has(t.name));

  // 7. Create MCP server
  const server = new Server(
    { name: 'cortex-engine', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ListTools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeTools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // CallTool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = activeTools.find(t => t.name === name);

    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(args ?? {}, ctx);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error in tool "${name}": ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/** Start the MCP server using stdio transport. Called by bin/serve.ts. */
export async function startServer(config: CortexConfig): Promise<void> {
  const server = await createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─── Provider Factories ───────────────────────────────────────────────────────

function createEmbedProvider(config: CortexConfig): OllamaEmbedProvider {
  switch (config.embed) {
    case 'ollama':
      return new OllamaEmbedProvider({
        model: config.embed_options?.ollama_model,
        baseUrl: config.embed_options?.ollama_url,
      });
    default:
      throw new Error(`Embed provider "${config.embed}" not yet implemented in this build`);
  }
}

function createLLMProvider(config: CortexConfig): OllamaLLMProvider {
  switch (config.llm) {
    case 'ollama':
      return new OllamaLLMProvider({
        model: config.llm_options?.ollama_model,
        baseUrl: config.llm_options?.ollama_url,
      });
    default:
      throw new Error(`LLM provider "${config.llm}" not yet implemented in this build`);
  }
}
