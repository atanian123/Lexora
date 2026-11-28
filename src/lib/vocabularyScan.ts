import { createWorker, OEM, PSM, type Worker, type WorkerParams } from "tesseract.js";
import workerPath from "tesseract.js/dist/worker.min.js?url";

import type { LanguageCode } from "../types";
import { recognizeVocabularyCards } from "./vocabularyCards";
import { recognizeVocabularyColumns } from "./vocabularyColumns";

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

type RecognizedVocabulary = string | {
  layout: "cards" | "columns";
  pairs: Array<{ first: string; second: string }>;
};

export async function recognizeVocabulary(
  file: File,
  languages: LanguageCode[],
  signal: AbortSignal,
  onProgress: (progress: number) => void,
  translationFirst = false
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

  async function recognize(): Promise<RecognizedVocabulary> {
    const models = languages.map((language) => ocrLanguages[language]);
    const combinedModel = [...new Set(models)].join("+");
    const orderedModels = translationFirst ? [...models].reverse() : models;
    let activeModel: string | undefined;
    let pass = 0;
    let totalPasses = 1;
    let reportedProgress = 0;
    const parameters: Partial<WorkerParams> = { tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: "1" };

    async function recognizeWithModel(image: HTMLCanvasElement, model: string, blocks = false) {
      signal.throwIfAborted();
      timeout = window.setTimeout(() => fail(new Error("Text recognition timed out.")), 120_000);
      try {
        if (!worker) {
          const engine = await createWorker(model, OEM.LSTM_ONLY, {
            workerPath,
            workerBlobURL: false,
            logger: ({ status, progress }) => {
              if (finished || status !== "recognizing text") return;
              const percent = Math.min(99, Math.round((pass + progress) * 100 / totalPasses));
              if (percent > reportedProgress) {
                reportedProgress = percent;
                onProgress(percent);
              }
            },
            errorHandler: (error) => fail(error)
          });
          if (finished) {
            await engine.terminate();
            throw signal.reason ?? new Error("Text recognition stopped.");
          }
          worker = engine;
        } else if (model !== activeModel) {
          await worker.reinitialize(model);
        }
        activeModel = model;
        signal.throwIfAborted();
        await worker.setParameters(parameters);
        const { data } = await worker.recognize(image, {}, { text: !blocks, blocks });
        return data;
      } finally {
        window.clearTimeout(timeout);
      }
    }

    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not read the photo.");
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const paired = orderedModels.length > 1;
    const recognizePart = (sheet: HTMLCanvasElement, index: 0 | 1) => {
      pass = index;
      totalPasses = paired ? 2 : 1;
      return recognizeWithModel(sheet, orderedModels[index], true);
    };
    const cards = await recognizeVocabularyCards(image, paired, recognizePart);
    if (cards) return { layout: "cards", pairs: cards };
    if (paired) {
      const columns = await recognizeVocabularyColumns(image, recognizePart);
      if (columns) return { layout: "columns", pairs: columns };
    }
    pass = 0;
    totalPasses = 1;
    const data = await recognizeWithModel(canvas, combinedModel);
    return data.text;
  }

  try {
    const result = await Promise.race([recognize(), interrupted]);
    onProgress(100);
    return result;
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
    return text.pairs.map(({ first, second }) => {
      if (mode === "targetOnly") return { targetText: first, translations: "" };
      const [targetText, translations] = translationFirst ? [second, first] : [first, second];
      if (text.layout === "columns") return { targetText, translations };
      const choices = translations.split(/,\s+/);
      const isWord = (choice: string) => /^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u.test(choice);
      const finalChoice = choices[choices.length - 1].split(" ");
      // In a compact card list, repeated single-word choices can also precede a short phrase.
      // Leave less clearly delimited phrases with their original commas for review.
      const compactList = choices.every(isWord) || (choices.length >= 3 && choices.slice(0, -1).every(isWord) &&
        finalChoice.length <= 3 && finalChoice.every(isWord));
      return { targetText, translations: compactList ? choices.join("; ") : translations };
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
