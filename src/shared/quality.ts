import type { OcrPage } from "./types";
import { extractDocument } from "./extract";
import { fold, validate } from "./fields";
export function assessPage(page: OcrPage) {
  const text = page.elements.map((e) => e.text).join("\n");
  const doc = extractDocument("quality", "documento", { text, pages: [page] });
  const reasons: string[] = [];
  const scores = page.elements.flatMap((e) =>
    e.confidence === undefined ? [] : [e.confidence],
  );
  const confidence = scores.length
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : 1;
  const invalid = doc.candidates.filter((c) => validate(c.key, c.value));
  const keys = new Set(doc.candidates.map((c) => c.key));
  const inconsistencies = [...keys].filter(
    (key) =>
      new Set(
        doc.candidates.filter((c) => c.key === key).map((c) => fold(c.value)),
      ).size > 1,
  );
  if (text.replace(/\s/g, "").length < 15) reasons.push("insufficient_text");
  if (confidence < 0.83) reasons.push("low_confidence");
  if (invalid.length) reasons.push("invalid_fields");
  if (inconsistencies.length) reasons.push("inconsistent_fields");
  // Missing information alone is normal. Retry only if a label or document context suggests it is present.
  const expected = [
    { key: "cpf", label: /\bCPF\b/ },
    { key: "fatherName", label: /NOME DO PAI|\bFILIACAO\b/ },
    { key: "cnh", label: /\bCNH\b|N[º°.]? REGISTRO/ },
  ];
  if (
    expected.some(
      ({ key, label }) => !keys.has(key as never) && label.test(fold(text)),
    )
  )
    reasons.push("anchored_priority_missing");
  const score = Math.max(
    0,
    Math.round(
      confidence * 60 +
        Math.min(keys.size, 8) * 5 -
        invalid.length * 18 -
        inconsistencies.length * 12 -
        reasons.filter(
          (r) => r === "insufficient_text" || r === "anchored_priority_missing",
        ).length *
          20,
    ),
  );
  return {
    score,
    reasons,
    shouldFallback: reasons.length > 0,
    fieldsFound: keys.size,
    fieldsValid: doc.candidates.length - invalid.length,
  };
}
