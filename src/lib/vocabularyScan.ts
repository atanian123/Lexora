import { createWorker, OEM, PSM, type Worker, type WorkerParams } from "tesseract.js";
import workerPath from "tesseract.js/dist/worker.min.js?url";

import type { LanguageCode, LearningSetup } from "../types";
import { slashParts, splitScannedVariants } from "./scannedVariants";
import { recognizeVocabularyCards } from "./vocabularyCards";
import { recognizeVocabularyColumns, type RecognizedPair } from "./vocabularyColumns";
import { extractBracketNotes, findBracketNotes } from "./vocabularyNotes";

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
  notes?: string;
  targetClipped?: boolean;
  translationClipped?: boolean;
}

type RecognizedVocabulary = string | {
  layout: "cards" | "columns";
  pairs: RecognizedPair[];
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
    const parameters: Partial<WorkerParams> = { preserve_interword_spaces: "1" };

    async function recognizeWithModel(image: HTMLCanvasElement, model: string, blocks = false, mode = PSM.SINGLE_BLOCK) {
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
        await worker.setParameters({ ...parameters, tessedit_pageseg_mode: mode });
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
      const isCyrillic = (model: string) => model === "bul" || model === "rus";
      const mixedColumn = isCyrillic(orderedModels[0]) === isCyrillic(orderedModels[1])
        ? undefined : isCyrillic(orderedModels[0]) ? 0 : 1;
      const columns = await recognizeVocabularyColumns(image, recognizePart, (sheet, index, mixed) => {
        const model = mixed ? `${orderedModels[index]}+${orderedModels[1 - index]}` : orderedModels[index];
        return recognizeWithModel(sheet, model, false, PSM.SINGLE_LINE);
      }, mixedColumn);
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

function joinWrappedNotes(text: string) {
  return findBracketNotes(text).reverse().reduce((joined, { start, end }) => {
    const lines = text.slice(start, end).split(/\r?\n/);
    // An OCR error can leave a bracket open until a numbered entry several lines later.
    if (lines.length !== 2 || /^\s*\d+[.)]/u.test(lines[1])) return joined;
    const note = `${lines[0].trimEnd()} ${lines[1].trimStart()}`;
    return joined.slice(0, start) + note + joined.slice(end);
  }, text);
}

type ScanLanguages = Pick<LearningSetup, "targetLanguage" | "baseLanguage">;

function scopedNotes(value: string, count: number) {
  const parts = slashParts(value);
  if (count < 2 || parts.length !== count || !parts.every((part) => /^[¿¡]?\p{L}/u.test(part))) return;
  return parts.map((part) => extractBracketNotes(part).notes);
}

export function parseScannedVocabulary(text: RecognizedVocabulary, mode: ScanMode, translationFirst: boolean, languages: ScanLanguages): ScannedWord[] {
  function buildWords(raw: ScannedWord, compactTranslations = false) {
    const first = extractBracketNotes(raw.targetText);
    const second = extractBracketNotes(raw.translations);
    const row = { ...raw, targetText: first.text, translations: second.text };
    if (compactTranslations) {
      const choices = second.text.split(/,\s+/);
      const isWord = (choice: string) => /^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u.test(choice);
      const finalChoice = choices[choices.length - 1].split(" ");
      // In a compact card list, repeated single-word choices can also precede a short phrase.
      // Leave less clearly delimited phrases with their original commas for review.
      const compactList = choices.every(isWord) || (choices.length >= 3 && choices.slice(0, -1).every(isWord) &&
        finalChoice.length <= 3 && finalChoice.every(isWord));
      if (compactList) row.translations = choices.join("; ");
    }
    const variants = splitScannedVariants(row, languages.targetLanguage, languages.baseLanguage);
    const targetNotes = scopedNotes(raw.targetText, variants.length);
    const translationsSplit = variants.some(({ translations }) => translations !== row.translations);
    const translationNotes = translationsSplit ? scopedNotes(raw.translations, variants.length) : undefined;
    return variants.map((variant, index) => {
      const notes = [...new Set([...(targetNotes?.[index] ?? first.notes), ...(translationNotes?.[index] ?? second.notes)].map(({ text }) => text))];
      return notes.length ? { ...variant, notes: notes.join("; ") } : variant;
    });
  }

  if (typeof text !== "string") {
    return text.pairs.flatMap(({ first, second, firstClipped, secondClipped }) => {
      if (mode === "targetOnly") return buildWords({ targetText: first, translations: "" });
      const row: ScannedWord = translationFirst ? { targetText: second, translations: first } : { targetText: first, translations: second };
      if (translationFirst ? secondClipped : firstClipped) row.targetClipped = true;
      if (translationFirst ? firstClipped : secondClipped) row.translationClipped = true;
      return buildWords(row, text.layout === "cards");
    });
  }

  // OCR can introduce a line break inside a note, even when there is no bilingual layout to follow.
  const logicalText = mode === "targetOnly" ? joinWrappedNotes(text) : text;
  return logicalText.split(/\r?\n/).flatMap((rawLine) => {
    const line = rawLine.trim().replace(/^(?:[•●◦▪*-]|\d+[.)])\s+/, "");
    if (!/\p{L}/u.test(line)) return [];

    // Punctuation inside a workbook note does not separate the word from its translation.
    const searchLine = findBracketNotes(line).reduce((masked, { start, end }) =>
      masked.slice(0, start) + "_".repeat(end - start) + masked.slice(end), line);
    if (mode === "targetOnly") {
      let start = 0;
      const terms = [...searchLine.matchAll(/\t+| {3,}/g)].map((match) => {
        const term = line.slice(start, match.index);
        start = match.index + match[0].length;
        return term;
      });
      terms.push(line.slice(start));
      return terms.filter((term) => /\p{L}/u.test(term)).flatMap((term) => buildWords({ targetText: term.trim(), translations: "" }));
    }

    const separator = /\s*[:：=|—–]\s*|\s+-\s+/.exec(searchLine) ?? /\t+| {3,}/.exec(searchLine) ?? /;/.exec(searchLine);
    if (!separator) return buildWords({ targetText: line, translations: "" });

    const left = line.slice(0, separator.index).trim();
    const right = line.slice(separator.index + separator[0].length).trim();
    return buildWords(translationFirst ? { targetText: right, translations: left } : { targetText: left, translations: right });
  });
}
