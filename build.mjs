import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });
// Single source of truth for the version: package.json → dist/manifest.json.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
manifest.version = version;
writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));
await build({
  entryPoints: { app: 'src/ui/app.ts', popup: 'src/popup.ts', background: 'src/background.ts' },
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'chrome110',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
await build({ entryPoints: { content: 'src/content.ts' }, bundle: true, outdir: 'dist', format: 'iife', target: 'chrome110', logLevel: 'info' });
