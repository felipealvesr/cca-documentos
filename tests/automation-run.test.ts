import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AutomationBridge, enginePayload } from "../electron/automation";
import type { AutomationStatus } from "../src/shared/types";

const EXECUTABLE = path.resolve("prototype/CCA_v1.exe");
const runnable = process.platform === "win32" && existsSync(EXECUTABLE);
const settle = async (
  check: () => boolean | Promise<boolean>,
  ms = 20000,
) => {
  const limit = Date.now() + ms;
  let ok = await check();
  while (!ok && Date.now() < limit) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    ok = await check();
  }
  expect(ok).toBe(true);
};
const INPUT = {
  fullName: "MARIA DA SILVA",
  cpf: "123.456.789-09",
  nome_pai_validacao: "",
  numero_cnh: "",
  confirmed: true,
};

describe("payload handed to the engine", () => {
  it("keeps the three keys it reads and carries the rest of the review", () => {
    const payload = enginePayload({
      ...INPUT,
      nome_pai_validacao: "JOÃO DA SILVA",
      numero_cnh: "012.345.678-90",
      reviewed: [
        { key: "motherName", label: "Nome da mãe", value: "ANA DA SILVA" },
        { key: "address.city", label: "Cidade", value: "SALVADOR" },
        { key: "additional:Naturalidade", label: "Naturalidade", value: "  " },
      ],
    });
    expect(payload.cpf).toBe("12345678909");
    expect(payload.numero_cnh).toBe("01234567890");
    expect(payload.nome_pai_validacao).toBe("JOÃO DA SILVA");
    expect(payload.nome_completo).toBe("MARIA DA SILVA");
    // Optional fields are not dropped on the way to the CAIXA Aqui screen, but
    // an empty one carries nothing useful.
    expect(payload.campos).toEqual([
      { chave: "motherName", rotulo: "Nome da mãe", valor: "ANA DA SILVA" },
      { chave: "address.city", rotulo: "Cidade", valor: "SALVADOR" },
    ]);
  });
});

describe.skipIf(!runnable)("bridge driving the real executable", () => {
  it("ends the run on its own and starts over with the same data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cca-run-"));
    const seen: AutomationStatus[] = [];
    const bridge = new AutomationBridge(EXECUTABLE, root, (s) => seen.push(s));
    // Missing father's name and CNH: the engine refuses at load, which is the
    // cheapest way to exercise a whole run without touching Chrome.
    await bridge.start(INPUT);
    await settle(() => seen.some((s) => s.phase === "error"));
    expect(seen[0].phase).toBe("opening");
    expect(seen.at(-1)?.recovery).toBe("data");
    // Nobody typed anything: the bridge ended the process that was blocked on
    // "Pressione ENTER para fechar...", so the run folder goes away by itself.
    await settle(async () => (await readdir(root)).length === 0);
    const before = seen.length;
    await bridge.retry();
    expect(seen[before].phase).toBe("opening");
    await settle(() => seen.slice(before).some((s) => s.phase === "error"));
    await settle(async () => (await readdir(root)).length === 0);
    await rm(root, { recursive: true, force: true });
  }, 40000);
});
