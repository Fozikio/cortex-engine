/**
 * Plugin loader — dynamically imports plugin packages and extracts tool definitions.
 *
 * Plugins are npm packages or local paths that export a ToolPlugin object as their
 * default export. Each plugin contributes a set of ToolDefinition[] to the engine.
 *
 * Local paths are checked against a node_modules allowlist (see below) unless
 * the caller passes `{ trusted: true }` — reserved for paths that came from
 * the agent's own config.yaml, not from a tool argument (#114).
 */

import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolDefinition } from '../mcp/tools.js';
import type { ToolPlugin } from '../mcp/tools.js';

/**
 * Resolve a plugin specifier to an importable path.
 *
 * npm packages (e.g., "@fozikio/tools-threads") are returned as-is.
 * Relative paths (e.g., "./plugins/custom") are resolved against cwd,
 * not the loader file location, then converted to a file:// URL for ESM.
 */
function resolvePluginPath(spec: string): string {
  // npm package names start with a letter, @, or are scoped
  if (!spec.startsWith('.') && !spec.startsWith('/') && !isAbsolute(spec)) {
    return spec; // npm package — let Node resolve it
  }
  // Relative or absolute path — resolve against cwd and convert to file URL
  const abs = resolve(process.cwd(), spec);
  return pathToFileURL(abs).href;
}

export interface LoadPluginsOptions {
  /**
   * Skip the node_modules allowlist below. Pass this only for paths that
   * came from the agent's own config.yaml (`plugins:`), never for a path
   * that arrived as a tool argument.
   *
   * The allowlist was built to stop a *tool call* from pointing the engine
   * at arbitrary code — an argument an LLM can be steered into choosing.
   * A config file is not that: it's the operator's own file, already
   * trusted the same way every other config value (store path, LLM
   * provider, federation URL) is trusted with no allowlist of its own.
   * Refusing a config-declared path just because it isn't under
   * node_modules blocked the legitimate case (a repo shipping its own
   * plugin, e.g. `.fozikio/plugins/codebase-mind`) while doing nothing for
   * the threat model the check was written for (#114).
   */
  trusted?: boolean;
}

/**
 * Load plugins by dynamic import and return a flat array of contributed tools.
 *
 * Each plugin module must have a default export conforming to ToolPlugin:
 *   { name: string, tools: ToolDefinition[] }
 *
 * Invalid plugins are skipped with a console warning (fail-open for resilience).
 * Duplicate tool names are detected and skipped with a warning.
 */
export async function loadPlugins(
  pluginPaths: string[],
  coreToolNames?: Set<string>,
  options?: LoadPluginsOptions,
): Promise<ToolDefinition[]> {
  if (pluginPaths.length === 0) return [];

  const tools: ToolDefinition[] = [];
  const seenNames = new Set<string>(coreToolNames ?? []);
  const trusted = options?.trusted ?? false;

  for (const spec of pluginPaths) {
    try {
      const importPath = resolvePluginPath(spec);

      // Validate plugin path is within trusted directories — unless the
      // caller marked this whole call `trusted` (see LoadPluginsOptions).
      // npm packages (no leading . or /) are resolved by Node and always come
      // from node_modules, so they pass through. Local paths must resolve to
      // an @fozikio or cortex- prefixed package in node_modules.
      //
      // Note: the cwd is NOT a trusted root. Previously `resolve('.')` was in
      // the allowlist, which trivially defeated the sandbox — any file under
      // the working directory was treated as trusted. With the cwd removed,
      // operators who genuinely want to load a local plugin from outside
      // node_modules must either publish it under node_modules/@fozikio/* or
      // node_modules/cortex-* (via a workspace link, npm link, or local
      // install), or list it in config.yaml's `plugins:` and let the caller
      // pass `trusted: true` (untrusted callers, e.g. anything driven by a
      // tool argument, always keep the node_modules rule).
      if (!trusted && importPath.startsWith('file://')) {
        const resolved = new URL(importPath).pathname.replace(/^\/([A-Z]:)/i, '$1'); // Windows drive letter fix
        const allowedPrefixes = [
          resolve('node_modules', '@fozikio'),
          resolve('node_modules', 'cortex-'),
        ];
        const isAllowed = allowedPrefixes.some(prefix => resolved.startsWith(prefix));
        if (!isAllowed) {
          console.error(`[cortex-engine] Refusing to load plugin from untrusted path: ${resolved}`);
          continue;
        }
      }

      const mod = await import(importPath) as { default?: ToolPlugin };
      const plugin = mod.default;

      if (!plugin || typeof plugin.name !== 'string' || !Array.isArray(plugin.tools)) {
        console.warn(`[cortex-engine] Plugin "${spec}" does not export a valid ToolPlugin (expected { name, tools }). Skipping.`);
        continue;
      }

      let added = 0;
      for (const tool of plugin.tools) {
        if (typeof tool.name !== 'string' || typeof tool.handler !== 'function') {
          console.warn(`[cortex-engine] Plugin "${plugin.name}" has invalid tool definition. Skipping tool.`);
          continue;
        }
        if (seenNames.has(tool.name)) {
          console.warn(`[cortex-engine] Plugin "${plugin.name}" defines tool "${tool.name}" which already exists. Skipping duplicate.`);
          continue;
        }
        seenNames.add(tool.name);
        tools.push(tool);
        added++;
      }

      console.log(`[cortex-engine] Loaded plugin "${plugin.name}" with ${added} tool(s).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[cortex-engine] Failed to load plugin "${spec}": ${message}. Skipping.`);
    }
  }

  return tools;
}
