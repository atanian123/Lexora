import type { ScannedWord } from "./vocabularyScan";
import { extractBracketNotes } from "./vocabularyNotes";

export function splitTranslations(value: string): string[] {
  return value
    .split(";")
    .map((translation) => translation.trim())
    .filter(Boolean);
}

export function scanEntryContent({ targetText, translations, notes }: ScannedWord) {
  const lineBreaks = /[^\S\n]*\n\s*/g;
  return {
    targetText: targetText.replace(lineBreaks, " ").trim(),
    translations: splitTranslations(translations.replace(lineBreaks, " ")),
    notes: notes?.trim() ?? ""
  };
}

export function normalizeDuplicateText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

interface VocabularyIdentitySource {
  targetText: string;
  translations?: string | readonly string[];
  notes?: string;
}

export interface VocabularyIdentity {
  term: string;
  notes: string;
}

export function vocabularyIdentity({ targetText, translations, notes }: VocabularyIdentitySource): VocabularyIdentity {
  const explicitNotes = normalizeDuplicateText(notes ?? "");
  if (explicitNotes) return { term: normalizeDuplicateText(targetText), notes: explicitNotes };
  // Older scans left trailing annotations in the terms or translations instead of the Notes field.
  const target = extractBracketNotes(targetText);
  const translationText = typeof translations === "string" ? translations : translations?.join("; ") ?? "";
  const translation = extractBracketNotes(translationText);
  const inlineNotes = new Set([...target.notes, ...translation.notes].map(({ text }) => normalizeDuplicateText(text)));
  return { term: normalizeDuplicateText(target.text), notes: [...inlineNotes].join("; ") };
}

export function vocabularyIdentitiesMatch(first: VocabularyIdentity, second: VocabularyIdentity): boolean {
  return first.term !== "" && first.term === second.term && (!first.notes || !second.notes || first.notes === second.notes);
}

export function findDuplicateVocabularyRows(rows: readonly VocabularyIdentitySource[], saved: readonly VocabularyIdentity[]): Set<number> {
  const seenByTerm = new Map<string, VocabularyIdentity[]>();
  function remember(identity: VocabularyIdentity) {
    const seen = seenByTerm.get(identity.term);
    if (seen) seen.push(identity);
    else seenByTerm.set(identity.term, [identity]);
  }
  for (const identity of saved) remember(identity);

  const duplicates = new Set<number>();
  for (const [index, row] of rows.entries()) {
    const identity = vocabularyIdentity(row);
    if (!identity.term) continue;
    const seen = seenByTerm.get(identity.term);
    if (seen?.some((entry) => vocabularyIdentitiesMatch(identity, entry))) duplicates.add(index);
    else remember(identity);
  }
  return duplicates;
}

export function normalizeSegment(value: string): string {
  return normalizeDuplicateText(value.normalize("NFKC").replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, ""));
}
