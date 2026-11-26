import { Camera, ImagePlus, Plus, Trash2 } from "lucide-react";
import { type ChangeEvent, type SubmitEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cardDirections } from "../lib/constants";
import { createInitialCardState, db } from "../lib/db";
import { createId, nowIso } from "../lib/ids";
import { fetchScanTranslation } from "../lib/translation";
import { normalizeDuplicateText, splitTranslations } from "../lib/vocabulary";
import type { ScanMode, ScannedWord } from "../lib/vocabularyScan";
import type { Deck, LearningSetup, WordEntry } from "../types";
import { AppSelect } from "./AppSelect";
import { Label } from "./ui";

interface ReviewRow extends ScannedWord {
  id: string;
}

export function VocabularyScanner({ setup, decks, defaultDeckId, onRefresh, onImported }: {
  setup: LearningSetup;
  decks: Deck[];
  defaultDeckId: string;
  onRefresh: () => Promise<void>;
  onImported: (count: number, duplicates: number) => void;
}) {
  const { t } = useTranslation();
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
  const busy = reading !== null || translating !== undefined || saving;
  const destination = decks.some((deck) => deck.id === deckId) ? deckId : defaultDeckId;
  const incomplete = rows?.some((row) => !row.targetText.trim() || splitTranslations(row.translations).length === 0);

  useEffect(() => () => scan.current?.abort(), []);

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
      const text = await recognizeVocabulary(file, languages, signal, setReading);
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
    let count: number;
    try {
      count = await db.transaction("rw", db.decks, db.words, db.cards, async () => {
        const deck = await db.decks.get(destination);
        if (!deck || deck.learningSetupId !== setup.id) throw new Error("Destination deck is no longer available.");

        const existing = await db.words.where("learningSetupId").equals(setup.id).toArray();
        const seen = new Set(existing.map((word) => normalizeDuplicateText(word.targetText)));
        const timestamp = nowIso();
        const additions: WordEntry[] = [];
        for (const row of rows) {
          const key = normalizeDuplicateText(row.targetText);
          if (seen.has(key)) continue;
          seen.add(key);
          additions.push({
            id: createId("word"),
            profileId: setup.profileId,
            learningSetupId: setup.id,
            deckId: deck.id,
            deckIds: [deck.id],
            targetText: row.targetText.trim(),
            translations: splitTranslations(row.translations),
            notes: "",
            createdAt: timestamp,
            updatedAt: timestamp
          });
        }
        if (additions.length > 0) {
          await db.words.bulkAdd(additions);
          await db.cards.bulkAdd(additions.flatMap((word) => cardDirections.map((direction) => createInitialCardState(word, direction, timestamp))));
        }
        return additions.length;
      });
    } catch {
      setMessage(t("scan.saveFailed"));
      setSaving(false);
      return;
    }
    onImported(count, rows.length - count);
    await onRefresh();
  }

  return (
    <section className="app-panel grid gap-3 p-4" aria-label={t("scan.title")}>
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
        <form className="app-subpanel grid gap-3 p-3" onSubmit={importRows}>
          <h3 className="app-heading font-semibold">{t("scan.review")}</h3>
          <p className="app-muted text-sm">{t("scan.reviewHint")}</p>
          {rows.map((row, index) => (
            <div key={row.id} className="app-divider grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 border-b pb-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <div className="col-span-2 grid gap-2 sm:col-span-1">
                <Label text={t("library.targetText")}>
                  <input className="app-input" value={row.targetText} disabled={busy} required onChange={(event) => updateRow(row.id, { targetText: event.target.value })} />
                </Label>
              </div>
              <Label text={t("common.translations")}>
                <input className="app-input" value={row.translations} disabled={busy} required onChange={(event) => updateRow(row.id, { translations: event.target.value })} />
              </Label>
              <button
                className="app-button app-button-danger app-icon-button self-end"
                type="button"
                disabled={busy}
                aria-label={t("scan.removeRow", { number: index + 1 })}
                data-tooltip={t("common.delete")}
                onClick={() => setRows((current) => current?.filter((item) => item.id !== row.id) ?? null)}
              >
                <Trash2 size={17} />
              </button>
            </div>
          ))}
          <button className="app-button app-button-secondary w-fit" type="button" disabled={busy} onClick={() => setRows((current) => [...(current ?? []), { id: createId("scan"), targetText: "", translations: "" }])}>
            <Plus size={17} /> {t("scan.addRow")}
          </button>
          <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,20rem)_auto] sm:justify-between">
            <AppSelect
              label={t("common.deck")}
              value={destination}
              disabled={busy}
              options={decks.map((deck) => ({ value: deck.id, label: deck.name }))}
              onChange={setDeckId}
              placement="above"
              wrap
            />
            <button className="app-button app-button-primary justify-self-end" type="submit" disabled={busy || !rows.length || incomplete || !destination}>
              {t(saving ? "scan.saving" : "scan.importWords")}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
