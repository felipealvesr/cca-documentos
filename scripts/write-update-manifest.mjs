import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDir = path.resolve("release");
const installer = path.join(outputDir, "CCA-Setup.exe");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const metadata = await stat(installer);

const sha512 = await new Promise((resolve, reject) => {
  const hash = createHash("sha512");
  const stream = createReadStream(installer);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.once("error", reject);
  stream.once("end", () => resolve(hash.digest("base64")));
});

const manifest = [
  `version: ${packageJson.version}`,
  "files:",
  "  - url: CCA-Setup.exe",
  `    sha512: ${sha512}`,
  `    size: ${metadata.size}`,
  "path: CCA-Setup.exe",
  `sha512: ${sha512}`,
  `releaseDate: ${new Date().toISOString()}`,
  "",
].join("\n");

await writeFile(path.join(outputDir, "latest.yml"), manifest, "utf8");
console.log(`Generated ${path.join(outputDir, "latest.yml")}`);
