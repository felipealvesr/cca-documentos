import { describe, it, expect } from "vitest";
import {
  CLOSING_PROMPT,
  protocolStatus,
  validateAutomation,
} from "../electron/automation";
// Lines below were captured from CCA_v1.exe itself, not paraphrased.
const BANNER = [
  "==============================================",
  " CCA v1 - Protótipo de navegação assistida",
  "==============================================",
  "Escopo: CPF -> Identificação Positiva -> tela cadastral -> PARAR",
  "Este protótipo NÃO salva, NÃO avança e NÃO conclui a tela cadastral final.",
];
describe("existing executable contract", () => {
  it("requires explicit human confirmation and validated priority values", () => {
    const input = {
      fullName: "MARIA DA SILVA",
      cpf: "123.456.789-09",
      nome_pai_validacao: "JOÃO DA SILVA",
      numero_cnh: "01234567890",
      confirmed: true,
    };
    expect(() => validateAutomation(input)).not.toThrow();
    expect(() =>
      validateAutomation({ ...input, nome_pai_validacao: "", numero_cnh: "" }),
    ).not.toThrow();
    expect(() =>
      validateAutomation({
        ...input,
        cpf: "",
        nome_pai_validacao: "",
        numero_cnh: "01234567890",
      }),
    ).not.toThrow();
    expect(() => validateAutomation({ ...input, confirmed: false })).toThrow();
    expect(() =>
      validateAutomation({ ...input, cpf: "123.456.789-00" }),
    ).toThrow();
    expect(() => validateAutomation({ ...input, fullName: "" })).toThrow();
  });
  it("stays quiet while the executable prints its opening banner", () => {
    for (const line of BANNER) expect(protocolStatus(line)).toBeUndefined();
  });
  it("follows the happy path up to the closing banner", () => {
    expect(
      protocolStatus("3) Volte para esta janela e pressione ENTER.")?.phase,
    ).toBe("waiting");
    expect(protocolStatus("Preenchendo CPF...")?.phase).toBe("cpf");
    expect(protocolStatus("Aguardando Identificação Positiva...")?.phase).toBe(
      "identification",
    );
    expect(
      protocolStatus("Preenchendo nome do pai e número da CNH...")?.phase,
    ).toBe("identification");
    expect(protocolStatus("Aguardando a tela cadastral final...")?.phase).toBe(
      "final",
    );
    expect(protocolStatus(" AUTOMACAO ENCERRADA CONFORME O ESCOPO ")?.phase).toBe(
      "done",
    );
  });
  it("reports why a run failed instead of always blaming the browser", () => {
    expect(
      protocolStatus(
        "ERRO ao carregar cliente_teste.json: nome do pai e número da CNH são obrigatórios no protótipo",
      )?.recovery,
    ).toBe("data");
    expect(
      protocolStatus(
        "ERRO ao carregar cliente_teste.json: nome do pai e número da CNH são obrigatórios no protótipo",
      )?.message,
    ).toMatch(/nome do pai/i);
    expect(
      protocolStatus(
        "ERRO ao carregar cliente_teste.json: CPF deve conter 11 dígitos",
      )?.recovery,
    ).toBe("data");
    expect(
      protocolStatus(
        "ERRO ao carregar cliente_teste.json: CPF deve conter 11 dígitos",
      )?.message,
    ).toMatch(/CPF/);
    expect(
      protocolStatus(
        "Google Chrome não encontrado. Instale o Chrome ou ajuste o caminho no código-fonte.",
      )?.message,
    ).toMatch(/Google Chrome/);
    expect(protocolStatus("ERRO ao conectar ao Chrome: dial tcp")?.message).toMatch(
      /Google Chrome/,
    );
    // Anything that broke in the browser can be started over with the same
    // confirmed data, so the interface is allowed to offer "tentar de novo".
    for (const line of [
      "Google Chrome não encontrado. Instale o Chrome ou ajuste o caminho no código-fonte.",
      "ERRO ao conectar ao Chrome: dial tcp",
      "Não consegui acionar Consultar na tela do CPF.",
      "A tela de Identificação Positiva não apareceu dentro do tempo esperado.",
      "Não consegui acionar Consultar na Identificação Positiva.",
      "Não consegui confirmar a chegada à tela cadastral final.",
    ]) {
      expect(protocolStatus(line)?.phase).toBe("error");
      expect(protocolStatus(line)?.recovery).toBe("browser");
    }
  });
  it("never repeats the executable's own vocabulary to the employee", () => {
    for (const line of [
      "ERRO ao carregar cliente_teste.json: CPF deve conter 11 dígitos",
      "ERRO ao conectar ao Chrome: dial tcp",
      "Não consegui acionar Consultar na tela do CPF.",
      "3) Volte para esta janela e pressione ENTER.",
      " AUTOMACAO ENCERRADA CONFORME O ESCOPO ",
    ])
      expect(protocolStatus(line)?.message).not.toMatch(
        /prot[oó]tipo|ENTER|CCA_v1|cliente_teste/i,
      );
  });
  // The prompt arrives without a trailing newline, so the bridge has to match it
  // on the partial buffer. Ending the run is what answers it — no keystroke is
  // sent, which keeps the executable's shutdown away from the employee's Chrome.
  it("recognises the prompt that blocks the executable on exit", () => {
    expect(CLOSING_PROMPT.test("Pressione ENTER para fechar...")).toBe(true);
    expect(CLOSING_PROMPT.test("Aguardando a tela cadastral final...")).toBe(
      false,
    );
  });
});
