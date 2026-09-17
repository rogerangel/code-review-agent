/** Validation only. This repository intentionally has no npm-publishing job. */
import { promises as fs } from 'node:fs';

const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error('expected an immutable version tag such as v0.1.0 (not v1)');
}
if (tag !== 'v' + manifest.version) throw new Error('tag must match package.json version');
if (manifest.repository?.url !== 'git+https://github.com/rogerangel/code-review-agent.git') {
  throw new Error('repository metadata must match the publishing repository');
}
console.log('Version tag validated; npm publication remains disabled (private=' + manifest.private + ').');
