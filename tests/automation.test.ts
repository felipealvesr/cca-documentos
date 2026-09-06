import { describe, it, expect } from "vitest";
import { protocolStatus, validateAutomation } from "../electron/automation";
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
  it("does not confuse waiting, failure or an exit with success", () => {
    expect(
      protocolStatus("3) Volte para esta janela e pressione ENTER.")?.phase,
    ).toBe("waiting");
    expect(protocolStatus("Aguardando a tela cadastral final...")?.phase).toBe(
      "final",
    );
    expect(
      protocolStatus("Não consegui confirmar a chegada à tela cadastral final.")
        ?.phase,
    ).toBe("error");
    expect(protocolStatus(" TELA CADASTRAL FINAL DETECTADA")?.phase).toBe(
      "done",
    );
    expect(
      protocolStatus(
        "Escopo: CPF -> Identificação Positiva -> tela cadastral -> PARAR",
      ),
    ).toBeUndefined();
  });
});
