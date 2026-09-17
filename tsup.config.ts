import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { 'cli': 'src/cli/index.ts' },
    format: ['esm'],
    target: 'node24',
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    dts: false,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: { 'api': 'src/api.ts' },
    format: ['esm'],
    target: 'node24',
    outDir: 'dist',
    clean: false,
    sourcemap: true,
    dts: true,
  },
  {
    entry: { 'action': 'src/action/main.ts' },
    noExternal: ['yaml', 'minimatch'],
    format: ['cjs'],
    target: 'node24',
    outDir: 'dist',
    clean: false,
    sourcemap: false,
  },
  {
    entry: { 'gate': 'src/action/gate-main.ts' },
    noExternal: ['yaml', 'minimatch'],
    format: ['cjs'],
    target: 'node24',
    outDir: 'gate-action/dist',
    clean: false,
    sourcemap: false,
  },
]);
