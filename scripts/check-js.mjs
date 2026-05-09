import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();

const includeDirs = [
  'api',
  'lib',
  'public',
  'scripts'
];

const skipDirs = new Set([
  '.git',
  '.vercel',
  'node_modules',
  'dist',
  '_release'
]);

function walk(dir, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }

    if (entry.isFile() && /\.(js|mjs)$/i.test(entry.name)) {
      out.push(full);
    }
  }

  return out;
}

const files = includeDirs.flatMap(dir => {
  const full = join(root, dir);
  try {
    if (!statSync(full).isDirectory()) return [];
    return walk(full);
  } catch {
    return [];
  }
});

if (!files.length) {
  console.error('No JS files found.');
  process.exit(1);
}

let failed = 0;

for (const file of files) {
  const rel = relative(root, file).replaceAll('\\', '/');
  const out = spawnSync(process.execPath, ['--check', file], {
    stdio: 'pipe',
    encoding: 'utf8'
  });

  if (out.status !== 0) {
    failed += 1;
    console.error('');
    console.error('Syntax check failed:', rel);
    if (out.stdout) console.error(out.stdout.trim());
    if (out.stderr) console.error(out.stderr.trim());
  } else {
    console.log('OK', rel);
  }
}

if (failed > 0) {
  console.error('');
  console.error(`JS syntax check failed: ${failed} file(s)`);
  process.exit(1);
}

console.log('');
console.log(`JS syntax check passed: ${files.length} file(s)`);