import { FIELD_LABELS, PRIMARY, fold, normalize } from "./fields";
import type {
  ExtractedPersonData,
  FieldKey,
  ProcessedDocument,
  ReviewField,
  ReviewKey,
} from "./types";
export function consolidate(
  documents: ProcessedDocument[],
  edits: Partial<Record<ReviewKey, string>> = {},
): ReviewField[] {
  const fields = new Map<ReviewKey, ReviewField>();
  for (const key of PRIMARY)
    fields.set(key, {
      key,
      label: FIELD_LABELS[key],
      value: "",
      candidates: [],
      conflict: false,
      edited: false,
    });
  for (const doc of documents)
    for (const c of doc.candidates) {
      const field = fields.get(c.key) ?? {
        key: c.key,
        label: c.label,
        value: "",
        candidates: [],
        conflict: false,
        edited: false,
      };
      field.candidates.push(c);
      fields.set(c.key, field);
    }
  for (const [key, value] of Object.entries(edits))
    if (!fields.has(key as ReviewKey))
      fields.set(key as ReviewKey, {
        key: key as ReviewKey,
        label: FIELD_LABELS[key as FieldKey] ?? key.replace("additional:", ""),
        value: value!,
        candidates: [],
        conflict: false,
        edited: false,
      });
  for (const field of fields.values()) {
    const values = new Set(
      field.candidates.map((c) => fold(normalize(field.key, c.value))),
    );
    field.edited = edits[field.key] !== undefined;
    field.conflict = values.size > 1 && !field.edited;
    field.value = field.edited
      ? edits[field.key]!
      : field.conflict
        ? ""
        : (field.candidates[0]?.value ?? "");
    field.note = field.candidates.find((c) => c.note)?.note;
  }
  return [...fields.values()];
}
export function toPersonData(
  fields: { key: ReviewKey; value: string; label: string }[],
): ExtractedPersonData {
  const result: ExtractedPersonData = { additionalFields: [] };
  for (const field of fields) {
    if (!field.value) continue;
    if (field.key.startsWith("additional:"))
      result.additionalFields!.push({ label: field.label, value: field.value });
    else if (field.key.startsWith("address.")) {
      result.address ??= {};
      (result.address as Record<string, string>)[field.key.slice(8)] =
        field.value;
    } else (result as Record<string, unknown>)[field.key] = field.value;
  }
  return result;
}
