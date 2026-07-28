/**
 * The SWC builder mirrors the source tree, so it emits dist/src/main.js instead
 * of dist/main.js (what tsc produced and what pm2, the Dockerfile and the start
 * scripts all expect). This flattens dist/src/* up into dist/ after the build so
 * the entry stays dist/main.js and nothing downstream needs to change.
 *
 * Safe/no-op when there is no dist/src (e.g. a tsc build).
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const nested = path.join(dist, 'src');

if (!fs.existsSync(nested)) process.exit(0);

for (const entry of fs.readdirSync(nested)) {
  const from = path.join(nested, entry);
  const to = path.join(dist, entry);
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
}
fs.rmSync(nested, { recursive: true, force: true });
console.log('flatten-dist: moved dist/src/* → dist/');
