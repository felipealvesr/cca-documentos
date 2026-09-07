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
// Boxed layouts (military ID backs) and the trilingual new national ID were the
// two shapes the label/value geometry used to miss.
const fromBoxes = (boxes: [string, number, number, number, number][]): OcrResult => {
  const elements = boxes.map(([text, x, y, width, height]) => ({
    text,
    page: 1,
    confidence: 0.95,
    box: { x, y, width, height },
  }));
  return {
    text: elements.map((e) => e.text).join("\n"),
    pages: [
      {
        number: 1,
        width: 1000,
        height: 640,
        preview: "",
        method: "ocr" as const,
        elements,
      },
    ],
  };
};
describe("boxed and multilingual layouts", () => {
  it("keeps the CPF apart from other 11-digit identifiers on a military ID back", () => {
    const doc = extractDocument(
      "1",
      "militar-verso.png",
      fromBoxes([
        ["FILIACAO", 40, 30, 150, 18],
        ["JOAO DA SILVA", 40, 56, 300, 20],
        ["ANA MARIA DA SILVA", 40, 82, 320, 20],
        ["IDENT MILITAR", 40, 130, 190, 18],
        ["01234567890", 40, 156, 190, 20],
        ["PRECEDENCIA", 40, 200, 170, 18],
        ["98765432100", 40, 226, 190, 20],
        ["CPF", 640, 300, 46, 18],
        ["123.456.789-09", 640, 396, 190, 22],
      ]),
    );
    expect(doc.candidates.filter((c) => c.key === "cpf")).toHaveLength(1);
    expect(doc.data.cpf).toBe("123.456.789-09");
    expect(doc.data.fatherName).toBe("JOAO DA SILVA");
  });
  it("rebuilds a number the OCR split between two boxes in a framed cell", () => {
    const doc = extractDocument(
      "1",
      "subquadrado.png",
      fromBoxes([
        ["CPF", 640, 300, 46, 18],
        ["123.456.", 640, 330, 100, 22],
        ["789-09", 745, 330, 80, 22],
      ]),
    );
    expect(doc.data.cpf).toBe("123.456.789-09");
  });
  it("never turns a stray word next to a label into an identifier", () => {
    const doc = extractDocument(
      "1",
      "subquadrado.png",
      fromBoxes([
        ["CPF N", 400, 300, 70, 18],
        ["123.456.789-09", 760, 300, 190, 22],
      ]),
    );
    expect(doc.data.cpf).toBe("123.456.789-09");
    expect(doc.candidates.some((c) => c.value === "N")).toBe(false);
  });
  it("reads the trilingual labels of the new national ID", () => {
    const doc = extractDocument(
      "1",
      "cin.png",
      fromBoxes([
        ["CARTEIRA DE IDENTIDADE NACIONAL", 60, 10, 500, 24],
        ["NOME/NAME/NOMBRE", 60, 60, 260, 18],
        ["MARIA DA SILVA", 60, 88, 300, 22],
        ["CPF/TAX NUMBER", 60, 130, 220, 18],
        ["123.456.789-09", 60, 158, 190, 22],
        ["DATA DE NASCIMENTO/DATE OF BIRTH", 60, 200, 420, 18],
        ["02/05/1990", 60, 228, 150, 22],
        ["FILIACAO/PARENTAGE", 60, 270, 260, 18],
        ["JOAO DA SILVA", 60, 298, 300, 22],
        ["ANA MARIA DA SILVA", 60, 326, 320, 22],
      ]),
    );
    expect(doc.type).toBe("CIN");
    expect(doc.data).toMatchObject({
      fullName: "MARIA DA SILVA",
      cpf: "123.456.789-09",
      birthDate: "02/05/1990",
      fatherName: "JOAO DA SILVA",
      motherName: "ANA MARIA DA SILVA",
    });
  });
  it("reads a card layout the same way at any photo resolution", () => {
    const card: [string, number, number, number, number][] = [
      ["NOME/NAME/NOMBRE", 60, 60, 200, 18],
      ["MARIA DA SILVA", 400, 60, 240, 20],
      ["CPF", 60, 100, 46, 18],
      ["123.456.789-09", 400, 100, 190, 20],
      ["DATA DE NASCIMENTO/DATE OF BIRTH", 60, 140, 330, 18],
      ["02/05/1990", 400, 140, 150, 20],
      ["NOME DO PAI/FATHER", 60, 180, 190, 18],
      ["JOAO DA SILVA", 400, 180, 220, 20],
    ];
    // Pixel distances double with the resolution; the thresholds must follow.
    for (const k of [1, 2, 4, 8]) {
      const ocr = fromBoxes(
        card.map(([t, x, y, w, h]): [string, number, number, number, number] => [
          t,
          x * k,
          y * k,
          w * k,
          h * k,
        ]),
      );
      ocr.pages[0].width *= k;
      ocr.pages[0].height *= k;
      expect(extractDocument("1", `card-${k}x.png`, ocr).data).toMatchObject({
        fullName: "MARIA DA SILVA",
        cpf: "123.456.789-09",
        birthDate: "02/05/1990",
        fatherName: "JOAO DA SILVA",
      });
    }
  });
  it("reads a framed military enlistment certificate", () => {
    // Geometry measured by running the real OCR over the Ministério da Defesa
    // CAM specimen: every field sits in its own frame with the label on the
    // border, the CPF shares a row with the enlistment number, and the CPF is
    // printed with dots only. Filiation lists the mother first.
    const ocr = fromBoxes([
      ["Tipo de Documento", 149, 301, 268, 33],
      ["CertificadodeAlistamentoMilitar", 151, 350, 484, 33],
      ["RA", 155, 416, 45, 32],
      ["CPF", 686, 417, 59, 30],
      ["12.345.678901.2", 156, 451, 233, 33],
      ["123.456.789.09", 686, 451, 213, 33],
      ["Nome", 155, 503, 84, 31],
      ["MARIA DA SILVA", 162, 542, 282, 42],
      ["Filiação", 153, 612, 111, 41],
      ["ANA MARIA DA SILVA", 149, 651, 392, 41],
      ["JOAO DA SILVA", 147, 695, 381, 38],
      ["Local e Data de Nascimento", 156, 772, 367, 29],
      ["CIDADENATAL -ESTADO", 147, 802, 353, 36],
      ["02/05/1990", 147, 854, 177, 41],
    ]);
    ocr.pages[0].width = 1018;
    ocr.pages[0].height = 1600;
    const doc = extractDocument("1", "cam.png", ocr);
    expect(doc.type).toBe("Certificado de alistamento militar");
    expect(doc.data.fullName).toBe("MARIA DA SILVA");
    // Dots instead of a hyphen, and an enlistment number one frame to the left.
    expect(doc.data.cpf).toBe("123.456.789-09");
    // The date is the second row under a single combined label.
    expect(doc.data.birthDate).toBe("02/05/1990");
    // This form prints the mother first, so the order alone cannot be trusted
    // and the guess must reach the employee marked for confirmation.
    expect(doc.candidates.find((c) => c.key === "fatherName")?.note).toContain(
      "confirme",
    );
  });
  it("reads the numbered fields of the current driver licence", () => {
    // Geometry measured by running the real OCR over a Senatran CNH specimen.
    // Labels carry their field number ("4a", "4d", "2 e 1"), the OCR drops the
    // space in "N REGISTRO", and birth date shares one label with place and UF.
    const ocr = fromBoxes([
      [
        "CARTEIRA NACIONAL DE HABILITAÇÃO /DRIVER LICENSE / PERMISO DE CONDUCCIÓN",
        275, 182, 1351, 80,
      ],
      ["2e 1 NOME E SOBRENOME", 284, 287, 390, 36],
      ["MARIA DA SILVA SANTOS", 296, 319, 610, 45],
      ["3 DATA, LOCAL E UF DE NASCIMENTO", 758, 381, 457, 34],
      ["19/09/1981 SAO PAULO/SP", 752, 412, 440, 47],
      ["4a DATA EMISSÃO", 772, 477, 216, 36],
      ["24/05/2022", 783, 507, 185, 50],
      ["4c DOC. IDENTIDADE/ÓRG. EMISSOR/UF", 756, 574, 503, 35],
      ["513584349 SSPSP", 751, 610, 304, 46],
      ["4d CPF", 752, 674, 93, 28],
      ["5N°REGISTRO", 1101, 673, 192, 27],
      ["076.763.758-51", 768, 701, 248, 43],
      ["00002944662", 1112, 703, 222, 42],
      ["FILIAÇÃO", 748, 852, 123, 41],
      ["JOAO DA SILVA", 741, 893, 362, 42],
      ["ANA MARIA SANTOS", 741, 937, 362, 42],
    ]);
    ocr.pages[0].width = 1700;
    ocr.pages[0].height = 960;
    const doc = extractDocument("1", "cnh.jpg", ocr);
    expect(doc.type).toBe("CNH");
    expect(doc.data).toMatchObject({
      fullName: "MARIA DA SILVA SANTOS",
      cpf: "076.763.758-51",
      // Second field of a label shared with place and UF.
      birthDate: "19/09/1981",
      // Eleven digits sitting one frame away from the CPF: never confused for it.
      cnh: "00002944662",
    });
    expect(doc.data.cpf).not.toBe("000.029.446-62");
  });
  it("drops a name fragment left over from a label the OCR split", () => {
    // Callouts around a document ("Nome do Condutor", "Assinatura do Emissor")
    // leave a connective at the head of the value. Nobody is named "do Emissor",
    // and an empty field the employee notices beats a plausible wrong one.
    const doc = extractDocument(
      "1",
      "infografico.jpg",
      fromBoxes([
        ["Nome do Condutor", 100, 100, 300, 30],
        ["Assinatura do Emissor", 100, 200, 340, 30],
      ]),
    );
    expect(doc.data.fullName).toBeUndefined();
    expect(doc.data.motherName).toBeUndefined();
    // A real name keeps working, connectives inside it included.
    expect(
      extractDocument(
        "1",
        "ok.png",
        fromBoxes([
          ["NOME", 100, 100, 90, 30],
          ["MARIA DE SOUZA DOS SANTOS", 100, 140, 420, 30],
        ]),
      ).data.fullName,
    ).toBe("MARIA DE SOUZA DOS SANTOS");
  });
  it("does not borrow the next field value when its own is unreadable", () => {
    // Geometry measured from a photo of a real CNH whose personal fields are
    // blurred. The OCR also mangled "DATA EMISSÃO" into "DATA EMESSÃO", so the
    // field number is the only thing marking where the birth field ends.
    const doc = extractDocument(
      "1",
      "foto.png",
      fromBoxes([
        ["3 DATA LOCAL E UF DE NASCIMENTO", 873, 602, 243, 21],
        ["4a DATA EMESSÃO", 880, 646, 116, 21],
        ["23/08/2023", 886, 661, 100, 27],
      ]),
    );
    expect(doc.data.birthDate).toBeUndefined();
    // The combined label of a certificate still reaches its second row.
    expect(
      extractDocument(
        "1",
        "cam.png",
        fromBoxes([
          ["Local e Data de Nascimento", 156, 772, 367, 29],
          ["CIDADENATAL -ESTADO", 147, 802, 353, 36],
          ["02/05/1990", 147, 854, 177, 41],
        ]),
      ).data.birthDate,
    ).toBe("02/05/1990");
  });
  it("works off the values when the older licence labels are unreadable", () => {
    // Geometry measured over a specimen of the pre-2022 CNH. Its labels print in
    // tiny light type and come back 38-75%% corrupted ("DATA NASCIMENTO" reads
    // "MINTO" at 0.89 confidence), so nothing here can be matched by label.
    const doc = extractDocument(
      "1",
      "cnh-antiga-real.jpg",
      fromBoxes([
        ["LINCE DA SILVA", 225, 229, 298, 47],
        ["SOCDNTDAN", 682, 290, 185, 36],
        ["5123223 DGPC/GO", 674, 324, 335, 37],
        ["MINTO", 1113, 385, 81, 21],
        ["891.340.611-75", 662, 410, 281, 45],
        ["02/05/2017", 994, 414, 197, 41],
        ["HLIAGAO", 676, 468, 108, 33],
        ["Pai José da Silva", 662, 508, 330, 40],
        ["Mãe Maria da Silva", 660, 544, 351, 42],
        ["REGSRO", 247, 789, 138, 32],
        ["00123456789", 223, 821, 244, 43],
        ["02/05/2018", 650, 820, 201, 44],
        ["61147258369", 957, 1532, 261, 51],
      ]),
    );
    // The CPF still lands: its shape is the anchor, not the rotten label.
    expect(doc.data.cpf).toBe("891.340.611-75");
    // This layout writes the parent inside the value, so filiation survives.
    expect(doc.data.fatherName).toBe("José da Silva");
    expect(doc.data.motherName).toBe("Maria da Silva");
    // Registration number and security code are both eleven digits. Guessing is
    // worse than asking, so both reach the employee and the field blocks.
    const registration = doc.candidates.filter((c) => c.key === "cnh");
    expect(registration.map((c) => c.value).sort()).toEqual([
      "00123456789",
      "61147258369",
    ]);
    expect(registration[0].note).toContain("confira");
    expect(doc.data.cnh).toBeUndefined();
  });
  it("stops guessing when filiation lists an affective parent", () => {
    // Geometry measured over a Senatran specimen of the current licence, which
    // prints father, affective father, mother and affective mother. Position no
    // longer says which line is which, so the choice goes to the employee.
    const doc = extractDocument(
      "1",
      "cnh-afetiva.png",
      fromBoxes([
        ["FILIAÇÃO", 559, 644, 94, 31],
        ["JOAO DA SILVA", 555, 675, 272, 33],
        ["CARLOS PEREIRA", 557, 719, 287, 30],
        ["MARIA SANTOS", 557, 760, 281, 33],
      ]),
    );
    expect(doc.data.fatherName).toBeUndefined();
    expect(
      doc.candidates.filter((c) => c.key === "fatherName").map((c) => c.value),
    ).toEqual(["JOAO DA SILVA", "CARLOS PEREIRA", "MARIA SANTOS"]);
    expect(doc.candidates.find((c) => c.key === "fatherName")?.note).toContain(
      "mais de duas linhas",
    );
    // Two lines stay a straight reading with the usual confirmation note.
    const plain = extractDocument(
      "1",
      "cnh.png",
      fromBoxes([
        ["FILIAÇÃO", 559, 644, 94, 31],
        ["JOAO DA SILVA", 555, 675, 272, 33],
        ["MARIA SANTOS", 557, 719, 281, 33],
      ]),
    );
    expect(plain.data).toMatchObject({
      fatherName: "JOAO DA SILVA",
      motherName: "MARIA SANTOS",
    });
  });
  it("recovers a label the OCR chipped, but not one it destroyed", () => {
    // Geometry and OCR text measured over a specimen of the national ID card.
    const doc = extractDocument(
      "1",
      "cin-real.jpg",
      fromBoxes([
        ["CARTEIRA DE IDENTIDADE", 593, 377, 331, 35],
        ["Nome /Name", 594, 429, 92, 21],
        ["Maria Joana Ribeiro", 592, 446, 142, 26],
        ["Regstro Ceral - CFF : Pertonal hiuamber", 596, 548, 273, 26],
        ["088.794.450-73", 594, 566, 177, 35],
        ["Data de hascimento / Cate of Berth", 596, 594, 217, 26],
        ["01/01/1971", 596, 613, 99, 31],
      ]),
    );
    // "hascimento" is one edit from the printed label and comes back.
    expect(doc.data).toMatchObject({
      fullName: "Maria Joana Ribeiro",
      cpf: "088.794.450-73",
      birthDate: "01/01/1971",
    });
    // On this card the CPF is the registration number: there is no separate RG.
    expect(doc.data.rg).toBeUndefined();
    expect(
      extractDocument(
        "1",
        "cin-limpo.jpg",
        fromBoxes([
          ["Registro Geral - CPF / Personal Number", 596, 548, 273, 26],
          ["088.794.450-73", 594, 566, 177, 35],
        ]),
      ).data.rg,
    ).toBeUndefined();
    // A label ruined on worn paper stays unmatched: "MINTO" is eleven edits from
    // "DATA NASCIMENTO" and no budget that recovers it would be safe.
    expect(
      extractDocument(
        "1",
        "papel.jpg",
        fromBoxes([
          ["MINTO", 1113, 385, 81, 21],
          ["02/05/2017", 994, 414, 197, 41],
        ]),
      ).data.birthDate,
    ).toBeUndefined();
  });
  it("keeps the CPF out of the RG field on the national ID", () => {
    // The national ID has no separate CPF field: the CPF is the registration
    // number, printed as "Registro Geral - CPF". Only the older RG carries both,
    // and its number uses a shorter mask, so the value shape settles it whatever
    // the OCR does to the label.
    const number = ["088.794.450-73", 594, 566, 177, 35] as [
      string,
      number,
      number,
      number,
      number,
    ];
    for (const label of [
      "Registro Geral - CPF / Personal Number",
      "Registro Geral / Personal Number",
      "Regstro Geral",
    ]) {
      const doc = extractDocument(
        "1",
        "cin.jpg",
        fromBoxes([[label, 596, 548, 273, 26], number]),
      );
      expect(doc.data.cpf).toBe("088.794.450-73");
      expect(doc.data.rg).toBeUndefined();
    }
    // The older card keeps both fields, each with its own number.
    expect(
      extractDocument(
        "1",
        "rg.png",
        fromBoxes([
          ["REGISTRO GERAL", 76, 870, 223, 27],
          ["12.345.678-9", 78, 912, 234, 37],
          ["CPF", 75, 366, 59, 33],
          ["123.456.789-09", 76, 408, 279, 42],
        ]),
      ).data,
    ).toMatchObject({ cpf: "123.456.789-09", rg: "12.345.678-9" });
  });
  it("still reads a plain label followed by a space", () => {
    const doc = extractDocument(
      "1",
      "simples.png",
      fromBoxes([["NOME MARIA DA SILVA", 60, 40, 320, 20]]),
    );
    expect(doc.data.fullName).toBe("MARIA DA SILVA");
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
