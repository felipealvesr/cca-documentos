import { FIELD_LABELS, fold, normalize, validate } from "./fields";
import { toPersonData } from "./consolidate";
import type {
  Candidate,
  FieldKey,
  OcrElement,
  OcrResult,
  ProcessedDocument,
  ReviewKey,
} from "./types";

// Labels are shared across layouts. Classification never selects an extraction template.
const aliases: [FieldKey, string[]][] = [
  [
    "fullName",
    [
      "NOME COMPLETO",
      "NOME DO TITULAR",
      "NOME DO REQUERENTE",
      "NOME CIVIL",
      "NOME E SOBRENOME",
      "FULL NAME",
      "NOME",
    ],
  ],
  ["socialName", ["NOME SOCIAL"]],
  ["cpf", ["NUMERO DO CPF", "CPF/MF", "CPF"]],
  ["cin", ["NUMERO DA CIN", "CIN"]],
  ["rg", ["REGISTRO GERAL", "NUMERO DO RG", "RG"]],
  [
    "cnh",
    [
      "NUMERO DA CNH",
      "NUMERO CNH",
      "N[º°.]? REGISTRO",
      "N[º°.]? DE REGISTRO",
      "NUMERO DE REGISTRO",
      "REGISTRO CNH",
      "CNH",
    ],
  ],
  [
    "passport",
    ["PASSAPORTE N[º°.]?", "PASSPORT NO[.]?", "NUMERO DO PASSAPORTE"],
  ],
  [
    "birthDate",
    [
      "DATA DE NASCIMENTO",
      "DATA NASCIMENTO",
      "DT[.]? NASCIMENTO",
      "DATE OF BIRTH",
      "NASCIMENTO",
    ],
  ],
  ["birthPlace", ["LOCAL DE NASCIMENTO", "PLACE OF BIRTH", "NATURALIDADE"]],
  ["nationality", ["NACIONALIDADE", "NATIONALITY"]],
  ["fatherName", ["NOME DO PAI", "NOME PAI", "FILIACAO PATERNA", "PAI"]],
  ["motherName", ["NOME DA MAE", "NOME MAE", "FILIACAO MATERNA", "MAE"]],
  ["gender", ["SEXO", "GENERO", "SEX"]],
  ["maritalStatus", ["ESTADO CIVIL"]],
  [
    "issuingAuthority",
    [
      "ORGAO EXPEDIDOR",
      "ORGAO EMISSOR",
      "ORG[.]? EMISSOR",
      "ISSUING AUTHORITY",
    ],
  ],
  ["issuingState", ["UF DE EMISSAO", "UF EMISSOR", "UF DE EXPEDICAO"]],
  [
    "issueDate",
    [
      "DATA DE EXPEDICAO",
      "DATA DA EXPEDICAO",
      "DATA DE EMISSAO",
      "DATA EMISSAO",
      "DATE OF ISSUE",
      "EXPEDICAO",
    ],
  ],
  [
    "expirationDate",
    ["DATA DE VALIDADE", "DATA VALIDADE", "DATE OF EXPIRY", "VALIDADE"],
  ],
  ["address.street", ["ENDERECO RESIDENCIAL", "LOGRADOURO", "ENDERECO"]],
  ["address.number", ["NUMERO DO ENDERECO", "NUMERO RESIDENCIAL", "NUMERO"]],
  ["address.complement", ["COMPLEMENTO"]],
  ["address.neighborhood", ["BAIRRO"]],
  ["address.city", ["MUNICIPIO DE RESIDENCIA", "CIDADE", "MUNICIPIO"]],
  ["address.state", ["UF DO ENDERECO", "ESTADO", "UF"]],
  ["address.postalCode", ["CODIGO POSTAL", "CEP"]],
];
const patterns = aliases.flatMap(([key, names]) =>
  names.map((alias) => ({
    key,
    pattern: new RegExp(`(^|[\\s|;:])(${alias})(?=$|[\\s:;|\\d–—-])`, "g"),
  })),
);
const NON_VALUE_LABELS = new Set([
  ...Object.values(FIELD_LABELS).map(fold),
  "FILIACAO",
  "FILIAÇÃO",
  "PARA O CADASTRO",
  "IDENTIFICADO",
  "IDENTIFICADO - PAGINA 1",
  "NAO ENCONTRADO NESTE DOCUMENTO",
  "DADOS NECESSARIOS PARA O CADASTRO",
  "CONFERENCIA",
  "DOCUMENTO ORIGINAL",
  "DADOS IDENTIFICADOS",
]);
function isUsableValue(key: ReviewKey, value: string) {
  const folded = fold(value).replace(/[.·]+/g, " ").trim();
  if (NON_VALUE_LABELS.has(folded)) return false;
  if (
    key === "fullName" &&
    /^(?:NOME|FILIA|FILIAC|PAI|MAE|CPF|CNH|RG|CIN|PASSAPORTE)(?:\s|$)/.test(
      folded,
    )
  )
    return false;
  return true;
}
interface LabelMatch {
  key: FieldKey;
  start: number;
  end: number;
}
function labels(text: string): LabelMatch[] {
  const value = fold(text).replace(/^\d{1,2}[A-Z]?\s*[-.]?\s*(?=[A-Z])/, (m) =>
    " ".repeat(m.length),
  );
  const found: LabelMatch[] = [];
  for (const { key, pattern } of patterns) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern))
      found.push({
        key,
        start: match.index! + match[1].length,
        end: match.index! + match[0].length,
      });
  }
  const ordered = found
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .filter(
      (m, i, all) =>
        !all.slice(0, i).some((x) => x.start <= m.start && x.end >= m.end),
    )
    .sort((a, b) => a.start - b.start);
  // A word in prose (e.g. “sem validade”) is not a field label.
  return ordered.length &&
    /^[\s\d|:;./–—-]*$/.test(value.slice(0, ordered[0].start))
    ? ordered
    : [];
}
export function classify(text: string): { type: string; confidence: number } {
  const value = fold(text);
  const signals: [string, RegExp, number][] = [
    ["CNH", /CARTEIRA NACIONAL DE HABILITACAO|DRIVER LICENSE/, 0.98],
    ["CIN", /CARTEIRA DE IDENTIDADE NACIONAL/, 0.98],
    ["Certidão de nascimento", /CERTIDAO DE NASCIMENTO/, 0.98],
    ["Certidão de casamento", /CERTIDAO DE CASAMENTO/, 0.98],
    ["Passaporte", /PASSPORT|PASSAPORTE|P<BRA/, 0.95],
    [
      "Carteira profissional",
      /CARTEIRA DE TRABALHO|CTPS|CARTEIRA PROFISSIONAL/,
      0.91,
    ],
    ["RG", /REGISTRO GERAL|CEDULA DE IDENTIDADE|CARTEIRA DE IDENTIDADE/, 0.84],
    ["CPF", /CADASTRO DE PESSOAS FISICAS|COMPROVANTE DE INSCRICAO.*CPF/, 0.9],
    [
      "Identificação funcional",
      /IDENTIDADE FUNCIONAL|IDENTIFICACAO FUNCIONAL/,
      0.86,
    ],
  ];
  const match = signals.find(([, pattern]) => pattern.test(value));
  return match
    ? { type: match[0], confidence: match[2] }
    : { type: "Documento não identificado", confidence: 0 };
}
export function extractDocument(
  id: string,
  name: string,
  ocr: OcrResult,
): ProcessedDocument {
  const classification = classify(ocr.text);
  const elements = ocr.pages
    .flatMap((p) => p.elements)
    .map((e) => ({ ...e, text: e.text.replace(/\s+/g, " ").trim() }))
    .filter((e) => e.text);
  const candidates: Candidate[] = [];
  const add = (
    key: ReviewKey,
    value: string,
    source: OcrElement,
    label?: string,
    note?: string,
  ) => {
    const cleaned = normalize(key, value);
    if (
      !cleaned ||
      /^[-–—:;|/]+$/.test(cleaned) ||
      !isUsableValue(key, cleaned)
    )
      return;
    if (
      candidates.some(
        (c) =>
          c.key === key &&
          fold(c.value) === fold(cleaned) &&
          c.page === source.page,
      )
    )
      return;
    candidates.push({
      key,
      label: label ?? FIELD_LABELS[key as FieldKey],
      value: cleaned,
      confidence: source.confidence,
      documentId: id,
      documentName: name,
      page: source.page,
      box: source.box,
      note,
    });
  };
  const nearby = (source: OcrElement, maxLines = 1) =>
    elements
      .filter(
        (e) =>
          e !== source &&
          e.page === source.page &&
          e.box.y + e.box.height / 2 >=
            source.box.y + source.box.height * 0.75 &&
          e.box.y - source.box.y <
            Math.max(source.box.height * (maxLines > 1 ? 4 : 2.5), 60) &&
          Math.abs(e.box.x - source.box.x) <
            Math.max(source.box.width * 0.6, 100),
      )
      .sort(
        (a, b) =>
          a.box.y + a.box.height / 2 - b.box.y - b.box.height / 2 ||
          a.box.x - b.box.x,
      )
      .slice(0, maxLines);
  const cleanField = (key: FieldKey, value: string) => {
    const text = value.replace(/^\s*[:|–—-]+\s*/, "").trim();
    if (key.endsWith("Date"))
      return (
        text.match(
          /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}-\d{2}-\d{2})\b/,
        )?.[0] ?? text
      );
    if (key === "cpf" || key === "cin")
      return text.match(/\b\d{3}[. ]?\d{3}[. ]?\d{3}[- ]?\d{2}\b/)?.[0] ?? text;
    if (key === "cnh") return text.match(/\b\d{11}\b/)?.[0] ?? text;
    return text;
  };
  for (const element of elements) {
    const matches = labels(element.text);
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      let value = element.text
        .slice(match.end, matches[index + 1]?.start)
        .replace(/^\s*[:|–—-]+\s*/, "")
        .trim();
      let source = element;
      if (!value) {
        // A separate OCR box to the right is preferred, then the nearest aligned row below.
        const right = elements
          .filter(
            (e) =>
              e !== element &&
              e.page === element.page &&
              Math.abs(e.box.y - element.box.y) <
                Math.max(element.box.height, e.box.height) * 0.6 &&
              e.box.x >= element.box.x + element.box.width &&
              e.box.x - element.box.x - element.box.width < 250,
          )
          .sort((a, b) => a.box.x - b.box.x)[0];
        const next = right ?? nearby(element)[0];
        if (
          next &&
          !labels(next.text).length &&
          !/^[^:]{2,45}:/.test(next.text)
        ) {
          value = next.text;
          source = next;
        }
      }
      if (value) add(match.key, cleanField(match.key, value), source);
    }
    if (!matches.length) {
      const generic = /^([^:：]{2,60})\s*[:：]\s*(.+)$/.exec(element.text);
      if (generic && !/^FILIACAO$/.test(fold(generic[1]))) {
        const label = generic[1].trim();
        add(`additional:${fold(label)}`, generic[2], element, label);
      }
    }
    if (/^(?:\d+\s*)?FILIACAO\s*:?$/.test(fold(element.text))) {
      const relatives = nearby(element, 2).filter(
        (e) => !labels(e.text).length && /^[A-Za-zÀ-ÿ '\-.]+$/.test(e.text),
      );
      // Unlabelled filiation has no universal father/mother order. Keep the inference visible.
      if (relatives[0])
        add(
          "fatherName",
          relatives[0].text,
          relatives[0],
          undefined,
          "Filiação sem rótulo: confirme se este é o nome do pai.",
        );
      if (relatives[1])
        add(
          "motherName",
          relatives[1].text,
          relatives[1],
          undefined,
          "Filiação sem rótulo: confirme se este é o nome da mãe.",
        );
    }
  }
  // Field-specific anchors provide a fallback even when a label was missed by OCR.
  if (!candidates.some((c) => c.key === "cpf"))
    for (const e of elements) {
      if (labels(e.text).some((l) => ["cnh", "rg", "passport"].includes(l.key)))
        continue;
      for (const m of e.text.matchAll(
        /\b(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})\b/g,
      )) {
        const value = normalize("cpf", m[0]);
        if (m[0].includes(".") || !validate("cpf", value))
          add(
            "cpf",
            value,
            e,
            undefined,
            "CPF localizado pelo padrão numérico; confira no documento.",
          );
      }
    }
  const data = toPersonData(
    candidates.filter(
      (c) =>
        new Set(
          candidates
            .filter((other) => other.key === c.key)
            .map((other) => fold(other.value)),
        ).size === 1,
    ),
  );
  data.documentType = classification.type;
  return {
    id,
    name,
    type: classification.type,
    typeConfidence: classification.confidence,
    ocr,
    data,
    candidates,
  };
}
