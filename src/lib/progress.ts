import type { CardState, LanguageCode } from "../types";

export type WordStrength = 0 | 1 | 2 | 3;

const reviewState = 2;

/** 0 = never reviewed, 1 = still in learning steps, 2 = in review, 3 = reviewed with intervals of three weeks or more. */
export function wordStrength(cards: CardState[] | undefined): WordStrength {
  if (!cards?.length || cards.every((card) => card.reviewCount === 0)) return 0;
  if (cards.some((card) => card.state !== reviewState)) return 1;
  return Math.min(...cards.map((card) => card.scheduledDays ?? 0)) >= 21 ? 3 : 2;
}

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export interface ForecastDay {
  date: Date;
  count: number;
}

/** Cards due on each of the next `days` local days. The first day includes overdue cards. */
export function dueForecast(cards: CardState[], now = new Date(), days = 7): ForecastDay[] {
  const start = startOfLocalDay(now);
  const forecast = Array.from({ length: days }, (_, index) => ({ date: addDays(start, index), count: 0 }));
  // Match on the local calendar date: days around a daylight-saving change are 23 or 25 hours long,
  // so dividing elapsed milliseconds by 24 hours can put a card on the wrong day.
  const indexByDate = new Map(forecast.map((day, index) => [localDateKey(day.date), index]));
  const startTime = start.getTime();
  for (const card of cards) {
    const due = new Date(card.due);
    const index = due.getTime() < startTime ? 0 : indexByDate.get(localDateKey(due));
    if (index !== undefined) forecast[index].count += 1;
  }
  return forecast;
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function countDueBetween(cards: CardState[], from: Date, to: Date): number {
  const start = from.getTime();
  const end = to.getTime();
  return cards.filter((card) => {
    const due = new Date(card.due).getTime();
    return due >= start && due < end;
  }).length;
}

/** A short, localized "10 min" / "3 days" style label for the time until a review. */
export function formatInterval(milliseconds: number, locale: string): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  const format = (value: number, unit: "minute" | "hour" | "day" | "month" | "year") =>
    new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: unit === "minute" || unit === "hour" ? "short" : "long" }).format(value);
  if (minutes < 60) return format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format(hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 45) return format(days, "day");
  const months = Math.round(days / 30);
  if (months < 18) return format(months, "month");
  return format(Math.round(days / 365), "year");
}

export const greetings: Record<LanguageCode, string> = {
  en: "Hello!",
  de: "Hallo!",
  bg: "Здравей!",
  fr: "Bonjour !",
  it: "Ciao!",
  es: "¡Hola!",
  pt: "Olá!",
  ru: "Привет!"
};

/** Characters that are awkward to reach on a phone keyboard set to another language. */
export const accentKeys: Record<LanguageCode, string[]> = {
  en: [],
  de: ["ä", "ö", "ü", "ß", "Ä", "Ö", "Ü"],
  bg: [],
  fr: ["é", "è", "ê", "à", "ç", "ô", "û", "œ"],
  it: ["à", "è", "é", "ì", "ò", "ù"],
  es: ["á", "é", "í", "ó", "ú", "ñ", "¿", "¡"],
  pt: ["á", "â", "ã", "à", "ç", "é", "ê", "õ"],
  ru: []
};

/** Seconds a review typically takes; used only for the rough session-length estimate. */
export const secondsPerCard = 20;
