import { build } from "esbuild";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

export async function bundleLocal(entry, outfile) {
  const root = process.cwd();
  const source = path.resolve(root, entry);
  const resolveLocal = {
    name: "local-ts-resolver",
    setup(api) {
      api.onResolve({ filter: /^\.\.?\// }, async (args) => {
        const base = path.resolve(args.resolveDir, args.path);
        for (const candidate of [
          base,
          `${base}.ts`,
          `${base}.js`,
          `${base}.mjs`,
        ]) {
          try {
            await access(candidate);
            return { path: candidate };
          } catch {}
        }
        return undefined;
      });
      api.onResolve({ filter: /^[^./]/ }, (args) => ({
        path: args.path,
        external: true,
      }));
    },
  };
  await build({
    stdin: {
      contents: await readFile(source, "utf8"),
      sourcefile: path.basename(source),
      loader: "ts",
      resolveDir: path.dirname(source),
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.resolve(root, outfile),
    packages: "external",
    plugins: [resolveLocal],
  });
}
