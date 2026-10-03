import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpUploadsDir } from '../helpers/tmp-dir.js';

describe('tmpUploadsDir', () => {
  it('creates directory and asserts it is empty initially', () => {
    const dir = tmpUploadsDir('test-empty-');
    try {
      expect(fs.existsSync(dir.path)).toBe(true);
      expect(() => dir.assertEmpty()).not.toThrow();
      expect(dir.listFiles()).toEqual([]);
    } finally {
      dir.cleanup();
    }
  });

  it('assertEmpty() throws when files exist in directory', () => {
    const dir = tmpUploadsDir('test-not-empty-');
    try {
      const file = path.join(dir.path, 'leftover.bin');
      fs.writeFileSync(file, 'dirty bytes');
      expect(() => dir.assertEmpty()).toThrow(/Expected temp directory/);
      expect(dir.listFiles()).toEqual(['leftover.bin']);
    } finally {
      dir.cleanup();
    }
  });

  it('cleanup() removes directory cleanly', () => {
    const dir = tmpUploadsDir('test-cleanup-');
    expect(fs.existsSync(dir.path)).toBe(true);
    dir.cleanup();
    expect(fs.existsSync(dir.path)).toBe(false);
  });
});
