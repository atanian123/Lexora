import type { CardDirection, LanguageCode, ReviewRating } from "../types";

export const languageNames: Record<LanguageCode, string> = {
  en: "English",
  de: "German",
  fr: "French",
  it: "Italian",
  es: "Spanish",
  pt: "Portuguese",
  ru: "Russian",
  bg: "Bulgarian"
};

export const languageFlags: Record<LanguageCode, string> = {
  en: "🇬🇧",
  de: "🇩🇪",
  fr: "🇫🇷",
  it: "🇮🇹",
  es: "🇪🇸",
  pt: "🇵🇹",
  ru: "🇷🇺",
  bg: "🇧🇬"
};

export const defaultDeckNames: Record<LanguageCode, string> = {
  en: "Default",
  de: "Standard",
  fr: "Défaut",
  it: "Predefinito",
  es: "Predeterminado",
  pt: "Predefinido",
  ru: "По умолчанию",
  bg: "Основен"
};

export const defaultBaseLanguage: LanguageCode = "en";
export const defaultTargetLanguage: LanguageCode = "de";

export const cardDirections: CardDirection[] = ["target-base", "base-target"];

export const ratings: ReviewRating[] = ["again", "hard", "good", "easy"];

export const myMemoryDailyLimit = 500;

export const activeProfileStorageKey = "lexora.activeProfileId";
