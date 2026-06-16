export const languageCodes = ["en", "de", "fr", "it", "es", "pt", "ru"] as const;

export type LanguageCode = (typeof languageCodes)[number];

export type CardDirection = "target-base" | "base-target";

export type StudyDirection = CardDirection | "mixed";

export type ReviewRating = "again" | "hard" | "good" | "easy";

export type ReviewStatus = "all" | "due" | "new" | "learned";

export interface Profile {
  id: string;
  name: string;
  uiLanguage: LanguageCode;
  activeLearningSetupId?: string;
  baseLanguage?: LanguageCode;
  targetLanguage?: LanguageCode;
  createdAt: string;
  updatedAt: string;
}

export interface LearningSetup {
  id: string;
  profileId: string;
  name: string;
  baseLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  createdAt: string;
  updatedAt: string;
}

export interface Deck {
  id: string;
  profileId: string;
  learningSetupId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WordEntry {
  id: string;
  profileId: string;
  learningSetupId: string;
  deckId: string;
  baseLanguage?: LanguageCode;
  targetLanguage?: LanguageCode;
  targetText: string;
  translations: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomSubset {
  id: string;
  profileId: string;
  learningSetupId: string;
  name: string;
  wordIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CardState {
  id: string;
  profileId: string;
  learningSetupId: string;
  wordId: string;
  direction: CardDirection;
  due: string;
  stability?: number;
  difficulty?: number;
  elapsedDays?: number;
  scheduledDays?: number;
  state?: number;
  reviewCount: number;
  lapseCount: number;
  lastRating?: ReviewRating;
  lastReviewedAt?: string;
  fsrsCard?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TranslationUsage {
  id: string;
  provider: string;
  date: string;
  count: number;
  updatedAt: string;
}

export interface TranslationResult {
  text: string;
  confidence: number;
  source: string;
}

export type ScopeSelection =
  | { type: "all" }
  | { type: "deck"; deckId: string }
  | { type: "subset"; subsetId: string };
