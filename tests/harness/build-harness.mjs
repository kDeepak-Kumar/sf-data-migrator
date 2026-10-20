import { build } from 'esbuild';
import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const out = process.argv[2];
mkdirSync(out, { recursive: true });
cpSync('static', out, { recursive: true });
await build({ entryPoints: ['tests/harness/harness.ts'], bundle: true, outfile: `${out}/harness.js`, format: 'iife', target: 'chrome110' });
await build({ entryPoints: ['src/ui/app.ts'], bundle: true, outfile: `${out}/app-iife.js`, format: 'iife', target: 'chrome110' });
const html = readFileSync('static/app.html', 'utf8').replace('<script type="module" src="app.js"></script>', '<script src="harness.js"></script><script src="app-iife.js"></script>');
writeFileSync(`${out}/harness.html`, html);
