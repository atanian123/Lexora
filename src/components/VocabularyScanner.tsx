import { liveQuery } from "dexie";
import { ArrowRight, Camera, ImagePlus, Plus, X } from "lucide-react";
import { type ChangeEvent, type SubmitEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cardDirections, localizedLanguageName } from "../lib/constants";
import { createInitialCardState, db } from "../lib/db";
import { createId, nowIso } from "../lib/ids";
import { fetchScanTranslation } from "../lib/translation";
import { normalizeDuplicateText, splitTranslations } from "../lib/vocabulary";
import type { ScanMode, ScannedWord } from "../lib/vocabularyScan";
import type { Deck, LearningSetup, WordEntry } from "../types";
import { AppSelect } from "./AppSelect";
import { FlagIcon } from "./ui";

interface ReviewRow extends ScannedWord {
  id: string;
}

/**
 * The Scan photo panel of the Add words dialog. The dialog keeps it mounted while it is open,
 * so the photo, reviewed rows, mode and deck survive switching to the Type tab and back.
 */
export function VocabularyScanner({ setup, decks, defaultDeckId, onRefresh, onSavingChange, onImported }: {
  setup: LearningSetup;
  decks: Deck[];
  defaultDeckId: string;
  onRefresh: () => Promise<void>;
  onSavingChange?: (saving: boolean) => void;
  onImported: (count: number, duplicates: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const photoInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const scan = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<ScanMode>("targetOnly");
  const [translationFirst, setTranslationFirst] = useState(false);
  const [deckId, setDeckId] = useState(defaultDeckId);
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [photo, setPhoto] = useState<File>();
  const [preview, setPreview] = useState<string>();
  const [reading, setReading] = useState<number | null>(null);
  const [translating, setTranslating] = useState<{ current: number; total: number }>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const busy = reading !== null || translating !== undefined || saving;
  const destination = decks.some((deck) => deck.id === deckId) ? deckId : defaultDeckId;

  useEffect(() => () => scan.current?.abort(), []);

  const hasRows = rows !== null;
  useEffect(() => {
    if (!hasRows) return;
    const library = liveQuery(async () => {
      const words = await db.words.where("learningSetupId").equals(setup.id).toArray();
      return new Set(words.map((word) => normalizeDuplicateText(word.targetText)));
    }).subscribe({
      next: setSaved,
      error: () => setSaved(new Set())
    });
    return () => library.unsubscribe();
  }, [hasRows, setup.id]);

  // Rows that will be skipped: already saved, or repeating an earlier row in this list.
  const skipped = useMemo(() => {
    const result = new Set<string>();
    const seen = new Set(saved);
    for (const row of rows ?? []) {
      const key = normalizeDuplicateText(row.targetText);
      if (!key) continue;
      if (seen.has(key)) result.add(row.id);
      seen.add(key);
    }
    return result;
  }, [rows, saved]);
  const importable = (rows?.length ?? 0) - skipped.size;
  // Skipped rows are never imported, so a missing translation there doesn't block the import.
  const incomplete = rows?.some(
    (row) => !skipped.has(row.id) && (!row.targetText.trim() || splitTranslations(row.translations).length === 0)
  );

  useEffect(() => {
    onSavingChange?.(saving);
  }, [saving]);

  useEffect(() => {
    if (!photo) return;
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function readPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || scan.current || saving) return;

    const controller = new AbortController();
    scan.current = controller;
    const { signal } = controller;
    setReading(0);
    setMessage("");
    let translationStarted = false;
    try {
      const { recognizeVocabulary, parseScannedVocabulary } = await import("../lib/vocabularyScan");
      signal.throwIfAborted();
      const languages = mode === "paired" ? [setup.targetLanguage, setup.baseLanguage] : [setup.targetLanguage];
      const text = await recognizeVocabulary(file, languages, signal, setReading, translationFirst);
      const recognized = parseScannedVocabulary(text, mode, translationFirst).map((row) => ({ ...row, id: createId("scan") }));
      if (recognized.length === 0) {
        setMessage(t("scan.noText"));
        return;
      }
      setPhoto(file);
      setRows(recognized);
      setReading(null);

      if (mode === "targetOnly") {
        translationStarted = true;
        const suggestions = new Map<string, string>();
        let missing = false;
        let limitReached = false;
        for (const [index, row] of recognized.entries()) {
          signal.throwIfAborted();
          setTranslating({ current: index + 1, total: recognized.length });
          const key = normalizeDuplicateText(row.targetText);
          let translation = suggestions.get(key);
          if (translation === undefined) {
            translation = "";
            if (!limitReached) {
              try {
                const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
                translation = await fetchScanTranslation(row.targetText, setup.targetLanguage, setup.baseLanguage, requestSignal);
              } catch (error) {
                signal.throwIfAborted();
                limitReached = error instanceof Error && error.message === "daily-limit";
              }
            }
            suggestions.set(key, translation);
          }
          missing ||= !translation;
          updateRow(row.id, { translations: translation });
        }
        if (limitReached) setMessage(t("status.limitReached"));
        else if (missing) setMessage(t("scan.translationIncomplete"));
      }
    } catch {
      if (!signal.aborted) {
        setMessage(t(translationStarted ? "scan.translationIncomplete" : "scan.readFailed"));
      }
    } finally {
      scan.current = null;
      if (!signal.aborted) {
        setReading(null);
        setTranslating(undefined);
        if (translationStarted) void onRefresh();
      }
    }
  }

  function updateRow(id: string, changes: Partial<ScannedWord>) {
    setRows((current) => current?.map((row) => row.id === id ? { ...row, ...changes } : row) ?? null);
  }

  async function importRows(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rows?.length || incomplete || !destination || busy) return;

    setSaving(true);
    setMessage("");
    let result: { count: number | null; saved: Set<string> };
    try {
      result = await db.transaction("rw", db.decks, db.words, db.cards, async () => {
        const deck = await db.decks.get(destination);
        if (!deck || deck.learningSetupId !== setup.id) throw new Error("Destination deck is no longer available.");

        const existing = await db.words.where("learningSetupId").equals(setup.id).toArray();
        const saved = new Set(existing.map((word) => normalizeDuplicateText(word.targetText)));
        const seen = new Set(saved);
        const timestamp = nowIso();
        const additions: WordEntry[] = [];
        for (const row of rows) {
          const targetText = row.targetText.trim();
          const key = normalizeDuplicateText(targetText);
          if (seen.has(key)) continue;
          const translations = splitTranslations(row.translations);
          // A row can become importable after its saved duplicate is deleted elsewhere.
          if (!targetText || !translations.length) return { count: null, saved };
          seen.add(key);
          additions.push({
            id: createId("word"),
            profileId: setup.profileId,
            learningSetupId: setup.id,
            deckId: deck.id,
            deckIds: [deck.id],
            targetText,
            translations,
            notes: "",
            createdAt: timestamp,
            updatedAt: timestamp
          });
        }
        if (additions.length > 0) {
          await db.words.bulkAdd(additions);
          await db.cards.bulkAdd(additions.flatMap((word) => cardDirections.map((direction) => createInitialCardState(word, direction, timestamp))));
        }
        return { count: additions.length, saved };
      });
    } catch {
      setMessage(t("scan.saveFailed"));
      setSaving(false);
      return;
    }
    if (result.count === null) {
      setSaved(result.saved);
      setMessage(t("scan.translationIncomplete"));
      setSaving(false);
      return;
    }
    onImported(result.count, rows.length - result.count);
    await onRefresh();
  }

  return (
    <>
      <div className="grid gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <AppSelect
            label={t("scan.content")}
            value={mode}
            disabled={busy}
            options={(["targetOnly", "paired"] as const).map((value) => ({ value, label: t(`scan.${value}`) }))}
            onChange={(value) => setMode(value === "paired" ? "paired" : "targetOnly")}
            wrap
          />
          {mode === "paired" ? (
            <AppSelect
              label={t("scan.order")}
              value={translationFirst ? "translationFirst" : "targetFirst"}
              disabled={busy}
              options={(["targetFirst", "translationFirst"] as const).map((value) => ({ value, label: t(`scan.${value}`) }))}
              onChange={(value) => setTranslationFirst(value === "translationFirst")}
              wrap
            />
          ) : null}
        </div>
        <p className="app-muted text-sm">{t(mode === "paired" ? "scan.pairedHint" : "scan.targetHint")}</p>
        <input ref={photoInput} type="file" accept="image/*" hidden onChange={readPhoto} />
        <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={readPhoto} />
        <div className="flex flex-wrap gap-2">
          <button className="app-button app-button-secondary" type="button" disabled={busy} onClick={() => photoInput.current?.click()}>
            <ImagePlus size={17} /> {t("scan.choosePhoto")}
          </button>
          <button className="app-button app-button-secondary [@media(pointer:fine)]:hidden" type="button" disabled={busy} onClick={() => cameraInput.current?.click()}>
            <Camera size={17} /> {t("scan.takePhoto")}
          </button>
        </div>
        <div className="app-muted empty:hidden text-sm" role="status">
          {reading !== null ? t("scan.reading", { progress: reading }) : null}
          {translating ? t("scan.translating", translating) : null}
          {message ? <p>{message}</p> : null}
        </div>
        {preview ? (
          <details className="app-subpanel p-3">
            <summary className="app-heading cursor-pointer text-sm font-semibold">{t("scan.sourcePhoto")}</summary>
            <img className="mt-2 max-h-80 max-w-full object-contain" src={preview} alt={t("scan.sourcePhoto")} />
          </details>
        ) : null}
        {rows ? (
          <form className="scan-review" onSubmit={importRows} noValidate>
            <div className="scan-review-head">
              <h3 className="app-heading font-semibold">{t("scan.review")}</h3>
              <span className="scan-review-count">{rows.length}</span>
            </div>
            <p className="app-muted text-sm">{t("scan.reviewHint")}</p>
            <ol className="scan-list">
              {rows.map((row, index) => {
                const isSkipped = skipped.has(row.id);
                const missingTarget = !isSkipped && !row.targetText.trim();
                const missing = !isSkipped && splitTranslations(row.translations).length === 0;
                return (
                  <li key={row.id} className={`scan-row ${isSkipped ? "scan-row-skipped" : ""}`}>
                    <span className="scan-row-number" aria-hidden="true">{index + 1}</span>
                    <div className="scan-row-fields">
                      <input
                        className={`scan-row-input scan-row-target ${missingTarget ? "scan-row-input-missing" : ""}`}
                        value={row.targetText}
                        disabled={busy}
                        lang={setup.targetLanguage}
                        placeholder={localizedLanguageName(setup.targetLanguage, i18n.language)}
                        aria-label={`${localizedLanguageName(setup.targetLanguage, i18n.language)} ${index + 1}`}
                        aria-invalid={missingTarget}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(event) => updateRow(row.id, { targetText: event.target.value })}
                      />
                      <div className="scan-row-translation">
                        <ArrowRight size={14} aria-hidden="true" />
                        <input
                          className={`scan-row-input ${missing ? "scan-row-input-missing" : ""}`}
                          value={row.translations}
                          disabled={busy}
                          lang={setup.baseLanguage}
                          placeholder={t("scan.needsTranslation")}
                          aria-label={`${localizedLanguageName(setup.baseLanguage, i18n.language)} ${index + 1}`}
                          aria-invalid={missing}
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          onChange={(event) => updateRow(row.id, { translations: event.target.value })}
                        />
                      </div>
                      {isSkipped ? <span className="scan-row-note">{t("scan.alreadySaved")}</span> : null}
                    </div>
                    <button
                      className="scan-row-remove"
                      type="button"
                      disabled={busy}
                      aria-label={t("scan.removeRow", { number: index + 1 })}
                      onClick={() => setRows((current) => current?.filter((item) => item.id !== row.id) ?? null)}
                    >
                      <X size={18} />
                    </button>
                  </li>
                );
              })}
            </ol>
            <button className="text-button w-fit" type="button" disabled={busy} onClick={() => setRows((current) => [...(current ?? []), { id: createId("scan"), targetText: "", translations: "" }])}>
              <Plus size={16} /> {t("scan.addRow")}
            </button>
            <div className="scan-import-bar">
              <AppSelect
                ariaLabel={t("common.deck")}
                value={destination}
                disabled={busy}
                options={decks.map((deck) => ({ value: deck.id, label: deck.name }))}
                onChange={setDeckId}
                placement="above"
                wrap
              />
              <button className="app-button app-button-primary" type="submit" disabled={busy || importable === 0 || incomplete || !destination}>
                {t(saving ? "scan.saving" : "scan.importWords")}
                {!saving ? <span className="scan-import-count">{importable}</span> : null}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </>
  );
}
