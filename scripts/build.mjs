import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['packages/guard/src/main.ts'],
  outfile: 'dist/guard.js',
});

await build({
  ...common,
  entryPoints: ['packages/extension/src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
});
