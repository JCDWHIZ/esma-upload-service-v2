import * as os from 'node:os';
import * as path from 'node:path';
import fc from 'fast-check';
import {
  resolveInside,
  assertSafeSegment,
  ValidationError,
} from '../src/core/index.js';

describe('Path Security and Fuzzing (ARCH §3.3, P1-07)', () => {
  const rootDir = path.resolve(os.tmpdir(), 'gus-storage-root');

  describe('resolveInside', () => {
    it('allows valid relative paths within the root', () => {
      const resolved = resolveInside(rootDir, 'uploads/file.png');
      expect(resolved).toBe(path.resolve(rootDir, 'uploads/file.png'));
    });

    it('allows resolution of root itself', () => {
      const resolved = resolveInside(rootDir, '.');
      expect(resolved).toBe(rootDir);
    });

    it('rejects simple parent traversal ("../")', () => {
      expect(() => resolveInside(rootDir, '../outside.txt')).toThrow(
        ValidationError,
      );
    });

    it('rejects nested traversal disguised inside a valid folder', () => {
      expect(() =>
        resolveInside(rootDir, 'valid/subfolder/../../../../etc/passwd'),
      ).toThrow(ValidationError);
    });

    it('rejects Windows-style backslash traversal', () => {
      expect(() => resolveInside(rootDir, '..\\..\\windows\\system32')).toThrow(
        ValidationError,
      );
    });

    it('rejects null byte injection', () => {
      expect(() => resolveInside(rootDir, 'file\0.txt')).toThrow(
        ValidationError,
      );
      expect(() => resolveInside(`${rootDir}\0`, 'file.txt')).toThrow(
        ValidationError,
      );
    });

    it('rejects absolute paths pointing outside root', () => {
      const outside =
        process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/var/log';
      expect(() => resolveInside(rootDir, outside)).toThrow(ValidationError);
    });
  });

  describe('Property-Based Fuzz Testing (fast-check)', () => {
    it('assertSafeSegment: invariant holds across random arbitrary strings', () => {
      fc.assert(
        fc.property(fc.string(), (candidate) => {
          let threwValidationError = false;
          try {
            assertSafeSegment(candidate);
          } catch (err) {
            expect(err).toBeInstanceOf(ValidationError);
            threwValidationError = true;
          }

          const regex = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
          const isActuallySafe =
            typeof candidate === 'string' &&
            candidate.length > 0 &&
            candidate.length <= 128 &&
            candidate !== '.' &&
            candidate !== '..' &&
            !candidate.includes('\0') &&
            regex.test(candidate);

          if (isActuallySafe) {
            expect(threwValidationError).toBe(false);
          } else {
            expect(threwValidationError).toBe(true);
          }
        }),
        { numRuns: 1000 },
      );
    });

    it('resolveInside: never returns a path outside root across random paths', () => {
      const normalizedRoot = path.resolve(rootDir);

      fc.assert(
        fc.property(
          fc.oneof(
            fc.string(),
            fc.webPath(),
            fc.stringMatching(/^[a-zA-Z0-9/\\._-]+$/),
          ),
          (candidatePath) => {
            let result: string | null = null;
            try {
              result = resolveInside(normalizedRoot, candidatePath);
            } catch (err) {
              expect(err).toBeInstanceOf(ValidationError);
              return; // Caught and rejected safely
            }

            // Invariant: If resolveInside succeeded, result must be inside normalizedRoot
            expect(result).not.toBeNull();
            const rel = path.relative(normalizedRoot, result);
            expect(rel.startsWith('..')).toBe(false);
            expect(path.isAbsolute(rel)).toBe(false);

            const isInside =
              result === normalizedRoot ||
              result.startsWith(normalizedRoot + path.sep);
            expect(isInside).toBe(true);
          },
        ),
        { numRuns: 1000 },
      );
    });
  });
});
