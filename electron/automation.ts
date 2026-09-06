import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, copyFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { digits, validate } from "../src/shared/fields";
import type { AutomationInput, AutomationStatus } from "../src/shared/types";

export function validateAutomation(input: AutomationInput) {
  if (!input || input.confirmed !== true)
    throw new Error("Confirme a conferência dos dados antes de iniciar.");
  if (
    typeof input.fullName !== "string" ||
    !input.fullName.trim() ||
    input.fullName.length > 200
  )
    throw new Error("Preencha o nome completo.");
  const values: [string, string][] = [
    ["cpf", input.cpf ?? ""],
    ["cnh", input.numero_cnh ?? ""],
    ["fatherName", input.nome_pai_validacao ?? ""],
  ];
  for (const [key, value] of values) {
    if (typeof value !== "string" || value.length > 200)
      throw new Error("Confira os dados informados.");
    if (!value.trim()) continue;
    const error = validate(key, value);
    if (error) throw new Error(error);
  }
  if (!(input.cpf ?? "").trim() && !(input.numero_cnh ?? "").trim())
    throw new Error("Preencha um CPF ou número da CNH válido.");
}
export function protocolStatus(text: string): AutomationStatus | undefined {
  if (
    /ERRO|N[aã]o consegui|N[aã]o encontrei|n[aã]o apareceu|obrigat[oó]rios/i.test(
      text,
    )
  )
    return {
      phase: "error",
      message:
        "O protótipo não conseguiu continuar. Confira o Chrome e a tela aberta antes de tentar novamente.",
    };
  if (
    /SUCESSO|TELA CADASTRAL DETECTADA|tela cadastral final (?:detectada|identificada|encontrada|atingida)/i.test(
      text,
    )
  )
    return {
      phase: "done",
      message:
        "Tela cadastral alcançada. A automação parou para você continuar no CAIXA Aqui.",
    };
  if (/Aguardando a tela cadastral final/i.test(text))
    return { phase: "final", message: "Aguardando a tela cadastral final." };
  if (/Preenchendo nome do pai|Aguardando Identifica/i.test(text))
    return {
      phase: "identification",
      message: "Conferindo a identificação positiva no CAIXA Aqui.",
    };
  if (/Preenchendo CPF/i.test(text))
    return {
      phase: "cpf",
      message: "Preenchendo CPF e consultando o cliente.",
    };
  if (/Volte para esta janela e pressione ENTER/i.test(text))
    return {
      phase: "waiting",
      message: "Faça login no Chrome e deixe aberta a tela “CPF do Cliente”.",
    };
  return undefined;
}
export class AutomationBridge {
  private child?: ChildProcessWithoutNullStreams;
  private runDir?: string;
  private phase: AutomationStatus["phase"] = "idle";
  private active = false;
  private closed = Promise.resolve();
  private timeout?: NodeJS.Timeout;
  constructor(
    private executable: string,
    private tempRoot: string,
    private notify: (status: AutomationStatus) => void,
  ) {}
  private emit(status: AutomationStatus) {
    this.phase = status.phase;
    this.notify(status);
  }
  async cleanStale() {
    for (const entry of await readdir(this.tempRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^cca-operation-[\w-]+$/.test(entry.name))
        await rm(path.join(this.tempRoot, entry.name), {
          recursive: true,
          force: true,
        }).catch(() => {});
    }
  }
  async start(input: AutomationInput) {
    validateAutomation(input);
    if (this.active) throw new Error("Já existe uma operação em andamento.");
    if (process.platform !== "win32")
      throw new Error("A automação requer Windows e Google Chrome instalado.");
    this.active = true;
    this.emit({
      phase: "opening",
      message: "Abrindo o navegador para o cadastro assistido.",
    });
    try {
      this.runDir = await mkdtemp(path.join(this.tempRoot, "cca-operation-"));
      const exe = path.join(this.runDir, "CCA_v1.exe");
      await copyFile(this.executable, exe);
      await writeFile(
        path.join(this.runDir, "cliente_teste.json"),
        JSON.stringify({
          cpf: digits(input.cpf ?? ""),
          nome_pai_validacao: (input.nome_pai_validacao ?? "").trim(),
          numero_cnh: digits(input.numero_cnh ?? ""),
        }),
        { mode: 0o600 },
      );
      const child = spawn(exe, [], {
        cwd: this.runDir,
        windowsHide: true,
        shell: false,
        stdio: "pipe",
      });
      this.child = child;
      let buffer = "";
      const consume = (chunk: Buffer | string) => {
        buffer = (buffer + chunk.toString()).slice(-16000);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of [...lines, buffer]) {
          const status = protocolStatus(line);
          if (
            status &&
            status.phase !== this.phase &&
            !["done", "error", "cancelled"].includes(this.phase)
          ) {
            this.emit(status);
            if (status.phase === "done" || status.phase === "error")
              child.stdin.write("\r\n");
          }
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.stdin.on("error", () => {});
      child.on("error", () =>
        this.emit({
          phase: "error",
          message:
            "Não foi possível abrir o CCA_v1. Confira se o antivírus bloqueou o executável.",
        }),
      );
      this.closed = new Promise((resolve) =>
        child.on("close", async () => {
          clearTimeout(this.timeout);
          if (!["done", "error", "cancelled"].includes(this.phase))
            this.emit({
              phase: "error",
              message:
                "O protótipo encerrou sem confirmar a tela final. Confira a situação no Chrome.",
            });
          this.child = undefined;
          await this.cleanup();
          this.active = false;
          resolve();
        }),
      );
      this.timeout = setTimeout(
        () => {
          this.emit({
            phase: "error",
            message:
              "Tempo de espera encerrado. Confira o Chrome e tente novamente.",
          });
          child.kill();
        },
        20 * 60 * 1000,
      );
    } catch (error) {
      await this.cleanup();
      this.active = false;
      this.emit({
        phase: "error",
        message: "Não foi possível preparar a automação.",
      });
      throw error;
    }
  }
  continue() {
    if (!this.child || this.phase !== "waiting")
      throw new Error("Aguarde o navegador ficar pronto.");
    this.emit({ phase: "cpf", message: "Consultando CPF no CAIXA Aqui." });
    this.child.stdin.write("\r\n");
  }
  async cancel() {
    if (!this.active) return;
    this.emit({
      phase: "cancelled",
      message:
        "Automação interrompida. Confira no navegador o que já foi preenchido.",
    });
    this.child?.kill();
    if (this.child) await this.closed;
  }
  private async cleanup() {
    if (this.runDir) {
      await rm(this.runDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 250,
      }).catch(() => {});
      this.runDir = undefined;
    }
  }
}
