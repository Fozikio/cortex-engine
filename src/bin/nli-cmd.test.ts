/**
 * Tests for the fozikio nli command's pure helpers. The provisioning/spawn
 * flow is exercised manually — it creates a virtualenv and installs torch.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serviceDir, venvPython } from './nli-cmd.js';

describe('fozikio nli helpers', () => {
  it('resolves the bundled service directory to real files', () => {
    const dir = serviceDir();
    expect(existsSync(join(dir, 'serve.py'))).toBe(true);
    expect(existsSync(join(dir, 'requirements.txt'))).toBe(true);
  });

  it('builds the platform-appropriate venv python path', () => {
    const p = venvPython(join('base', 'venv'));
    if (process.platform === 'win32') {
      expect(p).toBe(join('base', 'venv', 'Scripts', 'python.exe'));
    } else {
      expect(p).toBe(join('base', 'venv', 'bin', 'python'));
    }
  });
});
