import type { CustomSubset, Deck, LearningSetup, Profile, WordEntry } from "../types";

export function downloadTextFile(filename: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function createJsonExport(
  profile: Profile,
  learningSetups: LearningSetup[],
  decks: Deck[],
  words: WordEntry[],
  subsets: CustomSubset[]
): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      app: "Lexora",
      profile,
      learningSetups,
      decks,
      words,
      subsets
    },
    null,
    2
  );
}

export function createCsvExport(words: WordEntry[], decks: Deck[]): string {
  const deckNames = new Map(decks.map((deck) => [deck.id, deck.name]));
  const rows = [
    ["targetText", "translations", "deck", "notes", "createdAt", "updatedAt"],
    ...words.map((word) => [
      word.targetText,
      word.translations.join("; "),
      deckNames.get(word.deckId) ?? "",
      word.notes,
      word.createdAt,
      word.updatedAt
    ])
  ];

  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function escapeCsvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}
