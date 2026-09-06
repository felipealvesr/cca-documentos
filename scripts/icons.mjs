import sharp from "sharp";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
await mkdir("assets", { recursive: true });
await mkdir("public", { recursive: true });
const svg = await readFile("assets/icon.svg");
await sharp(svg).resize(512, 512).png().toFile("assets/icon.png");
await copyFile("assets/icon.png", "public/icon.png");
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(
  sizes.map((s) => sharp(svg).resize(s, s).png().toBuffer()),
);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((buf, i) => {
  const p = 6 + 16 * i;
  header[p] = sizes[i] % 256;
  header[p + 1] = sizes[i] % 256;
  header.writeUInt16LE(1, p + 4);
  header.writeUInt16LE(32, p + 6);
  header.writeUInt32LE(buf.length, p + 8);
  header.writeUInt32LE(offset, p + 12);
  offset += buf.length;
});
await writeFile("assets/icon.ico", Buffer.concat([header, ...images]));
console.log("Ícone PNG e ICO (7 resoluções) gerados.");
