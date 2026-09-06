import { app } from "electron";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import https from "node:https";
import path from "node:path";
import type { AppUpdateStatus } from "../src/shared/types";
import {
  compareVersions,
  parseManifest,
  type ReleaseManifest,
} from "../src/shared/update";

const OWNER = "felipealvesr";
const REPOSITORY = "cca-documentos";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_INSTALLER_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function requestBuffer(url: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const visit = (current: string, redirects: number) => {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        reject(new Error("URL de atualização inválida."));
        return;
      }
      if (parsed.protocol !== "https:") {
        reject(new Error("A atualização precisa usar HTTPS."));
        return;
      }
      const request = https.get(
        parsed,
        { headers: { "User-Agent": `CCA-Documentos/${app.getVersion()}` } },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            if (redirects >= MAX_REDIRECTS) {
              reject(new Error("Muitos redirecionamentos na atualização."));
              return;
            }
            visit(new URL(response.headers.location, parsed).href, redirects + 1);
            return;
          }
          if (status < 200 || status >= 300) {
            response.resume();
            reject(new Error(`Servidor de atualização retornou HTTP ${status}.`));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              response.destroy(new Error("Arquivo de atualização muito grande."));
              return;
            }
            chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => resolve(Buffer.concat(chunks)));
        },
      );
      request.once("error", reject);
    };
    visit(url, 0);
  });
}

function downloadFile(
  url: string,
  target: string,
  onProgress: (value: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const visit = (current: string, redirects: number) => {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        reject(new Error("URL de atualização inválida."));
        return;
      }
      if (parsed.protocol !== "https:") {
        reject(new Error("A atualização precisa usar HTTPS."));
        return;
      }
      const request = https.get(
        parsed,
        { headers: { "User-Agent": `CCA-Documentos/${app.getVersion()}` } },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            if (redirects >= MAX_REDIRECTS) {
              reject(new Error("Muitos redirecionamentos na atualização."));
              return;
            }
            visit(new URL(response.headers.location, parsed).href, redirects + 1);
            return;
          }
          if (status < 200 || status >= 300) {
            response.resume();
            reject(new Error(`Servidor de atualização retornou HTTP ${status}.`));
            return;
          }
          const expected = Number(response.headers["content-length"] ?? 0);
          let total = 0;
          const output = createWriteStream(target, { flags: "w" });
          response.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_INSTALLER_BYTES) {
              response.destroy(new Error("Arquivo de atualização muito grande."));
              output.destroy(new Error("Arquivo de atualização muito grande."));
              return;
            }
            if (expected > 0) onProgress(Math.min(100, Math.round((total / expected) * 100)));
          });
          response.once("error", (error) => {
            output.destroy();
            reject(error);
          });
          output.once("error", reject);
          output.once("finish", () => {
            if (expected > 0 && total !== expected) {
              reject(new Error("Download da atualização incompleto."));
              return;
            }
            onProgress(100);
            resolve();
          });
          response.pipe(output);
        },
      );
      request.once("error", reject);
    };
    visit(url, 0);
  });
}

export class UpdateManager {
  private status: AppUpdateStatus = { phase: "idle", message: "" };
  private manifest?: ReleaseManifest;
  private downloadedPath?: string;
  private operation?: Promise<AppUpdateStatus>;

  constructor(private readonly notify: (status: AppUpdateStatus) => void) {}

  private emit(status: AppUpdateStatus) {
    this.status = status;
    this.notify(status);
    return status;
  }

  async check(): Promise<AppUpdateStatus> {
    if (!app.isPackaged) return this.emit({ phase: "idle", message: "" });
    if (this.operation) return this.operation;
    this.operation = this.performCheck().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  private async performCheck() {
    this.emit({ phase: "checking", message: "Verificando atualizações…" });
    try {
      const manifest = parseManifest(
        (await requestBuffer(
          `https://github.com/${OWNER}/${REPOSITORY}/releases/latest/download/latest.yml`,
          MAX_MANIFEST_BYTES,
        )).toString("utf8"),
      );
      if (compareVersions(manifest.version, app.getVersion()) <= 0) {
        this.manifest = undefined;
        return this.emit({ phase: "idle", message: "Você está usando a versão mais recente." });
      }
      this.manifest = manifest;
      return this.emit({
        phase: "available",
        version: manifest.version,
        message: `A versão ${manifest.version} está disponível.`,
      });
    } catch (error) {
      return this.emit({
        phase: "error",
        message: (error as Error).message || "Não foi possível verificar atualizações.",
      });
    }
  }

  async download(): Promise<AppUpdateStatus> {
    if (!app.isPackaged) return this.emit({ phase: "idle", message: "" });
    if (this.status.phase === "ready" && this.downloadedPath)
      return this.status;
    if (!this.manifest) {
      const result = await this.check();
      if (result.phase !== "available" || !this.manifest) return result;
    }
    const manifest = this.manifest;
    const directory = path.join(app.getPath("userData"), "updates");
    const finalPath = path.join(directory, path.basename(manifest.path));
    const partialPath = `${finalPath}.part`;
    try {
      await mkdir(directory, { recursive: true });
      await rm(partialPath, { force: true });
      this.emit({
        phase: "downloading",
        version: manifest.version,
        progress: 0,
        message: "Baixando a nova versão…",
      });
      const assetPath = manifest.path.split(/[\\/]/).map(encodeURIComponent).join("/");
      await downloadFile(
        `https://github.com/${OWNER}/${REPOSITORY}/releases/latest/download/${assetPath}`,
        partialPath,
        (progress) =>
          this.emit({
            phase: "downloading",
            version: manifest.version,
            progress,
            message: `Baixando a nova versão… ${progress}%`,
          }),
      );
      const downloaded = await stat(partialPath);
      if (manifest.size !== undefined && downloaded.size !== manifest.size)
        throw new Error("O tamanho da atualização não confere.");
      if (manifest.sha512) {
        const digest = createHash("sha512").update(await readFile(partialPath)).digest("base64");
        if (digest !== manifest.sha512) throw new Error("A assinatura da atualização não confere.");
      }
      await rename(partialPath, finalPath);
      this.downloadedPath = finalPath;
      return this.emit({
        phase: "ready",
        version: manifest.version,
        progress: 100,
        message: "Atualização pronta para instalar.",
      });
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => undefined);
      return this.emit({
        phase: "error",
        version: manifest.version,
        message: (error as Error).message || "Não foi possível baixar a atualização.",
      });
    }
  }

  async install() {
    if (!app.isPackaged || !this.downloadedPath || this.status.phase !== "ready")
      throw new Error("Baixe a atualização antes de instalar.");
    this.emit({
      phase: "installing",
      version: this.manifest?.version,
      message: "Instalando a atualização…",
    });
    const installer = this.downloadedPath;
    const child = spawn(installer, ["/S", `/D=${path.dirname(process.execPath)}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    setTimeout(() => app.quit(), 300);
  }
}
