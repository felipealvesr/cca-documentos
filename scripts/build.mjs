import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const { build } = await import("vite");
const { default: react } = await import("@vitejs/plugin-react");
const { default: tailwindcss } = await import("@tailwindcss/vite");
await build({
  configFile: false,
  root: process.cwd(),
  base: "./",
  plugins: [react(), tailwindcss()],
});
await import("./build-electron.mjs");
