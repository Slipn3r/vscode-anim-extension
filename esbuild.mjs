import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

async function run(name, options) {
  const context = await esbuild.context({ ...options, logLevel: 'info' });
  if (watch) {
    await context.watch();
    console.log(`[watch] ${name}`);
  } else {
    await context.rebuild();
    await context.dispose();
  }
}

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  legalComments: 'none',
};

/** @type {[string, esbuild.BuildOptions][]} */
const targets = [
  [
    'extension host',
    {
      ...common,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['vscode'],
    },
  ],
  [
    'webview',
    {
      ...common,
      entryPoints: ['src/webview/preview.ts'],
      outfile: 'media/preview.js',
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
    },
  ],
  [
    'decoder (for tests and tools)',
    {
      ...common,
      entryPoints: ['src/animFile.ts'],
      outfile: 'dist/animFile.mjs',
      platform: 'neutral',
      format: 'esm',
      target: 'es2022',
    },
  ],
  [
    'webview template (for the browser harness)',
    {
      ...common,
      entryPoints: ['src/webview/template.ts'],
      outfile: 'dist/template.mjs',
      platform: 'neutral',
      format: 'esm',
      target: 'es2022',
    },
  ],
];

for (const [name, options] of targets) {
  await run(name, options);
}

if (watch) {
  console.log('Watching for changes…');
}
