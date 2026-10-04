// Re-snapshots the adblock.turtlecute.org host list into tests/fixtures/adblock-probes.json.
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = 'https://adblock.turtlecute.org/js/index.js';
const script = await (await fetch(source)).text();
const match = script.match(/JSON\.parse\('((?:[^'\\]|\\.)*)'\)/);
if (!match) throw new Error('Probe list not found; the tester bundle changed shape.');
const groups = JSON.parse(JSON.parse(`"${match[1].replace(/"/g, '\\"')}"`));
const count = Object.values(groups).flatMap(g => Object.values(g)).flat().length;
await writeFile(resolve(root, 'tests/fixtures/adblock-probes.json'), JSON.stringify({
  source: 'https://adblock.turtlecute.org/ (js/index.js)',
  retrieved: new Date().toISOString().slice(0, 10),
  note: 'Snapshot of the tester host list. Refresh with tools/refresh-adblock-probes.mjs.',
  groups
}, null, 2) + '\n');
console.log(`Saved ${count} hosts from ${source}`);
