// build.ts
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, 'package.json'), 'utf8'));
const out = resolve(import.meta.dir, 'dist/ts.mjs');

const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'src/main.ts')],
  outdir: resolve(import.meta.dir, 'dist'),
  naming: 'ts.mjs',
  target: 'node',
  format: 'esm',
  minify: false,
  define: {
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
  },
});

if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}

// Prepend shebang
const body = readFileSync(out, 'utf8');
writeFileSync(out, '#!/usr/bin/env node\n' + body);
chmodSync(out, 0o755);

console.log(`built ${out} (v${pkg.version})`);
