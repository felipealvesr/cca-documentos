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
// Messages below are the ones CCA_v1.exe actually prints; keep them in sync with
// the executable before changing anything here. Nothing it says reaches the
// employee as it is: the executable is an implementation detail, so every line
// becomes a sentence about what the person in front of the screen should do.
export const CLOSING_PROMPT = /Pressione ENTER para fechar/i;
// The engine reads the three legacy keys and ignores what it does not know —
// confirmed against CCA_v1.exe, including nested objects. So the file carries the
// whole reviewed record: the next engine fills more of the screen without another
// round trip, and this one behaves exactly as before.
export function enginePayload(input: AutomationInput) {
  return {
    cpf: digits(input.cpf ?? ""),
    nome_pai_validacao: (input.nome_pai_validacao ?? "").trim(),
    numero_cnh: digits(input.numero_cnh ?? ""),
    nome_completo: input.fullName.trim(),
    campos: (input.reviewed ?? [])
      .filter((field) => field.value.trim())
      .map((field) => ({
        chave: field.key,
        rotulo: field.label,
        valor: field.value.trim(),
      })),
  };
}
export function protocolStatus(text: string): AutomationStatus | undefined {
  if (/CPF deve conter/i.test(text))
    return {
      phase: "error",
      recovery: "data",
      message:
        "A identificação positiva exige o CPF completo do cliente. Volte à conferência e informe o CPF.",
    };
  if (
    /ERRO ao carregar cliente_teste\.json|obrigat[oó]rios no prot[oó]tipo/i.test(
      text,
    )
  )
    return {
      phase: "error",
      recovery: "data",
      message:
        "A identificação positiva exige o nome do pai e o número da CNH junto com o CPF. Volte à conferência e complete esses campos.",
    };
  if (
    /Google Chrome n[aã]o encontrado|ERRO ao abrir Chrome|ERRO ao conectar ao Chrome|ERRO de comunica[cç][aã]o com o navegador|aba do CAIXA Aqui/i.test(
      text,
    )
  )
    return {
      phase: "error",
      recovery: "browser",
      message:
        "Não foi possível falar com o Google Chrome. Confira se ele está instalado e se a janela do CAIXA Aqui continua aberta.",
    };
  if (
    /ERRO|N[aã]o consegui|N[aã]o encontrei|n[aã]o apareceu|obrigat[oó]rios/i.test(
      text,
    )
  )
    return {
      phase: "error",
      recovery: "browser",
      message:
        "O cadastro assistido não conseguiu continuar. Confira a tela aberta no Chrome e tente de novo.",
    };
  if (
    /AUTOMA[CÇ][AÃ]O ENCERRADA|TELA CADASTRAL DETECTADA|tela cadastral final (?:detectada|identificada|encontrada|atingida)/i.test(
      text,
    )
  )
    return {
      phase: "done",
      message:
        "Chegamos à tela cadastral. O Chrome está pronto para você concluir o cadastro.",
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
  private input?: AutomationInput;
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
    this.input = input;
    await this.launch();
  }
  // A hiccup in the browser used to cost the whole operation: the executable
  // dies on the first error and the employee had to confirm everything again.
  // The run belongs to the interface, not to the process, so the same confirmed
  // data simply starts another one.
  async retry() {
    if (!this.input)
      throw new Error("Inicie o cadastro assistido antes de tentar de novo.");
    if (!["error", "cancelled"].includes(this.phase))
      throw new Error("Aguarde o fim da operação em andamento.");
    await this.closed;
    if (this.active) throw new Error("Já existe uma operação em andamento.");
    await this.launch();
  }
  private async launch() {
    const input = this.input!;
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
        JSON.stringify(enginePayload(input)),
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
      let finished = false;
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
          )
            this.emit(status);
          // "Pressione ENTER para fechar..." exists only because the reference
          // prototype runs in a console window someone has to dismiss. There is
          // no console here, so the run is ended instead of being fed a keystroke
          // nobody typed. Ending it also skips the executable's own shutdown,
          // which is what keeps the Chrome window standing for the employee to
          // finish the registration.
          if (
            !finished &&
            (CLOSING_PROMPT.test(line) ||
              this.phase === "done" ||
              this.phase === "error")
          ) {
            finished = true;
            child.kill();
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
          recovery: "browser",
          message:
            "Não foi possível iniciar o cadastro assistido. Confira se o antivírus bloqueou o aplicativo.",
        }),
      );
      this.closed = new Promise((resolve) =>
        child.on("close", async () => {
          clearTimeout(this.timeout);
          if (!["done", "error", "cancelled"].includes(this.phase))
            this.emit({
              phase: "error",
              recovery: "browser",
              message:
                "O cadastro assistido terminou sem confirmar a tela final. Confira a situação no Chrome.",
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
            recovery: "browser",
            message:
              "Tempo de espera encerrado. Confira o Chrome e tente de novo.",
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
        recovery: "browser",
        message: "Não foi possível preparar o cadastro assistido.",
      });
      throw error;
    }
  }
  // The one keystroke worth keeping: it carries a decision only the employee can
  // make — that the CAIXA Aqui screen is really open and logged in.
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
