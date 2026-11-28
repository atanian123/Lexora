import type { LanguageCode } from "../types";
import type { ScannedWord } from "./vocabularyScan";

const spanishArticles = { el: "la", la: "el", los: "las", las: "los" } as const;
const spanishEndings = { a: "o", as: "os", o: "a", os: "as" } as const;
const spanishArticleEndings = { el: "o", la: "a", los: "os", las: "as" } as const;
type SpanishArticle = keyof typeof spanishArticles;
type SpanishEnding = keyof typeof spanishEndings;

function slashParts(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(" || character === "[") depth += 1;
    if (character === ")" || character === "]") depth -= 1;
    if (depth < 0) return [text];
    if (character === "/" && !depth) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  return depth || !parts.length ? [text] : [...parts, text.slice(start).trim()];
}

function caseLike(text: string, source: string): string {
  if (source === source.toUpperCase()) return text.toUpperCase();
  return /^\p{Lu}/u.test(source) ? text[0].toUpperCase() + text.slice(1) : text;
}

function spanishNounVariant(word: string, ending: SpanishEnding): string | undefined {
  const lower = word.toLowerCase();
  const suffix = word === word.toUpperCase() ? ending.toUpperCase() : ending;
  const replaced = spanishEndings[ending];
  if (lower.endsWith(replaced)) return word.slice(0, -replaced.length) + suffix;
  if (ending === "a" && /[lr]$/.test(lower)) return word + suffix;
  if (ending === "as" && /[lr]es$/.test(lower)) return word.slice(0, -2) + suffix;
}

function spanishVariants(parts: string[]): string[] | undefined {
  const ending = /^-\s*(a|as|o|os)$/i.exec(parts[parts.length - 1])?.[1].toLowerCase() as SpanishEnding | undefined;
  const terms = ending ? parts.slice(0, -1) : parts;
  if (terms.length === 2) {
    const [first, second] = terms;
    const article = first.toLowerCase() as SpanishArticle;
    const phrase = /^(el|la|los|las)\s+([\p{L}\p{M}]+)$/iu.exec(second);
    if (!phrase) return;
    const secondArticle = phrase[1].toLowerCase() as SpanishArticle;
    if (spanishArticles[article] !== secondArticle || (ending && spanishArticleEndings[secondArticle] !== ending)) return;

    const alternative = ending ? spanishNounVariant(phrase[2], ending) : phrase[2];
    if (alternative) return [`${first} ${phrase[2]}`, `${phrase[1]} ${alternative}`];
  } else if (ending && terms.length === 1) {
    const phrase = /^(?:(el|la|los|las)\s+)?([\p{L}\p{M}]+)$/iu.exec(terms[0]);
    if (!phrase) return;
    const article = phrase[1];
    const opposite = article && spanishArticles[article.toLowerCase() as SpanishArticle];
    if (opposite && spanishArticleEndings[opposite] !== ending) return;
    const alternative = spanishNounVariant(phrase[2], ending);
    if (!alternative) return;
    return [terms[0], opposite ? `${caseLike(opposite, article)} ${alternative}` : alternative];
  }
}

function variants(text: string, language: LanguageCode): string[] {
  if (!text.includes("/")) return [text];
  const parts = slashParts(text);
  if (parts.length < 2) return [text];
  const shorthand = language === "es" && spanishVariants(parts);
  if (shorthand) return shorthand;

  // Require full words or phrases. A suffix, URL or unit such as km/h needs review as written.
  const wholeForm = /^[¿¡]?[\p{L}\p{M}][\p{L}\p{M} .’'-]*(?:\s+\([^()]+\))?[.!?]?$/u;
  const separated = /\s\/|\/\s/.test(text);
  return parts.every((part) => wholeForm.test(part) && (separated || (part.match(/\p{L}/gu)?.length ?? 0) > 1)) ? parts : [text];
}

export function splitScannedVariants(row: ScannedWord, target: LanguageCode, base: LanguageCode): ScannedWord[] {
  const words = variants(row.targetText, target);
  if (words.length === 1) return [row];

  const translations = variants(row.translations, base);
  return words.map((targetText, index) => ({
    targetText,
    translations: translations.length === words.length ? translations[index] : row.translations
  }));
}
