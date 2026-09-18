/**
 * loader.test.ts — trusted vs. untrusted plugin paths.
 *
 * Motivation: the allowlist in loader.ts exists to stop a *tool argument*
 * from pointing the engine at arbitrary code. A path listed under `plugins:`
 * in the agent's own config.yaml is not that — it's the operator's own file,
 * already trusted the way every other config value is. Before this test,
 * there was no coverage proving a repo-local plugin (e.g. Slotkeeper's
 * `.fozikio/plugins/codebase-mind`) could actually load, or that a caller
 * without the new `trusted` flag still gets the old refusal (#114).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from './loader.js';

describe('loadPlugins — trusted paths', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.restoreAllMocks();
  });

  function writeTempPlugin(): string {
    dir = mkdtempSync(join(tmpdir(), 'cortex-plugin-'));
    const file = join(dir, 'index.mjs');
    writeFileSync(
      file,
      [
        'export default {',
        "  name: 'temp-plugin',",
        '  tools: [{',
        "    name: 'temp_tool',",
        "    description: 'a temp plugin tool',",
        "    category: 'memory',",
        "    whenToUse: 'in tests',",
        "    inputSchema: { type: 'object', properties: {} },",
        '    handler: async () => ({}),',
        '  }],',
        '};',
        '',
      ].join('\n'),
    );
    return file;
  }

  it('loads a plugin from an arbitrary local path when trusted', async () => {
    const file = writeTempPlugin();

    const tools = await loadPlugins([file], undefined, { trusted: true });

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('temp_tool');
  });

  it('refuses the same path with the existing warning when not trusted', async () => {
    const file = writeTempPlugin();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const tools = await loadPlugins([file]);

    expect(tools).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Refusing to load plugin from untrusted path'),
    );
  });

  it('refuses the same path when trusted is explicitly false', async () => {
    const file = writeTempPlugin();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const tools = await loadPlugins([file], undefined, { trusted: false });

    expect(tools).toHaveLength(0);
  });
});
