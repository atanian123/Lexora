export function splitTranslations(value: string): string[] {
  return value
    .split(";")
    .map((translation) => translation.trim())
    .filter(Boolean);
}

export function normalizeDuplicateText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function normalizeSegment(value: string): string {
  return normalizeDuplicateText(value.normalize("NFKC").replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, ""));
}
