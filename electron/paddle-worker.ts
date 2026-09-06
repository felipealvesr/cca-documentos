import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OcrElement } from "../src/shared/types";
interface WorkerResult {
  elements: OcrElement[];
  durationMs: number;
}
export class PaddleWorker {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: {
    id: string;
    resolve: (value: WorkerResult) => void;
    reject: (error: Error) => void;
  };
  private buffer = "";
  constructor(private root: string) {}
  private ensure() {
    if (this.child) return;
    const child = spawn(
      path.join(this.root, "cca-ocr.exe"),
      ["-I", "-B", "-u", path.join(this.root, "worker.py")],
      {
        cwd: this.root,
        windowsHide: true,
        shell: false,
        stdio: "pipe",
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          OMP_NUM_THREADS: "4",
        },
      },
    );
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > 8_000_000) {
        this.stop();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const result = JSON.parse(line);
          if (result.id !== this.pending?.id) continue;
          const pending = this.pending;
          this.pending = undefined;
          if (result.success && Array.isArray(result.blocks))
            pending?.resolve({
              elements: result.blocks,
              durationMs: result.durationMs,
            });
          else
            pending?.reject(
              new Error(
                "O motor de leitura não conseguiu processar a imagem. Tente uma cópia mais nítida.",
              ),
            );
        } catch {
          /* Ignore nonprotocol diagnostics without logging personal content. */
        }
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    const failed = () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.pending?.reject(
        new Error(
          "Não foi possível iniciar o OCR local. Reinstale o CCA para restaurar modelos e bibliotecas.",
        ),
      );
      this.pending = undefined;
    };
    child.on("error", failed);
    child.on("close", failed);
  }
  async recognize(
    image: Buffer,
    model: "small" | "medium",
    page: number,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    if (signal.aborted) throw new Error("Leitura cancelada.");
    if (this.pending) throw new Error("Aguarde a leitura atual.");
    this.ensure();
    const abort = () => this.stop();
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => this.stop(), 180_000);
    try {
      return await new Promise((resolve, reject) => {
        const id = randomUUID();
        this.pending = { id, resolve, reject };
        this.child!.stdin.write(
          JSON.stringify({ id, model, page, image: image.toString("base64") }) +
            "\n",
        );
      });
    } finally {
      signal.removeEventListener("abort", abort);
      clearTimeout(timeout);
    }
  }
  stop() {
    const child = this.child;
    this.child = undefined;
    this.pending?.reject(
      new Error("Leitura interrompida. Tente novamente se necessário."),
    );
    this.pending = undefined;
    this.buffer = "";
    child?.kill();
  }
}
