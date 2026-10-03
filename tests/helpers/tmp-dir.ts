import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface TmpUploadsDir {
  path: string;
  assertEmpty(): void;
  cleanup(): void;
  listFiles(): string[];
}

export function tmpUploadsDir(prefix = 'esma-staging-test-'): TmpUploadsDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  return {
    path: dir,
    assertEmpty(): void {
      if (!fs.existsSync(dir)) {
        return;
      }
      const files = fs.readdirSync(dir);
      if (files.length > 0) {
        throw new Error(
          `Expected temp directory "${dir}" to be empty, but found ${files.length} file(s): ${files.join(', ')}`,
        );
      }
    },
    cleanup(): void {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    listFiles(): string[] {
      if (!fs.existsSync(dir)) {
        return [];
      }
      return fs.readdirSync(dir);
    },
  };
}
