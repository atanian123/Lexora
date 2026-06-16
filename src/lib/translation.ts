import type { LanguageCode, TranslationResult, TranslationUsage } from "../types";
import { myMemoryDailyLimit } from "./constants";
import { db } from "./db";
import { localDateKey, nowIso } from "./ids";

export interface TranslationProvider {
  name: string;
  translate(text: string, from: LanguageCode, to: LanguageCode): Promise<TranslationResult[]>;
  isAvailable(): boolean;
}

export class MyMemoryProvider implements TranslationProvider {
  name = "mymemory";

  isAvailable(): boolean {
    return typeof navigator === "undefined" || navigator.onLine;
  }

  async translate(text: string, from: LanguageCode, to: LanguageCode): Promise<TranslationResult[]> {
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", text);
    url.searchParams.set("langpair", `${from}|${to}`);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Translation request failed with ${response.status}`);
    }

    const payload = await response.json();
    const results = new Map<string, TranslationResult>();

    const primary = payload?.responseData?.translatedText;
    if (typeof primary === "string" && primary.trim()) {
      results.set(primary.trim().toLocaleLowerCase(), {
        text: primary.trim(),
        confidence: clampConfidence(payload.responseData.match),
        source: this.name
      });
    }

    if (Array.isArray(payload?.matches)) {
      for (const match of payload.matches) {
        if (typeof match.translation !== "string" || !match.translation.trim()) {
          continue;
        }

        const textValue = match.translation.trim();
        const key = textValue.toLocaleLowerCase();
        const confidence = clampConfidence(match.match ?? match.quality);
        const existing = results.get(key);
        if (!existing || confidence > existing.confidence) {
          results.set(key, { text: textValue, confidence, source: this.name });
        }
      }
    }

    return [...results.values()].sort((left, right) => right.confidence - left.confidence).slice(0, 6);
  }
}

export const activeTranslationProvider = new MyMemoryProvider();

export async function getTodayTranslationUsage(): Promise<TranslationUsage> {
  const date = localDateKey();
  const id = `${activeTranslationProvider.name}-${date}`;
  const existing = await db.translationUsage.get(id);
  if (existing) {
    return existing;
  }

  return {
    id,
    provider: activeTranslationProvider.name,
    date,
    count: 0,
    updatedAt: nowIso()
  };
}

export async function canRequestTranslation(): Promise<boolean> {
  const usage = await getTodayTranslationUsage();
  return usage.count < myMemoryDailyLimit;
}

export async function incrementTranslationUsage(): Promise<TranslationUsage> {
  const usage = await getTodayTranslationUsage();
  const next: TranslationUsage = {
    ...usage,
    count: usage.count + 1,
    updatedAt: nowIso()
  };
  await db.translationUsage.put(next);
  return next;
}

export async function fetchTranslationSuggestions(
  text: string,
  from: LanguageCode,
  to: LanguageCode
): Promise<TranslationResult[]> {
  if (!activeTranslationProvider.isAvailable()) {
    throw new Error("offline");
  }

  if (!(await canRequestTranslation())) {
    throw new Error("daily-limit");
  }

  await incrementTranslationUsage();
  return activeTranslationProvider.translate(text, from, to);
}

function clampConfidence(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  if (numeric > 1) {
    return Math.max(0, Math.min(1, numeric / 100));
  }

  return Math.max(0, Math.min(1, numeric));
}
