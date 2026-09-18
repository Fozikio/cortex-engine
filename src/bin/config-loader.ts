/**
 * config-loader.ts — shared config loading for cortex-engine.
 *
 * Config search order:
 *   1. .fozikio/agent.yaml    (new workspace format)
 *   2. .fozikio/config.yaml   (legacy workspace format — backward compatible)
 *   3. cortex.config.yaml     (project root)
 *   4. config.yaml            (project root)
 *   5. defaults               (sqlite + ollama)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG } from '../core/config.js';
import type { CortexConfig, AgentConfig, AgentEntry } from '../core/config.js';

/** Named cortex entry from agent.yaml (new format). */
interface NamedCortexEntry {
  store?: string;
  embed?: string;
  llm?: string;
  primary?: boolean;
  collections_prefix?: string;
  cognitive_tools?: string[];
  llm_options?: CortexConfig['llm_options'];
  embed_options?: CortexConfig['embed_options'];
  store_options?: CortexConfig['store_options'];
  /** Plugin packages or paths (see plugins/loader.ts); lifted onto the config like the provider fields. */
  plugins?: CortexConfig['plugins'];
  nli?: CortexConfig['nli'];
}

/**
 * Detect whether the `cortex` block is the new named-map format (agent.yaml).
 *
 * New format: cortex values are objects with store/embed/primary.
 * Old format: cortex.store is a string.
 */
function isNamedCortexMap(cortex: unknown): cortex is Record<string, NamedCortexEntry> {
  if (!cortex || typeof cortex !== 'object') return false;
  const values = Object.values(cortex as Record<string, unknown>);
  // Named map: every value is an object (not a primitive)
  return values.length > 0 && values.every(v => v !== null && typeof v === 'object');
}

/**
 * Extract a CortexConfig from a named cortex map (agent.yaml new format).
 * Finds the entry marked `primary: true`, or falls back to the first entry.
 *
 * Pulls provider-level fields (store/embed/llm and their *_options blocks)
 * onto the partial config. If the entry declares `cognitive_tools` or a
 * custom `collections_prefix`, pre-populates `partial.namespaces[entryName]`
 * so applyAgentScope later preserves the explicit config instead of
 * injecting the default 5-tool set.
 */
function extractFromNamedCortexMap(cortexMap: Record<string, NamedCortexEntry>): Partial<CortexConfig> {
  const entries = Object.entries(cortexMap);
  const primary = entries.find(([, v]) => v.primary === true) ?? entries[0];

  if (!primary) return {};

  const [namespaceName, entry] = primary;
  const partial: Partial<CortexConfig> = {};

  if (entry.store === 'sqlite' || entry.store === 'firestore') {
    partial.store = entry.store;
  }
  if (entry.embed === 'built-in' || entry.embed === 'ollama' || entry.embed === 'vertex') {
    partial.embed = entry.embed;
  }
  if (entry.llm === 'ollama' || entry.llm === 'gemini' || entry.llm === 'anthropic' || entry.llm === 'openai' || entry.llm === 'kimi') {
    partial.llm = entry.llm;
  }
  if (entry.llm_options) partial.llm_options = entry.llm_options;
  if (entry.embed_options) partial.embed_options = entry.embed_options;
  if (entry.store_options) partial.store_options = entry.store_options;
  // `plugins` and `nli` sit on CortexConfig beside the provider fields, but until 1.9.1 only the
  // legacy flat `cortex:` block carried them through: the named map dropped both, so a repo's own
  // plugin listed under its agent's entry (the 1.9.0 `trusted` path's whole point) never loaded.
  if (entry.plugins) partial.plugins = entry.plugins;
  if (entry.nli) partial.nli = entry.nli;

  if (entry.cognitive_tools || entry.collections_prefix) {
    partial.namespaces = {
      ...DEFAULT_CONFIG.namespaces,
      [namespaceName]: {
        description: `Namespace for ${namespaceName}`,
        cognitive_tools: entry.cognitive_tools ?? ['observe', 'query', 'recall', 'neighbors', 'predict'],
        collections_prefix: entry.collections_prefix ?? `${namespaceName}_`,
      },
    };
  }

  return partial;
}

/**
 * Resolve an agent's namespace from the agents block.
 * Returns the namespace string, or null if agent not found.
 */
function resolveAgentNamespace(
  parsed: AgentConfig,
  agentName: string,
): AgentEntry | null {
  const agents = parsed.agents;
  if (!agents || !(agentName in agents)) return null;
  return agents[agentName];
}

/**
 * Apply agent scoping to a CortexConfig: set the agent's namespace as default
 * and ensure collections_prefix is derived when missing.
 */
function applyAgentScope(config: CortexConfig, entry: AgentEntry): CortexConfig {
  const ns = entry.namespace;
  const scoped = { ...config };

  // Ensure the namespace exists
  scoped.namespaces = { ...scoped.namespaces };

  if (!scoped.namespaces[ns]) {
    // Create a minimal namespace entry
    scoped.namespaces[ns] = {
      default: true,
      description: entry.description ?? `Namespace for agent ${ns}`,
      cognitive_tools: ['observe', 'query', 'recall', 'neighbors', 'predict'],
      collections_prefix: `${ns}_`,
    };
  } else {
    // Ensure collections_prefix is set
    const nsConfig = { ...scoped.namespaces[ns] };
    if (!nsConfig.collections_prefix) {
      nsConfig.collections_prefix = `${ns}_`;
    }
    scoped.namespaces[ns] = nsConfig;
  }

  // Set this namespace as default, unset others
  for (const key of Object.keys(scoped.namespaces)) {
    scoped.namespaces[key] = {
      ...scoped.namespaces[key],
      default: key === ns,
    };
  }

  return scoped;
}

