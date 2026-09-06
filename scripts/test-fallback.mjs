import { createRequire } from "node:module";
import { createCanvas } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { bundleLocal } from "./bundle-local.mjs";
await bundleLocal("tests/bench-entry.ts", ".cache/fallback.cjs");
const require = createRequire(import.meta.url);
const { LocalOcrProvider, extractDocument } = require("../.cache/fallback.cjs");
const canvas = createCanvas(1200, 450),
  ctx = canvas.getContext("2d");
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, 1200, 450);
ctx.fillStyle = "#142a38";
ctx.font = "30px Arial";
[
  "TESTE SINTETICO",
  "NOME: MARIA DA SILVA",
  "CPF: 123.456.789-00",
  "DATA DE NASCIMENTO: 02/05/1990",
].forEach((line, i) => ctx.fillText(line, 60, 70 + i * 80));
await writeFile(
  "tests/fixtures/cpf-invalido.png",
  canvas.toBuffer("image/png"),
);
const provider = new LocalOcrProvider(path.resolve("resources/ocr"));
try {
  const ocr = await provider.analyze(
    {
      id: "fallback",
      name: "cpf-invalido.png",
      bytes: new Uint8Array(await readFile("tests/fixtures/cpf-invalido.png")),
    },
    new AbortController().signal,
    () => {},
  );
  assert.equal(ocr.pages[0].metrics.fallbackUsed, true);
  assert.ok(ocr.pages[0].metrics.mediumMs > 0);
  const doc = extractDocument("fallback", "cpf-invalido.png", ocr);
  assert.equal(doc.data.cpf, "123.456.789-00");
  await writeFile(
    "test-results/fallback.json",
    JSON.stringify(
      {
        success: true,
        reason: "invalid_fields",
        invalidValuePreserved: true,
        originalDocumentActuallyInvalid: true,
        ...ocr.pages[0].metrics,
      },
      null,
      2,
    ),
  );
  console.log(
    "Medium executado sob demanda; CPF inválido preservado para revisão, sem novo ciclo de OCR.",
  );
} finally {
  provider.dispose();
}
