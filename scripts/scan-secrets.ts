import * as fs from 'node:fs';
import * as path from 'node:path';

const SUSPICIOUS_PATTERNS = [
  { name: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Cloudinary API Secret Candidate', regex: /CLOUDINARY_API_SECRET\s*=\s*['"][a-zA-Z0-9_-]{20,}['"]/ },
  { name: 'Generic High-Entropy Secret Assignment', regex: /(?:SECRET_KEY|API_SECRET|JWT_SECRET)\s*=\s*['"][a-zA-Z0-9_\-+/]{32,}['"]/ },
  { name: 'Live JWT Token', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/ },
  { name: 'AWS/S3 Access Secret', regex: /(?:aws_secret_access_key|SEAWEEDFS_SECRET_KEY)\s*=\s*['"][a-zA-Z0-9/+=]{30,}['"]/i },
];

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const IGNORED_FILES = new Set(['.env.example', 'package-lock.json', 'pnpm-lock.yaml']);

export function scanFile(filePath: string): Array<{ line: number; rule: string; snippet: string }> {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const findings: Array<{ line: number; rule: string; snippet: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // skip comments in scan scripts or tests allowing placeholders
    if (line.includes('dev-insecure-') || line.includes('placeholder')) continue;

    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({
          line: i + 1,
          rule: pattern.name,
          snippet: line.trim().slice(0, 80),
        });
      }
    }
  }

  return findings;
}

export function scanDirectory(dir: string): Array<{ file: string; line: number; rule: string }> {
  const allFindings: Array<{ file: string; line: number; rule: string }> = [];

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walk(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile()) {
        if (!IGNORED_FILES.has(entry.name)) {
          const fullPath = path.join(currentDir, entry.name);
          const findings = scanFile(fullPath);
          for (const f of findings) {
            allFindings.push({
              file: path.relative(process.cwd(), fullPath),
              line: f.line,
              rule: f.rule,
            });
          }
        }
      }
    }
  }

  walk(dir);
  return allFindings;
}

function run() {
  console.log('Running secret scanner across workspace...');
  const findings = scanDirectory(process.cwd());

  if (findings.length > 0) {
    console.error(`\nSecret scanner detected potential secrets:`);
    for (const f of findings) {
      console.error(`  - ${f.file}:${f.line} [${f.rule}]`);
    }
    process.exit(1);
  } else {
    console.log('Secret scanner passed. No secrets detected on HEAD.');
  }
}

if (process.argv[1] && process.argv[1].endsWith('scan-secrets.ts')) {
  run();
}
