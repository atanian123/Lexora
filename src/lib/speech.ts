import type { LanguageCode } from "../types";

const speechLocales: Record<LanguageCode, string> = {
  en: "en-GB",
  de: "de-DE",
  bg: "bg-BG",
  fr: "fr-FR",
  it: "it-IT",
  es: "es-ES",
  pt: "pt-PT",
  ru: "ru-RU"
};

export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** Reads text aloud with the device's built-in voice for the language, when one is installed. */
export function speak(text: string, language: LanguageCode): void {
  if (!canSpeak() || !text.trim()) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = speechLocales[language];
  const voice = window.speechSynthesis.getVoices().find((candidate) => candidate.lang.toLowerCase().startsWith(language));
  if (voice) utterance.voice = voice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}
