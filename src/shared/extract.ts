import { FIELD_LABELS, digits, fold, normalize, validate } from "./fields";
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
      "NAME",
      "NOMBRE",
      "NOME",
    ],
  ],
  ["socialName", ["NOME SOCIAL"]],
  ["cpf", ["NUMERO DO CPF", "CPF/MF", "CPF"]],
  ["cin", ["NUMERO DA CIN", "CIN"]],
  [
    "rg",
    [
      "DOC[.]? IDENTIDADE",
      "DOCUMENTO DE IDENTIDADE",
      "REGISTRO GERAL",
      "NUMERO DO RG",
      "RG",
    ],
  ],
  [
    "cnh",
    [
      "NUMERO DA CNH",
      "NUMERO CNH",
      "N[º°.]?\s*REGISTRO",
      "N[º°.]?\s*DE\s*REGISTRO",
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
      "DATA, LOCAL E UF DE NASCIMENTO",
      "DATA LOCAL E UF DE NASCIMENTO",
      "LOCAL E DATA DE NASCIMENTO",
      "DATA E LOCAL DE NASCIMENTO",
      "DATA DE NASCIMENTO",
      "DATA NASCIMENTO",
      "DT[.]? NASCIMENTO",
      "DATE OF BIRTH",
      "FECHA DE NACIMIENTO",
      "NASCIMENTO",
    ],
  ],
  [
    "birthPlace",
    [
      "LOCAL DE NASCIMENTO",
      "PLACE OF BIRTH",
      "LUGAR DE NACIMIENTO",
      "NATURALIDADE",
    ],
  ],
  ["nationality", ["NACIONALIDADE", "NATIONALITY", "NACIONALIDAD"]],
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
// A slash separates language variants on trilingual layouts, so it delimits a label too.
const patterns = aliases.flatMap(([key, names]) =>
  names.map((alias) => ({
    key,
    pattern: new RegExp(`(^|[\\s|;:/])(${alias})(?=$|[\\s:;|/\\d–—-])`, "g"),
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
  // On the national ID the registration number is the CPF itself, so a value in
  // CPF shape is never a state RG number, whose mask carries fewer digits. This
  // holds even when the OCR eats the "- CPF" half of the printed label.
  if (
    key === "rg" &&
    (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(folded) ||
      (digits(folded).length === 11 && !validate("cpf", normalize("cpf", folded))))
  )
    return false;
  // No one is named starting with a connective: such a value is the tail of a
  // label the OCR split, not a person.
  if (
    ["fullName", "socialName", "fatherName", "motherName"].includes(key) &&
    /^(?:DO|DA|DE|DOS|DAS|E)(?:\s|$)/.test(folded)
  )
    return false;
  return true;
}
// Numbers printed under these labels are never the CPF.
const OTHER_IDENTIFIER =
  /IDENT(?:IDADE)?\s*MILITAR|PRECEDENCIA|MATRICULA|TITULO DE ELEITOR|\bPIS\b|\bPASEP\b|\bNIS\b|CERTIFICADO|\bSERIE\b|\bRA\b/;
// A label on a card photo loses a character or two; on worn paper it is ruined
// beyond recognition. Measured over real documents, one to two edits separates
// the two, so the budget below recovers the first kind and never the second.
const plain = (alias: string) =>
  alias
    .replace(/\s\*/g, " ")
    .replace(/\[[^\]]*\]\?/g, "")
    .replace(/\[([^\]]*)\]/g, (_, set: string) => set[0])
    .replace(/[?*+()|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const FUZZY: [FieldKey, string][] = aliases.flatMap(([key, names]) =>
  names
    .map(plain)
    .filter((name) => name.length >= 6)
    .map((name) => [key, name] as [FieldKey, string]),
);
function editDistance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}
function approximateLabel(text: string): LabelMatch[] {
  const cleaned = fold(text)
    .replace(/^(?:\d{1,2}[A-Z]?\s*[-.,/]?\s*(?:E\s+)?)+/, "")
    .trim();
  let best: LabelMatch | undefined;
  let distance = Infinity;
  for (const segment of cleaned.split("/").map((part) => part.trim()))
    if (segment.length >= 6)
      for (const [key, alias] of FUZZY) {
        const budget = Math.min(2, Math.floor(alias.length / 6));
        const cost = editDistance(segment, alias);
        if (cost <= budget && cost < distance) {
          distance = cost;
          best = { key, start: 0, end: text.length };
        }
      }
  return best ? [best] : [];
}
interface LabelMatch {
  key: FieldKey;
  start: number;
  end: number;
}
function labels(text: string): LabelMatch[] {
  // Field numbers printed before the label ("4a", "4d", "2 e 1") are not part of it.
  const value = fold(text).replace(
    /^(?:\d{1,2}[A-Z]?\s*[-.,/]?\s*(?:E\s+)?)+(?=[A-Z])/,
    (m) => " ".repeat(m.length),
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
    // A worn document photographed at an angle loses the spaces between words.
    [
      "CNH",
      /CARTEIRA\s*NACIONAL\s*DE\s*HABILITACAO|DRIVER\s*LICENSE/,
      0.98,
    ],
    ["CIN", /CARTEIRA\s*DE\s*IDENTIDADE\s*NACIONAL/, 0.98],
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
      "Certificado de alistamento militar",
      /CERTIFICADO\s*DE\s*ALISTAMENTO\s*MILITAR/,
      0.95,
    ],
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
  const pageWidth = new Map(ocr.pages.map((p) => [p.number, p.width]));
  // Horizontal gaps scale with the page, not with the font: the same card
  // photographed at twice the resolution doubles every distance in pixels.
  const span = (element: OcrElement, ratio: number, floor: number) =>
    Math.max((pageWidth.get(element.page) ?? 1000) * ratio, floor);
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
  // A structured field keeps only what looks like its own value. Returning the raw
  // text turned neighbouring words into identifiers and blocked the numeric fallback.
  const cleanField = (key: FieldKey, value: string) => {
    const text = value.replace(/^\s*[:|–—-]+\s*/, "").trim();
    // Only the digits survive: the surrounding words are never part of the value.
    const loose = (length: number) =>
      digits(text).length === length ? digits(text) : "";
    if (key.endsWith("Date"))
      return (
        text.match(
          /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}-\d{2}-\d{2})\b/,
        )?.[0] ?? loose(8)
      );
    if (key === "cpf" || key === "cin")
      return (
        text.match(/\b\d{3}[. ]?\d{3}[. ]?\d{3}[- ]?\d{2}\b/)?.[0] ?? loose(11)
      );
    if (key === "cnh") return text.match(/\b\d{11}\b/)?.[0] ?? loose(11);
    return text;
  };
  // OCR often cuts a long number between two boxes on the same row; read the row back.
  const rowText = (source: OcrElement) =>
    elements
      .filter(
        (e) =>
          e.page === source.page &&
          e.box.x >= source.box.x &&
          Math.abs(e.box.y - source.box.y) <
            Math.max(source.box.height, e.box.height) * 0.6 &&
          e.box.x - source.box.x - source.box.width < span(source, 0.06, 60),
      )
      .sort((a, b) => a.box.x - b.box.x)
      .map((e) => e.text)
      .join("");
  for (const element of elements) {
    const exact = labels(element.text);
    const found = exact.length ? exact : approximateLabel(element.text);
    // The national ID prints "Registro Geral - CPF": there the CPF is the
    // registration number, so the value is not also a separate RG.
    const matches = found.some((m) => m.key === "cpf")
      ? found.filter((m) => m.key !== "rg")
      : found;
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      let value = element.text
        .slice(match.end, matches[index + 1]?.start)
        // Trailing "/NAME/NOMBRE" is the label in another language, never the value.
        .replace(/^(?:\s*\/\s*[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .]{0,29})+/, "")
        .replace(/^\s*[:|/–—-]+\s*/, "")
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
              e.box.x - element.box.x - element.box.width <
                span(element, 0.25, 250),
          )
          .sort((a, b) => a.box.x - b.box.x)[0];
        const usable = (e: OcrElement) =>
          !labels(e.text).length && !/^[^:]{2,45}:/.test(e.text);
        const fits = (e: OcrElement) =>
          !!(cleanField(match.key, e.text) || cleanField(match.key, rowText(e)));
        const nearest = [right, ...nearby(element)].find(
          (e): e is OcrElement => !!e && usable(e),
        );
        // A combined label ("Local e Data de Nascimento") stacks more than one
        // value. Only a field that can recognise its own value may look further
        // down, otherwise any nearby line would qualify.
        const structured =
          match.key.endsWith("Date") ||
          ["cpf", "cin", "cnh"].includes(match.key);
        // Looking further down must stop at the next label: past it the rows
        // belong to another field, and its value would be read as this one.
        const rows = nearby(element, 3);
        // A row opening with a field number ("4a", "40") is the next label even
        // when the OCR mangles the words after it, as happens on a photo.
        const blocked = rows.findIndex(
          (e) => !usable(e) || /^\d{1,2}[a-zA-Z]?\s/.test(e.text.trim()),
        );
        const below = blocked < 0 ? rows : rows.slice(0, blocked);
        const next =
          nearest && fits(nearest)
            ? nearest
            : structured
              ? (below.find(fits) ?? nearest)
              : nearest;
        if (next) {
          value = next.text;
          source = next;
        }
      }
      if (value)
        add(
          match.key,
          cleanField(match.key, value) ||
            (source === element ? "" : cleanField(match.key, rowText(source))),
          source,
        );
    }
    if (!matches.length) {
      const generic = /^([^:：]{2,60})\s*[:：]\s*(.+)$/.exec(element.text);
      if (generic && !/^FILIACAO$/.test(fold(generic[1]))) {
        const label = generic[1].trim();
        add(`additional:${fold(label)}`, generic[2], element, label);
      }
    }
    if (
      /^(?:\d+\s*)?FILIACAO(?:\s*\/\s*[A-ZÀ-Ý ]+)*\s*:?$/.test(
        fold(element.text),
      )
    ) {
      const relatives = nearby(element, 4).filter(
        (e) => !labels(e.text).length && /^[A-Za-zÀ-ÿ '\-.]+$/.test(e.text),
      );
      // Unlabelled filiation has no universal father/mother order. Keep the inference visible.
      if (relatives.length > 2)
        // Affective filiation adds parents to the block, so the position of a
        // line no longer says which one it is. Every line is offered instead.
        for (const relative of relatives)
          for (const key of ["fatherName", "motherName"] as const)
            add(
              key,
              relative.text,
              relative,
              undefined,
              "O documento traz mais de duas linhas de filiação: escolha o nome correto.",
            );
      else {
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
  }
  // Field-specific anchors provide a fallback even when a label was missed by OCR.
  if (!candidates.some((c) => c.key === "cpf")) {
    const hits: { value: string; formatted: boolean; source: OcrElement }[] = [];
    for (const e of elements) {
      if (labels(e.text).some((l) => ["cnh", "rg", "passport"].includes(l.key)))
        continue;
      // The label often sits in the box above the number inside a framed cell.
      const heading = elements
        .filter(
          (o) =>
            o !== e &&
            o.page === e.page &&
            o.box.y + o.box.height <= e.box.y + e.box.height * 0.5 &&
            e.box.y - o.box.y - o.box.height <
              Math.max(e.box.height * 2, 50) &&
            Math.abs(o.box.x - e.box.x) < Math.max(e.box.width, 120),
        )
        .sort((a, b) => b.box.y - a.box.y)[0];
      if (OTHER_IDENTIFIER.test(fold(`${e.text} ${heading?.text ?? ""}`)))
        continue;
      const text = /\d{11}/.test(digits(e.text)) ? e.text : rowText(e);
      for (const m of text.matchAll(
        /\b(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})\b/g,
      )) {
        const value = normalize("cpf", m[0]);
        if (m[0].includes(".") || !validate("cpf", value))
          hits.push({ value, formatted: m[0].includes("."), source: e });
      }
    }
    // A number printed in CPF format outranks a bare 11-digit run, which on many
    // documents is a different identifier altogether.
    for (const hit of hits.some((h) => h.formatted)
      ? hits.filter((h) => h.formatted)
      : hits)
      add(
        "cpf",
        hit.value,
        hit.source,
        undefined,
        "CPF localizado pelo padrão numérico; confira no documento.",
      );
  }
  // On the older licence the printed labels come back 40-75% corrupted while the
  // digits read cleanly, so the registration number needs an anchor of its own.
  // Only an unambiguous single match is offered, and always for confirmation.
  if (!candidates.some((c) => c.key === "cnh")) {
    const taken = new Set(
      candidates
        .filter((c) => ["cpf", "cin", "rg"].includes(c.key))
        .map((c) => digits(c.value)),
    );
    const found = new Map<string, OcrElement>();
    for (const e of elements) {
      if (
        labels(e.text).some((l) =>
          ["cpf", "cin", "rg", "passport"].includes(l.key),
        ) ||
        OTHER_IDENTIFIER.test(fold(e.text))
      )
        continue;
      for (const m of e.text.matchAll(/\b\d{11}\b/g))
        if (!taken.has(m[0]) && !found.has(m[0])) found.set(m[0], e);
    }
    // More than one number fits: the conflict is shown and the employee picks,
    // which beats an empty field. Only on a document that already yielded a CPF,
    // so stray numbers elsewhere do not flood the review.
    if (found.size <= 2 && candidates.some((c) => c.key === "cpf"))
      for (const [value, source] of found)
        add(
          "cnh",
          value,
          source,
          undefined,
          "Número de registro localizado pelo padrão numérico; confira no documento.",
        );
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
