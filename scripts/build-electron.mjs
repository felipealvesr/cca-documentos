import { build } from 'esbuild';
import { copyFile, access, readFile } from 'node:fs/promises';
import path from 'node:path';

// Resolve project-local TypeScript imports explicitly. This keeps the build
// deterministic with pnpm junctions on Windows and leaves Electron/node
// packages external, as required by the desktop runtime.
const root = process.cwd();
const electronRoot = path.join(root, 'electron');
const localResolver = {
  name: 'local-ts-resolver',
  setup(api) {
    api.onResolve({ filter: /^\.\.?\// }, async args => {
      const base = path.resolve(args.resolveDir, args.path);
      for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}.mjs`]) {
        try { await access(candidate); return { path: candidate }; } catch {}
      }
      return undefined;
    });
    api.onResolve({ filter: /^[^./]/ }, args => ({ path: args.path, external: true }));
  }
};
for (const entry of ['main', 'preload']) {
  const contents = await readFile(path.join(electronRoot, `${entry}.ts`), 'utf8');
  await build({
    stdin: { contents, sourcefile: `${entry}.ts`, loader: 'ts', resolveDir: electronRoot },
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(root, 'dist-electron', `${entry}.cjs`),
    packages: 'external', sourcemap: true, plugins: [localResolver]
  });
}
await access('resources/ocr/cca-ocr.exe');
await copyFile('ocr-worker/worker.py', 'resources/ocr/worker.py');
