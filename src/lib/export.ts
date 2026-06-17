import type { CardState, CustomSubset, Deck, LearningSetup, Profile, TranslationUsage, WordEntry } from "../types";

export interface LexoraBackup {
  app: "Lexora";
  schemaVersion: 1;
  exportedAt: string;
  profiles: Profile[];
  learningSetups: LearningSetup[];
  decks: Deck[];
  words: WordEntry[];
  subsets: CustomSubset[];
  cards: CardState[];
  translationUsage: TranslationUsage[];
}

export interface CsvWordImportRow {
  targetText: string;
  translations: string[];
  deckName: string;
  notes: string;
}

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

export function createBackupExport(
  profiles: Profile[],
  learningSetups: LearningSetup[],
  decks: Deck[],
  words: WordEntry[],
  subsets: CustomSubset[],
  cards: CardState[],
  translationUsage: TranslationUsage[]
): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      app: "Lexora",
      schemaVersion: 1,
      profiles,
      learningSetups,
      decks,
      words,
      subsets,
      cards,
      translationUsage
    },
    null,
    2
  );
}

export function parseLexoraBackup(contents: string): LexoraBackup {
  const parsed: unknown = JSON.parse(contents);
  if (!isRecord(parsed) || parsed.app !== "Lexora") {
    throw new Error("invalid-backup");
  }

  const legacyProfile = isRecord(parsed.profile) ? (parsed.profile as unknown as Profile) : undefined;
  const profiles = readArray<Profile>(parsed.profiles ?? (legacyProfile ? [legacyProfile] : undefined));
  const learningSetups = readArray<LearningSetup>(parsed.learningSetups);
  const decks = readArray<Deck>(parsed.decks);
  const words = readArray<WordEntry>(parsed.words);
  const subsets = readArray<CustomSubset>(parsed.subsets);
  const cards = readArray<CardState>(parsed.cards);
  const translationUsage = readArray<TranslationUsage>(parsed.translationUsage);

  if (profiles.length === 0) {
    throw new Error("invalid-backup");
  }

  return {
    app: "Lexora",
    schemaVersion: 1,
    exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : new Date().toISOString(),
    profiles,
    learningSetups,
    decks,
    words,
    subsets,
    cards,
    translationUsage
  };
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

export function parseWordCsv(contents: string): CsvWordImportRow[] {
  const rows = parseCsv(contents).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length === 0) {
    return [];
  }

  const header = rows[0].map(normalizeHeader);
  const hasHeader = header.includes("targettext") || header.includes("target") || header.includes("word");
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const targetIndex = hasHeader ? firstHeaderIndex(header, ["targettext", "target", "word", "phrase"]) : 0;
  const translationsIndex = hasHeader ? firstHeaderIndex(header, ["translations", "translation", "base", "meaning"]) : 1;
  const deckIndex = hasHeader ? firstHeaderIndex(header, ["deck", "deckname"]) : 2;
  const notesIndex = hasHeader ? firstHeaderIndex(header, ["notes", "note", "context", "example"]) : 3;

  if (targetIndex < 0 || translationsIndex < 0) {
    throw new Error("invalid-csv");
  }

  return dataRows
    .map((row) => ({
      targetText: (row[targetIndex] ?? "").trim(),
      translations: splitTranslations(row[translationsIndex] ?? ""),
      deckName: (row[deckIndex] ?? "").trim(),
      notes: (row[notesIndex] ?? "").trim()
    }))
    .filter((row) => row.targetText && row.translations.length > 0);
}

function parseCsv(contents: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    const next = contents[index + 1];

    if (quoted) {
      if (character === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }

  row.push(cell);
  rows.push(row);

  return rows;
}

function splitTranslations(value: string): string[] {
  return value
    .split(/[;|]/)
    .map((translation) => translation.trim())
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z]/g, "");
}

function firstHeaderIndex(header: string[], names: string[]): number {
  return header.findIndex((value) => names.includes(value));
}
