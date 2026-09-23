import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

// Check only maintained source and tests; generated profiles and dependencies
// are intentionally outside this list.
const sourceDirectories = ['server', 'public', 'scripts', 'tests'];
let failed = false;
for (const dir of sourceDirectories) {
  for (const file of (await readdir(dir)).sort()) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(dir, file)], { stdio: 'inherit' });
    if (result.error) console.error(`${dir}/${file}: ${result.error.message}`);
    if (result.status !== 0) failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
