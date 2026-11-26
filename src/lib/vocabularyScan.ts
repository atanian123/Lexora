import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import workerPath from "tesseract.js/dist/worker.min.js?url";

import type { LanguageCode } from "../types";
import { recognizeVocabularyCards, type RecognizedVocabularyCard } from "./vocabularyCards";

const ocrLanguages: Record<LanguageCode, string> = {
  en: "eng",
  de: "deu",
  bg: "bul",
  fr: "fra",
  it: "ita",
  es: "spa",
  pt: "por",
  ru: "rus"
};

export type ScanMode = "targetOnly" | "paired";

export interface ScannedWord {
  targetText: string;
  translations: string;
}

type RecognizedVocabulary = string | RecognizedVocabularyCard[];

export async function recognizeVocabulary(
  file: File,
  languages: LanguageCode[],
  signal: AbortSignal,
  onProgress: (progress: number) => void
): Promise<RecognizedVocabulary> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  try {
    const scale = Math.min(1, 3000 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Could not prepare the photo.");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }

  signal.throwIfAborted();
  let worker: Worker | undefined;
  let finished = false;
  let timeout: number | undefined;
  let fail: (error: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { fail = reject; });
  const abort = () => fail(signal.reason);
  signal.addEventListener("abort", abort, { once: true });

  async function recognize() {
    const engine = await createWorker([...new Set(languages.map((language) => ocrLanguages[language]))], OEM.LSTM_ONLY, {
      workerPath,
      workerBlobURL: false,
      logger: ({ status, progress }) => {
        if (!finished && status === "recognizing text") onProgress(Math.round(progress * 100));
      },
      errorHandler: (error) => fail(error)
    });
    if (finished) {
      await engine.terminate();
      return "";
    }
    worker = engine;
    // The worker may need to download and cache language models before OCR can start.
    timeout = window.setTimeout(() => fail(new Error("Text recognition timed out.")), 120_000);
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: "1" });
    const cards = await recognizeVocabularyCards(canvas, worker, languages.length > 1);
    if (cards) return cards;
    signal.throwIfAborted();
    const { data } = await worker.recognize(canvas);
    return data.text;
  }

  try {
    return await Promise.race([recognize(), interrupted]);
  } finally {
    finished = true;
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    await worker?.terminate();
    canvas.width = canvas.height = 0;
  }
}

export function parseScannedVocabulary(text: RecognizedVocabulary, mode: ScanMode, translationFirst: boolean): ScannedWord[] {
  if (typeof text !== "string") {
    return text.map(({ first, second }) => {
      if (mode === "targetOnly") return { targetText: first, translations: "" };
      const [targetText, translations] = translationFirst ? [second, first] : [first, second];
      const choices = translations.split(/,\s+/);
      // Keep phrase punctuation while treating a list of individual words as separate answers.
      const singleWords = choices.every((choice) => /^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u.test(choice));
      return { targetText, translations: singleWords ? choices.join("; ") : translations };
    });
  }

  return text.split(/\r?\n/).flatMap((rawLine) => {
    const line = rawLine.trim().replace(/^(?:[•●◦▪*-]|\d+[.)])\s+/, "");
    if (!/\p{L}/u.test(line)) return [];

    if (mode === "targetOnly") {
      return line.split(/\t+| {3,}/)
        .filter((term) => /\p{L}/u.test(term))
        .map((term) => ({ targetText: term.trim(), translations: "" }));
    }

    const separator = /\s*[:：=|—–]\s*|\s+-\s+/.exec(line) ?? /\t+| {3,}/.exec(line) ?? /;/.exec(line);
    if (!separator) return [{ targetText: line, translations: "" }];

    const left = line.slice(0, separator.index).trim();
    const right = line.slice(separator.index + separator[0].length).trim();
    return [translationFirst ? { targetText: right, translations: left } : { targetText: left, translations: right }];
  });
}
