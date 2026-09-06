import {
  createCanvas,
  loadImage,
  DOMMatrix,
  ImageData,
  Path2D,
} from "@napi-rs/canvas";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  DocumentInput,
  OcrElement,
  OcrPage,
  OcrResult,
  Progress,
} from "../src/shared/types";
import { PaddleWorker } from "./paddle-worker";
import { assessPage } from "../src/shared/quality";

export interface OcrProvider {
  analyze(
    document: DocumentInput,
    signal: AbortSignal,
    onProgress: (progress: Progress) => void,
  ): Promise<OcrResult>;
}
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_PAGES = 15;
export function inputKind(input: DocumentInput): "pdf" | "image" {
  if (
    !input ||
    typeof input.id !== "string" ||
    input.id.length > 100 ||
    typeof input.name !== "string" ||
    input.name.length > 260 ||
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.length === 0 ||
    input.bytes.length > MAX_BYTES
  )
    throw new Error("Selecione um arquivo de até 25 MB.");
  const b = input.bytes,
    ext = path.extname(input.name).toLowerCase();
  if (
    ext === ".pdf" &&
    Buffer.from(b.subarray(0, 1024)).includes(Buffer.from("%PDF-"))
  )
    return "pdf";
  if (
    [".jpg", ".jpeg"].includes(ext) &&
    b[0] === 255 &&
    b[1] === 216 &&
    b[2] === 255
  )
    return "image";
  if (
    ext === ".png" &&
    Buffer.from(b.subarray(0, 8)).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
  )
    return "image";
  throw new Error(
    "Formato não reconhecido. Use um PDF, JPG, JPEG ou PNG válido.",
  );
}
function check(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Leitura cancelada.");
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Leitura cancelada."));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function groupRows(elements: OcrElement[]): OcrElement[] {
  const rows: OcrElement[] = [];
  for (const element of elements.sort(
    (a, b) => a.box.y - b.box.y || a.box.x - b.box.x,
  )) {
    const previous = rows.findLast(
      (r) =>
        Math.abs(r.box.y - element.box.y) <
          Math.max(r.box.height, element.box.height) * 0.4 &&
        element.box.x >= r.box.x + r.box.width - 2 &&
        element.box.x - r.box.x - r.box.width <
          Math.max(24, element.box.height * 2),
    );
    if (previous) {
      previous.text += ` ${element.text}`;
      previous.box.width = element.box.x + element.box.width - previous.box.x;
      previous.box.height = Math.max(previous.box.height, element.box.height);
    } else rows.push({ ...element, box: { ...element.box } });
  }
  return rows;
}
export class LocalOcrProvider implements OcrProvider {
  private worker: PaddleWorker;
  constructor(workerRoot: string) {
    this.worker = new PaddleWorker(workerRoot);
  }
  dispose() {
    this.worker.stop();
  }
  async analyze(
    input: DocumentInput,
    signal: AbortSignal,
    notify: (progress: Progress) => void,
  ): Promise<OcrResult> {
    const kind = inputKind(input);
    check(signal);
    let pageNumber = 1,
      totalPages = 1;
    const progress = (phase: string, ratio: number) =>
      notify({
        documentId: input.id,
        phase,
        progress: Math.min(0.99, (pageNumber - 1 + ratio) / totalPages),
      });
    type Alternate = {
      degrees: number;
      image: Buffer;
      width: number;
      height: number;
      preview: string;
    };
    const recognize = async (
      image: Buffer,
      width: number,
      height: number,
      preview: string,
      alternates: Alternate[] = [],
    ): Promise<OcrPage> => {
      check(signal);
      progress(`Lendo página ${pageNumber} de ${totalPages}`, 0.15);
      const first = await this.worker.recognize(
        image,
        "small",
        pageNumber,
        signal,
      );
      let page: OcrPage = {
        number: pageNumber,
        width,
        height,
        preview,
        method: "ocr",
        model: "small",
        elements: first.elements,
      };
      let quality = assessPage(page);
      let selectedImage = image;
      let selectedWidth = width;
      let selectedHeight = height;
      let selectedPreview = preview;
      let selectedSmallElements = first.elements;
      const usefulBoxes = first.elements.filter(
        (e) => e.text.trim().length >= 2 && e.box.width > 2 && e.box.height > 2,
      );
      const verticalRatio =
        usefulBoxes.length >= 3
          ? usefulBoxes.filter((e) => e.box.height > e.box.width * 1.35)
              .length / usefulBoxes.length
          : 0;
      const metrics = {
        smallMs: first.durationMs,
        mediumMs: 0,
        fallbackUsed: quality.shouldFallback,
        orientationRetried: false,
        orientationDegrees: 0,
        reasons: quality.reasons,
        score: quality.score,
      };
      // A sideways phone photo produces mostly tall OCR boxes. Try both quarter turns
      // once, then continue with the best small result. This remains bounded to two
      // extra local OCR calls and does not affect usable digital PDFs.
      if (verticalRatio >= 0.35 && alternates.length) {
        metrics.orientationRetried = true;
        for (const alternate of alternates.slice(0, 2)) {
          check(signal);
          const candidate = await this.worker.recognize(
            alternate.image,
            "small",
            pageNumber,
            signal,
          );
          metrics.smallMs += candidate.durationMs;
          const candidatePage: OcrPage = {
            number: pageNumber,
            width: alternate.width,
            height: alternate.height,
            preview: alternate.preview,
            method: "ocr",
            model: "small",
            elements: candidate.elements,
          };
          const candidateQuality = assessPage(candidatePage);
          if (
            candidateQuality.score > quality.score ||
            (candidateQuality.score === quality.score &&
              candidate.elements.length > page.elements.length)
          ) {
            page = candidatePage;
            quality = candidateQuality;
            selectedImage = alternate.image;
            selectedWidth = alternate.width;
            selectedHeight = alternate.height;
            selectedPreview = alternate.preview;
            selectedSmallElements = candidate.elements;
            metrics.orientationDegrees = alternate.degrees;
            metrics.score = candidateQuality.score;
            metrics.reasons = candidateQuality.reasons;
          }
        }
      }
      metrics.fallbackUsed = quality.shouldFallback;
      if (quality.shouldFallback) {
        progress(`Refinando a leitura da página ${pageNumber}`, 0.6);
        const second = await this.worker.recognize(
          selectedImage,
          "medium",
          pageNumber,
          signal,
        );
        const refined: OcrPage = {
          ...page,
          width: selectedWidth,
          height: selectedHeight,
          preview: selectedPreview,
          elements: second.elements,
          model: "medium",
          initialElements: selectedSmallElements,
        };
        const refinedQuality = assessPage(refined);
        metrics.mediumMs = second.durationMs;
        if (
          refinedQuality.score > quality.score ||
          (refinedQuality.score === quality.score &&
            refined.elements.length > page.elements.length)
        ) {
          page = refined;
          metrics.score = refinedQuality.score;
        }
      }
      return { ...page, metrics };
    };
    const pages: OcrPage[] = [];
    {
      if (kind === "image") {
        progress("Preparando documento", 0.03);
        const img = await loadImage(Buffer.from(input.bytes));
        check(signal);
        if (!img.width || !img.height || img.width * img.height > 60_000_000)
          throw new Error(
            "Imagem muito grande. Exporte uma cópia com até 60 megapixels.",
          );
        const scale = Math.min(
          3400 / Math.max(img.width, img.height),
          Math.max(1, 1700 / Math.max(img.width, img.height)),
        );
        const canvas = createCanvas(
          Math.round(img.width * scale),
          Math.round(img.height * scale),
        );
        const context = canvas.getContext("2d");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        const preview = canvas.toDataURL("image/jpeg", 0.83);
        const alternates = [90, 270].map((degrees) => {
          const rotated = createCanvas(canvas.height, canvas.width);
          const rotateContext = rotated.getContext("2d");
          rotateContext.fillStyle = "#fff";
          rotateContext.fillRect(0, 0, rotated.width, rotated.height);
          rotateContext.translate(rotated.width / 2, rotated.height / 2);
          rotateContext.rotate((degrees * Math.PI) / 180);
          rotateContext.drawImage(
            canvas,
            -canvas.width / 2,
            -canvas.height / 2,
          );
          return {
            degrees,
            image: rotated.toBuffer("image/png"),
            width: rotated.width,
            height: rotated.height,
            preview: rotated.toDataURL("image/jpeg", 0.83),
          };
        });
        pages.push(
          await recognize(
            canvas.toBuffer("image/png"),
            canvas.width,
            canvas.height,
            preview,
            alternates,
          ),
        );
      } else {
        Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const require = createRequire(__filename);
        const pdfRoot = path.dirname(
          require.resolve("pdfjs-dist/package.json"),
        );
        const pdfResource = (dir: string) =>
          path.join(pdfRoot, dir).replaceAll("\\", "/") + "/";
        const loading = pdfjs.getDocument({
          data: new Uint8Array(input.bytes),
          useSystemFonts: true,
          standardFontDataUrl: pdfResource("standard_fonts"),
          cMapUrl: pdfResource("cmaps"),
          wasmUrl: pdfResource("wasm"),
          cMapPacked: true,
        });
        const abortPdf = () => {
          void loading.destroy();
        };
        signal.addEventListener("abort", abortPdf, { once: true });
        try {
          const pdf = await abortable(loading.promise, signal);
          totalPages = pdf.numPages;
          if (totalPages > MAX_PAGES)
            throw new Error(
              `Este MVP aceita até ${MAX_PAGES} páginas por PDF. Separe o arquivo em partes menores.`,
            );
          for (pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
            check(signal);
            progress(`Preparando página ${pageNumber} de ${totalPages}`, 0.03);
            const page = await pdf.getPage(pageNumber);
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({
              scale: Math.min(2.5, 3400 / Math.max(base.width, base.height)),
            });
            const content = await page.getTextContent();
            const raw: OcrElement[] = content.items.flatMap((item) => {
              if (!("str" in item) || !item.str.trim()) return [];
              const transform = pdfjs.Util.transform(
                viewport.transform,
                item.transform,
              );
              const height = Math.hypot(transform[2], transform[3]);
              return [
                {
                  text: item.str,
                  page: pageNumber,
                  box: {
                    x: transform[4],
                    y: transform[5] - height,
                    width: item.width * viewport.scale,
                    height,
                  },
                },
              ];
            });
            const digitalText = raw.map((e) => e.text).join(" ");
            const usable =
              digitalText.replace(/[^\p{L}\p{N}]/gu, "").length >= 24 &&
              !digitalText.includes("\uFFFD");
            // Rendering here is for the human-review preview, never for OCR of usable digital text.
            const canvas = createCanvas(
              Math.ceil(viewport.width),
              Math.ceil(viewport.height),
            );
            await page.render({
              canvas: canvas as never,
              canvasContext: canvas.getContext("2d") as never,
              viewport,
              background: "white",
            }).promise;
            check(signal);
            const preview = canvas.toDataURL("image/jpeg", 0.83);
            if (usable)
              pages.push({
                number: pageNumber,
                width: canvas.width,
                height: canvas.height,
                method: "text",
                preview,
                elements: groupRows(raw),
              });
            else {
              const alternates = [90, 270].map((degrees) => {
                const rotated = createCanvas(canvas.height, canvas.width);
                const rotateContext = rotated.getContext("2d");
                rotateContext.fillStyle = "#fff";
                rotateContext.fillRect(0, 0, rotated.width, rotated.height);
                rotateContext.translate(rotated.width / 2, rotated.height / 2);
                rotateContext.rotate((degrees * Math.PI) / 180);
                rotateContext.drawImage(
                  canvas,
                  -canvas.width / 2,
                  -canvas.height / 2,
                );
                return {
                  degrees,
                  image: rotated.toBuffer("image/png"),
                  width: rotated.width,
                  height: rotated.height,
                  preview: rotated.toDataURL("image/jpeg", 0.83),
                };
              });
              pages.push(
                await recognize(
                  canvas.toBuffer("image/png"),
                  canvas.width,
                  canvas.height,
                  preview,
                  alternates,
                ),
              );
            }
            page.cleanup();
          }
        } catch (error) {
          if ((error as Error).name === "PasswordException")
            throw new Error(
              "Este PDF está protegido por senha. Importe uma cópia desbloqueada.",
            );
          throw error;
        } finally {
          signal.removeEventListener("abort", abortPdf);
          await loading.destroy();
        }
      }
      check(signal);
      return {
        text: pages
          .map((p) => p.elements.map((e) => e.text).join("\n"))
          .join("\n\n"),
        pages,
      };
    }
  }
}
