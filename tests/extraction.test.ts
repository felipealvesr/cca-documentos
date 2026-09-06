import { describe, expect, it } from "vitest";
import { extractDocument } from "../src/shared/extract";
import { consolidate } from "../src/shared/consolidate";
import { normalize, validate } from "../src/shared/fields";
import { assessPage } from "../src/shared/quality";
import type { OcrPage, OcrResult } from "../src/shared/types";
const fromLines = (text: string): OcrResult => {
  const page: OcrPage = {
    number: 1,
    width: 1000,
    height: 1400,
    preview: "",
    method: "ocr",
    elements: text.split("\n").map((line, index) => ({
      text: line,
      page: 1,
      confidence: 0.97,
      box: { x: 50, y: index * 30, width: 500, height: 22 },
    })),
  };
  return { text, pages: [page] };
};
describe("generic extraction", () => {
  it("extracts an unknown document using labels, rows and filiation", () => {
    const doc = extractDocument(
      "1",
      "unknown.png",
      fromLines(
        "NOME\nMARIA DA SILVA\nCPF\n123.456.789-09\nNASCIMENTO\n02/05/1990\nFILIAÇÃO\nJOÃO DA SILVA\nANA MARIA DA SILVA",
      ),
    );
    expect(doc.type).toBe("Documento não identificado");
    expect(doc.data).toMatchObject({
      fullName: "MARIA DA SILVA",
      cpf: "123.456.789-09",
      birthDate: "02/05/1990",
      fatherName: "JOÃO DA SILVA",
      motherName: "ANA MARIA DA SILVA",
    });
    expect(doc.candidates.find((c) => c.key === "fatherName")?.note).toContain(
      "confirme",
    );
  });
  it("keeps additional values and invalid identifiers for review", () => {
    const doc = extractDocument(
      "1",
      "certidao.pdf",
      fromLines(
        "CERTIDÃO DE NASCIMENTO\nNOME: MARIA DA SILVA\nCPF: 123.456.789-00\nLivro: A-12\nFolha: 34\nTermo: 123\nCódigo especial: XP-777",
      ),
    );
    expect(doc.data.cpf).toBe("123.456.789-00");
    expect(validate("cpf", doc.data.cpf!)).toBeTruthy();
    expect(doc.data.additionalFields).toContainEqual({
      label: "Código especial",
      value: "XP-777",
    });
  });
  it("uses spatially adjacent boxes and does not take a value on another page", () => {
    const ocr = fromLines("CPF\n12345678909\nNOME DO PAI");
    ocr.pages[0].elements[1].box = { x: 600, y: 0, width: 250, height: 22 };
    ocr.pages.push({
      ...ocr.pages[0],
      number: 2,
      elements: [
        {
          text: "NOT A PARENT",
          page: 2,
          confidence: 1,
          box: { x: 50, y: 90, width: 500, height: 22 },
        },
      ],
    });
    expect(extractDocument("1", "two.pdf", ocr).data).toMatchObject({
      cpf: "123.456.789-09",
    });
    expect(
      extractDocument("1", "two.pdf", ocr).data.fatherName,
    ).toBeUndefined();
  });
  it("supports overlapping axis-aligned boxes from a slightly rotated photo", () => {
    const ocr = fromLines("NOME\nMARIA DA SILVA");
    ocr.pages[0].elements[0].box = { x: 88, y: 354, width: 84, height: 39 };
    ocr.pages[0].elements[1].box = { x: 94, y: 375, width: 305, height: 68 };
    expect(extractDocument("1", "rotated.jpg", ocr).data.fullName).toBe(
      "MARIA DA SILVA",
    );
  });
  it("does not use a section label as a person name", () => {
    const doc = extractDocument(
      "1",
      "screen.png",
      fromLines("NOME COMPLETO\nFILIAÇÃO\nCPF\n123.456.789-09"),
    );
    expect(doc.data.fullName).toBeUndefined();
  });
  it("consolidates equal data and exposes differences without selecting", () => {
    const a = extractDocument(
      "a",
      "a.pdf",
      fromLines("CPF: 12345678909\nPAI: JOÃO SILVA"),
    );
    const b = extractDocument(
      "b",
      "b.pdf",
      fromLines("CPF: 123.456.789-09\nPAI: JOÃO DA SILVA\nCNH: 01234567890"),
    );
    const fields = consolidate([a, b]);
    expect(fields.find((f) => f.key === "cpf")?.conflict).toBe(false);
    expect(fields.find((f) => f.key === "fatherName")).toMatchObject({
      conflict: true,
      value: "",
    });
    expect(
      consolidate([a, b], { fatherName: "JOÃO DA SILVA" }).find(
        (f) => f.key === "fatherName",
      ),
    ).toMatchObject({ conflict: false, edited: true });
  });
});
describe("normalization and validation", () => {
  it("validates CPF check digits including repeated digits", () => {
    expect(validate("cpf", "123.456.789-09")).toBeUndefined();
    expect(validate("cpf", "123.456.789-00")).toBeTruthy();
    expect(validate("cpf", "000.000.000-00")).toBeTruthy();
    expect(validate("cpf", "abc12345678909")).toBeTruthy();
  });
  it("handles dates, CEP and states without discarding bad values", () => {
    expect(normalize("birthDate", "02112000")).toBe("02/11/2000");
    expect(normalize("address.state", "Santa Catarina")).toBe("SC");
    expect(normalize("address.postalCode", "89230260")).toBe("89230-260");
    expect(validate("birthDate", "29/02/2024")).toBeUndefined();
    expect(validate("birthDate", "29/02/2023")).toBeTruthy();
    expect(validate("cnh", "01234567890")).toBeUndefined();
    expect(validate("cnh", "0123456789A")).toBeTruthy();
  });
});
describe("bounded Medium fallback", () => {
  it("does not retry a clear CIN just because CNH is absent", () => {
    const page = fromLines(
      "CARTEIRA DE IDENTIDADE NACIONAL\nNOME: MARIA DA SILVA\nCPF: 12345678909\nNASCIMENTO: 02/05/1990",
    ).pages[0];
    expect(assessPage(page).shouldFallback).toBe(false);
  });
  it("retries invalid CPF even with excellent confidence", () => {
    const page = fromLines("NOME: MARIA DA SILVA\nCPF: 123.456.789-00")
      .pages[0];
    expect(assessPage(page).reasons).toContain("invalid_fields");
  });
});
