import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import path from "node:path";
import { readFile, stat, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { LocalOcrProvider, MAX_BYTES, inputKind } from "./ocr";
import { extractDocument } from "../src/shared/extract";
import { AutomationBridge } from "./automation";
import type { DocumentInput } from "../src/shared/types";

app.setName("CCA Documentos");
app.setAppUserModelId("br.com.cca.documentos");
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
let window: BrowserWindow | undefined;
let controller: AbortController | undefined;
let closing = false;
const packagedRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
const developmentUrl = !app.isPackaged ? process.env.CCA_DEV_URL : undefined;
const appUrl =
  developmentUrl ??
  pathToFileURL(path.join(app.getAppPath(), "dist/index.html")).href;
app.on("second-instance", () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});
app.whenReady().then(async () => {
  if (!single) return;
  Menu.setApplicationMenu(null);
  // Documents are retained only in memory; this nonpersistent session has no browser history.
  const tempRoot = path.join(app.getPath("userData"), "operations");
  await mkdir(tempRoot, { recursive: true });
  const automation = new AutomationBridge(
    path.join(
      packagedRoot,
      app.isPackaged ? "automation" : "prototype",
      "CCA_v1.exe",
    ),
    tempRoot,
    (status) => {
      if (!window?.isDestroyed())
        window?.webContents.send("automation:status", status);
    },
  );
  await automation.cleanStale();
  const ocr = new LocalOcrProvider(
    path.join(packagedRoot, app.isPackaged ? "ocr" : "resources/ocr"),
  );
  window = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 1024,
    minHeight: 720,
    title: "CCA · Documentos",
    backgroundColor: "#F4F7FA",
    icon: path.join(
      packagedRoot,
      app.isPackaged ? "icon.ico" : "assets/icon.ico",
    ),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "cca-session",
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== appUrl) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const allowed =
      url.protocol === "file:" ||
      url.protocol === "data:" ||
      url.protocol === "blob:" ||
      (developmentUrl &&
        ["http:", "ws:"].includes(url.protocol) &&
        url.host === "127.0.0.1:5173");
    callback({ cancel: !allowed });
  });
  const handle = (channel: string, action: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Origem inválida.");
      return action(...args);
    });
  const readDocument = async (file: string): Promise<DocumentInput> => {
    if (
      typeof file !== "string" ||
      ![".pdf", ".jpg", ".jpeg", ".png"].includes(
        path.extname(file).toLowerCase(),
      )
    )
      throw new Error("Selecione um PDF, JPG, JPEG ou PNG.");
    const stats = await stat(file);
    if (!stats.isFile() || stats.size > MAX_BYTES)
      throw new Error("O arquivo deve ter até 25 MB.");
    const input = {
      id: randomUUID(),
      name: path.basename(file),
      bytes: new Uint8Array(await readFile(file)),
    };
    inputKind(input);
    return input;
  };
  handle("documents:pick", async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: "Adicionar documentos pessoais",
      filters: [
        { name: "Documentos", extensions: ["pdf", "jpg", "jpeg", "png"] },
      ],
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return [];
    if (result.filePaths.length > 10)
      throw new Error("Adicione até 10 documentos por operação.");
    return Promise.all(result.filePaths.map(readDocument));
  });
  handle("documents:read", readDocument);
  handle("documents:analyze", async (input: DocumentInput) => {
    if (controller) throw new Error("Aguarde a leitura atual terminar.");
    controller = new AbortController();
    try {
      return extractDocument(
        input.id,
        input.name,
        await ocr.analyze(input, controller.signal, (progress) => {
          if (!window?.isDestroyed())
            window?.webContents.send("documents:progress", progress);
        }),
      );
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Leitura cancelada.");
      throw new Error(
        (error as Error).message ||
          "Não foi possível ler o arquivo. Tente uma imagem mais nítida.",
      );
    } finally {
      controller = undefined;
    }
  });
  handle("documents:cancel", () => controller?.abort());
  handle("automation:start", (input) => automation.start(input));
  handle("automation:continue", () => automation.continue());
  handle("automation:cancel", () => automation.cancel());
  window.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    controller?.abort();
    ocr.dispose();
    void automation.cancel().finally(() => {
      window?.destroy();
      app.quit();
    });
  });
  await window.loadURL(appUrl);
  window.show();
});
app.on("window-all-closed", () => app.quit());
