/** Capture committed artifacts, rebuild, then compare bytes (works in an untracked initial repo too). */
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';

const artifacts = ['dist/action.cjs', 'gate-action/dist/gate.cjs', 'dist/cli.js', 'dist/cli.js.map',
  'dist/api.js', 'dist/api.js.map', 'dist/api.d.ts'];
const expected = await Promise.all(artifacts.map((file) => fs.readFile(file)));
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
const stale: string[] = [];
for (const [index, file] of artifacts.entries()) {
  if (!expected[index]!.equals(await fs.readFile(file))) stale.push(file);
}
if (stale.length) throw new Error('Generated artifacts are stale; run npm run build and commit: ' + stale.join(', '));
console.log('Generated Action, gate, CLI and API artifacts match source.');
