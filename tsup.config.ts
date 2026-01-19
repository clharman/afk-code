import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist/cli',
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Bundle dependencies that aren't natively available
  noExternal: [],
  // Keep these as external (node builtins + our dependencies)
  external: [
    '@slack/bolt',
    'discord.js',
    'node-pty',
  ],
});