const ENV_STORE = new Set<CortexConfig['store']>(['sqlite', 'firestore']);
const ENV_EMBED = new Set<CortexConfig['embed']>(['built-in', 'ollama', 'vertex']);
const ENV_LLM = new Set<CortexConfig['llm']>(['ollama', 'gemini', 'anthropic', 'openai', 'kimi']);

/**
 * Apply environment-variable overrides on top of a loaded config.
 *
 * Containers and one-click deploys (Railway, Fly, Cloud Run) rarely ship a
 * config file, so without this a hosted server silently falls back to
 * `llm: ollama` and every LLM-backed tool fails at first use. Env wins over
 * the file — the usual twelve-factor precedence.
 *
 *   CORTEX_STORE        sqlite | firestore
 *   CORTEX_EMBED        built-in | ollama | vertex
 *   CORTEX_LLM          ollama | gemini | anthropic | openai | kimi
 *   CORTEX_SQLITE_PATH  path to the SQLite file (store_options.sqlite_path)
 *
 * Unknown values are ignored with a warning rather than crashing the server:
 * a typo in a deploy panel should not take the whole service down.
 */
export function applyEnvOverrides(
  config: CortexConfig,
  env: NodeJS.ProcessEnv = process.env,
): CortexConfig {
  const out: CortexConfig = { ...config };

  const pick = <T extends string>(name: string, allowed: Set<T>): T | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    if (allowed.has(raw as T)) return raw as T;
    console.error(
      `[cortex-engine] Ignoring ${name}="${raw}" — expected one of: ${[...allowed].join(', ')}`,
    );
    return undefined;
  };

  const store = pick('CORTEX_STORE', ENV_STORE);
  if (store) out.store = store;

  const embed = pick('CORTEX_EMBED', ENV_EMBED);
  if (embed) out.embed = embed;

  const llm = pick('CORTEX_LLM', ENV_LLM);
  if (llm) out.llm = llm;

  const sqlitePath = env['CORTEX_SQLITE_PATH']?.trim();
  if (sqlitePath) {
    out.store_options = { ...out.store_options, sqlite_path: sqlitePath };
  }

  return out;
}

/**
 * Load config from disk (search order in the file header) and apply env
 * overrides on top. Returns defaults + env when no file is found.
 */
export function loadConfig(cwd: string = process.cwd(), agentName?: string): CortexConfig {
  const fromFile = loadFileConfig(cwd, agentName);

  if (!fromFile && agentName) {
    console.error(`[cortex-engine] Agent "${agentName}" requested but no config file found.`);
    process.exit(1);
  }

  const config = applyEnvOverrides(fromFile ?? DEFAULT_CONFIG);

  if (!fromFile) {
    console.error(
      `[cortex-engine] No config file found, using defaults ` +
      `(store=${config.store}, embed=${config.embed}, llm=${config.llm})`,
    );
  }

  return config;
}

/** Read the first config file found; null when none exists. */
function loadFileConfig(cwd: string, agentName?: string): CortexConfig | null {
  const searchPaths = [
    resolve(cwd, '.fozikio', 'agent.yaml'),
    resolve(cwd, '.fozikio', 'config.yaml'),
    resolve(cwd, 'cortex.config.yaml'),
    resolve(cwd, 'config.yaml'),
  ];

  for (const configPath of searchPaths) {
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = parseYaml(raw) as AgentConfig | CortexConfig;

        if (parsed && typeof parsed === 'object' && 'cortex' in parsed && parsed.cortex) {
          const cortex = parsed.cortex;
          let config: CortexConfig;

          // New agent.yaml format: cortex is a named map of { store, embed, primary }
          if (isNamedCortexMap(cortex)) {
            config = { ...DEFAULT_CONFIG, ...extractFromNamedCortexMap(cortex) };
          } else {
            // Legacy AgentConfig format: cortex is a flat CortexConfig object
            config = { ...DEFAULT_CONFIG, ...(cortex as Partial<CortexConfig>) };
          }

          // Refuse to load configs that embed API keys directly — the file
          // tends to end up checked into git. Operators must use env vars
          // (OPENAI_API_KEY) or pass the key programmatically via options.
          if (config.llm_options?.openai_api_key) {
            throw new Error(
              '[cortex-engine] openai_api_key found in config file. ' +
              'Remove it and use the OPENAI_API_KEY environment variable instead — ' +
              'cortex-engine refuses to load configs that embed secrets to prevent accidental commit.',
            );
          }

          // Apply agent scoping if agentName is provided
          if (agentName) {
            const agentParsed = parsed as AgentConfig;
            const entry = resolveAgentNamespace(agentParsed, agentName);
            if (!entry) {
              console.error(`[cortex-engine] Agent "${agentName}" not found in agents block.`);
              process.exit(1);
            }
            config = applyAgentScope(config, entry);
          }

          return config;
        }

        // Top-level CortexConfig format (no agents block possible)
        if (agentName) {
          console.error(`[cortex-engine] Agent "${agentName}" requested but config has no agents block.`);
          process.exit(1);
        }
        return { ...DEFAULT_CONFIG, ...(parsed as Partial<CortexConfig>) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cortex-engine] Failed to parse config at ${configPath}: ${message}`);
      }
    }
  }

  // No config found — the caller decides what that means.
  return null;
}
