import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleLocal } from "./bundle-local.mjs";
await bundleLocal("tests/bench-entry.ts", ".cache/bench.cjs");
const require = createRequire(import.meta.url);
const { LocalOcrProvider, extractDocument } = require("../.cache/bench.cjs");
const provider = new LocalOcrProvider(path.resolve("resources/ocr"));
const manifest = JSON.parse(
  await readFile("tests/fixtures/manifest.json", "utf8"),
);
const results = [];
try {
  for (const fixture of manifest) {
    const started = performance.now();
    const input = {
      id: fixture.file,
      name: fixture.file,
      bytes: new Uint8Array(await readFile(`tests/fixtures/${fixture.file}`)),
    };
    const ocr = await provider.analyze(
      input,
      new AbortController().signal,
      () => {},
    );
    const extractionStarted = performance.now();
    const doc = extractDocument(input.id, input.name, ocr);
    const fields = Object.entries(fixture.expected).map(([key, expected]) => ({
      key,
      expected,
      extracted: doc.data[key] ?? null,
      match: doc.data[key] === expected,
    }));
    const result = {
      file: fixture.file,
      synthetic: true,
      durationMs: Math.round(performance.now() - started),
      extractionMs: +(performance.now() - extractionStarted).toFixed(2),
      fields,
      pages: ocr.pages.map((p) => ({
        method: p.method,
        model: p.model,
        ...p.metrics,
      })),
    };
    results.push(result);
    console.log(
      `${fixture.file}: ${fields.filter((f) => f.match).length}/${fields.length} campos, ${result.durationMs} ms, ${result.pages.map((p) => (p.method === "text" ? "texto direto" : p.model + (p.fallbackUsed ? "+fallback" : ""))).join(", ")}`,
    );
    for (const f of fields.filter((f) => !f.match))
      console.log(`  ${f.key}: esperado ${f.expected}; obtido ${f.extracted}`);
  }
} finally {
  provider.dispose();
}
await mkdir("test-results", { recursive: true });
const fields = results.flatMap((r) => r.fields);
const metrics = {
  runtime: "RapidOCR 3.9.2 / ONNX Runtime 1.24.3 / CPU 4 threads",
  syntheticOnly: true,
  matched: fields.filter((f) => f.match).length,
  total: fields.length,
  fallbackPages: results.flatMap((r) => r.pages).filter((p) => p.fallbackUsed)
    .length,
  manualCorrectionCount: null,
  results,
};
await writeFile(
  "test-results/benchmark.json",
  JSON.stringify(metrics, null, 2),
);
console.log(
  `TOTAL: ${metrics.matched}/${metrics.total}; fallback em ${metrics.fallbackPages} páginas.`,
);
if (fields.some((f) => !f.match)) process.exitCode = 1;
