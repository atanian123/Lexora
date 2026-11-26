import type { LanguageCode, TranslationResult, TranslationUsage } from "../types";
import { myMemoryDailyLimit } from "./constants";
import { db } from "./db";
import { localDateKey, nowIso } from "./ids";
import { normalizeSegment } from "./vocabulary";

interface TranslationOptions {
  signal?: AbortSignal;
  forAutoFill?: boolean;
}

interface MyMemoryMatch {
  "created-by"?: unknown;
  segment?: unknown;
  translation?: unknown;
  target?: unknown;
  match?: unknown;
  quality?: unknown;
}

interface MyMemoryResponse {
  responseStatus?: unknown;
  responseData?: { translatedText?: unknown; match?: unknown };
  matches?: unknown;
}

const exampleLabels: Record<LanguageCode, string> = {
  en: "Example",
  de: "Beispiel",
  bg: "Пример",
  fr: "Exemple",
  it: "Esempio",
  es: "Ejemplo",
  pt: "Exemplo",
  ru: "Пример"
};

const myMemoryMaxQueryBytes = 500;

export interface TranslationProvider {
  name: string;
  translate(text: string, from: LanguageCode, to: LanguageCode, options?: TranslationOptions): Promise<TranslationResult[]>;
  isAvailable(): boolean;
}

export class MyMemoryProvider implements TranslationProvider {
  name = "mymemory";

  isAvailable(): boolean {
    return typeof navigator === "undefined" || navigator.onLine;
  }

  async translate(text: string, from: LanguageCode, to: LanguageCode, { signal, forAutoFill = false }: TranslationOptions = {}): Promise<TranslationResult[]> {
    const example = `${exampleLabels[from]}: ${text}`;
    const query = forAutoFill && new TextEncoder().encode(example).length <= myMemoryMaxQueryBytes ? example : text;
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", query);
    url.searchParams.set("langpair", `${from}|${to}`);

    const response = await fetch(url.toString(), { signal });
    if (!response.ok) {
      throw new Error(`Translation request failed with ${response.status}`);
    }

    const payload: MyMemoryResponse = await response.json();
    if (payload?.responseStatus && Number(payload.responseStatus) !== 200) {
      throw new Error("Translation service returned an error.");
    }
    const matches: MyMemoryMatch[] = (Array.isArray(payload?.matches) ? payload.matches : [])
      .filter((match: unknown): match is MyMemoryMatch => typeof match === "object" && match !== null);
    const primary = payload?.responseData?.translatedText;
    const primaryConfidence = clampConfidence(payload?.responseData?.match);

    if (forAutoFill) {
      const result = findScanResult(text, query, to, primary, primaryConfidence, matches);
      return result ? [{ ...result, source: this.name }] : [];
    }

    const results = new Map<string, TranslationResult>();
    if (typeof primary === "string" && primary.trim()) {
      const result = {
        text: primary.trim(),
        confidence: primaryConfidence,
        source: this.name
      };
      results.set(result.text.toLocaleLowerCase(), result);
    }

    for (const match of matches) {
      if (typeof match.translation !== "string" || !match.translation.trim()) continue;

      const textValue = match.translation.trim();
      const key = textValue.toLocaleLowerCase();
      const confidence = clampConfidence(match.match ?? match.quality);
      const existing = results.get(key);
      if (!existing || confidence > existing.confidence) {
        results.set(key, { text: textValue, confidence, source: this.name });
      }
    }

    return [...results.values()].sort((left, right) => right.confidence - left.confidence).slice(0, 6);
  }
}

function findScanResult(
  text: string,
  query: string,
  to: LanguageCode,
  primary: unknown,
  primaryConfidence: number,
  matches: MyMemoryMatch[]
): Pick<TranslationResult, "text" | "confidence"> | undefined {
  const source = normalizeSegment(text);
  const querySource = normalizeSegment(query);
  const label = normalizeSegment(exampleLabels[to]);
  const primaryKey = typeof primary === "string" ? normalizeSegment(primary) : undefined;
  const candidates: Array<{ text: string; confidence: number; priority: number }> = [];

  function addCandidate(translation: string, segment: string, confidence: number, priority: number) {
    let value = translation.trim();
    if (segment === querySource && querySource !== source) {
      const separator = value.search(/[:：]/u);
      if (separator < 0 || normalizeSegment(value.slice(0, separator)) !== label) return;
      value = value.slice(separator + 1).trim();
    }
    const normalized = normalizeSegment(value);
    if (normalized && normalized !== source) candidates.push({ text: value, confidence, priority });
  }

  let primaryHasMatch = false;
  for (const match of matches) {
    if (typeof match.translation !== "string") continue;
    const isPrimary = normalizeSegment(match.translation) === primaryKey;
    primaryHasMatch ||= isPrimary;
    if (typeof match.segment !== "string") continue;
    const target = typeof match.target === "string" ? match.target.trim().toLowerCase().split(/[-_]/)[0] : undefined;
    if (target && target !== to) continue;
    const segment = normalizeSegment(match.segment);
    // MyMemory can include a match for the original term in the same response as the example.
    if (segment !== querySource && segment !== source) continue;
    const priority = match["created-by"] === "MT!" ? 2 : isPrimary ? 1 : 0;
    addCandidate(match.translation, segment, clampConfidence(match.match ?? match.quality), priority);
  }

  if (typeof primary === "string" && !primaryHasMatch) {
    addCandidate(primary, querySource, primaryConfidence, 1);
  }

  const best = candidates.sort((left, right) => right.priority - left.priority || right.confidence - left.confidence)[0];
  return best && { text: best.text, confidence: best.confidence };
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

export async function fetchTranslationSuggestions(
  text: string,
  from: LanguageCode,
  to: LanguageCode,
  options?: TranslationOptions
): Promise<TranslationResult[]> {
  if (!activeTranslationProvider.isAvailable()) {
    throw new Error("offline");
  }

  await db.transaction("rw", db.translationUsage, async () => {
    const usage = await getTodayTranslationUsage();
    options?.signal?.throwIfAborted();
    if (usage.count >= myMemoryDailyLimit) throw new Error("daily-limit");
    await db.translationUsage.put({ ...usage, count: usage.count + 1, updatedAt: nowIso() });
  });
  return activeTranslationProvider.translate(text, from, to, options);
}

export async function fetchScanTranslation(text: string, from: LanguageCode, to: LanguageCode, signal: AbortSignal): Promise<string> {
  const [translated] = await fetchTranslationSuggestions(text, from, to, { signal, forAutoFill: true });
  return translated?.text ?? "";
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
