import { createCanvas, loadImage } from "@napi-rs/canvas";
import sharp from "sharp";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("tests/fixtures", { recursive: true });
const core = {
  fullName: "MARIA DA SILVA",
  cpf: "123.456.789-09",
  birthDate: "02/05/1990",
  fatherName: "JOAO DA SILVA",
  motherName: "ANA MARIA DA SILVA",
  cnh: "01234567890",
};
const labels = {
  fullName: "NOME",
  cpf: "CPF",
  birthDate: "DATA DE NASCIMENTO",
  fatherName: "NOME DO PAI",
  motherName: "NOME DA MAE",
  cnh: "NUMERO DA CNH",
  rg: "REGISTRO GERAL",
};
const cases = [
  ["cnh-nova", "CARTEIRA NACIONAL DE HABILITACAO", core, "columns"],
  ["cnh-antiga", "CARTEIRA NACIONAL DE HABILITACAO", core, "rows"],
  [
    "cin",
    "CARTEIRA DE IDENTIDADE NACIONAL",
    {
      fullName: core.fullName,
      cpf: core.cpf,
      birthDate: core.birthDate,
      fatherName: core.fatherName,
      motherName: core.motherName,
    },
    "columns",
  ],
  [
    "rg",
    "REGISTRO GERAL",
    { ...core, rg: "12.345.678-9", cnh: undefined },
    "rows",
  ],
  ["certidao", "CERTIDAO DE NASCIMENTO", { ...core, cnh: undefined }, "rows"],
  ["desconhecido", "FICHA PESSOAL DE EXEMPLO", core, "rows"],
];
const manifest = [];
let base;
for (const [id, heading, values, layout] of cases) {
  const canvas = createCanvas(1400, 950);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fafaf5";
  ctx.fillRect(0, 0, 1400, 950);
  ctx.fillStyle = "#e5ece4";
  ctx.fillRect(0, 0, 1400, 116);
  ctx.fillStyle = "#405346";
  ctx.font = "bold 31px Arial";
  ctx.fillText(heading, 65, 75);
  ctx.fillStyle = "#a66e41";
  ctx.font = "17px Arial";
  ctx.fillText(
    "AMOSTRA SINTETICA - SEM VALIDADE - DADOS FICTICIOS PARA TESTE",
    65,
    150,
  );
  let i = 0;
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    const col = layout === "columns" ? i % 2 : 0;
    const row = layout === "columns" ? Math.floor(i / 2) : i;
    const x = 66 + col * 660,
      y = 220 + row * (layout === "columns" ? 155 : 103);
    ctx.fillStyle = "#5b7064";
    ctx.font = "20px Arial";
    ctx.fillText(labels[key], x, y);
    ctx.fillStyle = "#1d3025";
    ctx.font = "bold 32px Arial";
    ctx.fillText(value, x, y + 43);
    i++;
  }
  if (id === "certidao") {
    ctx.fillStyle = "#1d3025";
    ctx.font = "25px Arial";
    ctx.fillText("Livro: A-12     Folha: 34     Termo: 12345", 66, 830);
  }
  const bytes = canvas.toBuffer("image/png");
  await writeFile(`tests/fixtures/${id}.png`, bytes);
  manifest.push({
    file: `${id}.png`,
    expected: Object.fromEntries(Object.entries(values).filter(([, v]) => v)),
    synthetic: true,
  });
  if (id === "desconhecido") base = bytes;
}
for (const [id, pipeline] of [
  [
    "scan-medio",
    sharp(base).resize(950).grayscale().blur(0.4).jpeg({ quality: 58 }),
  ],
  [
    "foto-celular",
    sharp(base)
      .rotate(2.5, { background: "#6a7379" })
      .resize(1600)
      .jpeg({ quality: 83 }),
  ],
  ["rotacionado", sharp(base).rotate(-5, { background: "#ffffff" }).png()],
  [
    "iluminacao-ruim",
    sharp(base)
      .modulate({ brightness: 0.52, saturation: 0.5 })
      .blur(0.5)
      .jpeg({ quality: 66 }),
  ],
]) {
  const ext = id === "rotacionado" ? "png" : "jpg";
  await pipeline.toFile(`tests/fixtures/${id}.${ext}`);
  manifest.push({ file: `${id}.${ext}`, expected: core, synthetic: true });
}
const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const font = await pdf.embedFont(StandardFonts.Helvetica);
const lines = [
  "FICHA DE EXEMPLO - SEM VALIDADE",
  ...Object.entries(core).map(([key, value]) => `${labels[key]}: ${value}`),
  "Livro: A-12",
  "CEP: 89230260",
  "UF: Santa Catarina",
];
lines.forEach((line, i) =>
  page.drawText(line, {
    x: 45,
    y: 775 - i * 48,
    font,
    size: 14,
    color: rgb(0.1, 0.2, 0.3),
  }),
);
await writeFile("tests/fixtures/pdf-digital.pdf", await pdf.save());
manifest.push({
  file: "pdf-digital.pdf",
  expected: core,
  method: "text",
  synthetic: true,
});
const mixed = await PDFDocument.create();
const [copied] = await mixed.copyPages(pdf, [0]);
mixed.addPage(copied);
const scan = await mixed.embedPng(base);
mixed
  .addPage([700, 475])
  .drawImage(scan, { x: 0, y: 0, width: 700, height: 475 });
await writeFile("tests/fixtures/pdf-misto.pdf", await mixed.save());
manifest.push({
  file: "pdf-misto.pdf",
  expected: core,
  method: "mixed",
  synthetic: true,
});
await writeFile(
  "tests/fixtures/manifest.json",
  JSON.stringify(manifest, null, 2),
);
console.log(
  `${manifest.length} arquivos sintéticos criados. Não representam documentos oficiais.`,
);
