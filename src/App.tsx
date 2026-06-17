import {
  BookOpen,
  Check,
  ChevronRight,
  Download,
  Edit2,
  Layers,
  Menu,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Trash2,
  UserRound,
  Volume2,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type CardDirection,
  type CardState,
  type CustomSubset,
  type Deck,
  type LanguageCode,
  languageCodes,
  type LearningSetup,
  type Profile,
  type ReviewRating,
  type ReviewStatus,
  type ScopeSelection,
  type StudyDirection,
  type TranslationResult,
  type TranslationUsage,
  type WordEntry
} from "./types";
import {
  activeProfileStorageKey,
  cardDirections,
  languageNames,
  myMemoryDailyLimit,
  ratings
} from "./lib/constants";
import {
  createLearningSetup,
  createProfile,
  db,
  deleteDeckWithWords,
  deleteLearningSetup,
  ensureCardsForWords,
  ensureDefaultDeck,
  resetAllLocalData
} from "./lib/db";
import { createCsvExport, createJsonExport, downloadTextFile } from "./lib/export";
import { createId, nowIso } from "./lib/ids";
import { evaluateAnswer, type MatchResult } from "./lib/matching";
import { scheduleReview } from "./lib/srs";
import { fetchTranslationSuggestions, getTodayTranslationUsage } from "./lib/translation";

type ViewKey = "study" | "library" | "decks" | "settings";

interface WordFormState {
  id?: string;
  targetText: string;
  translations: string;
  notes: string;
  deckId: string;
}

interface StudyCard {
  card: CardState;
  word: WordEntry;
}

interface SessionState {
  queue: StudyCard[];
  current?: StudyCard;
  reviewed: number;
  correct: number;
  streak: number;
  bestStreak: number;
  answer: string;
  revealed: boolean;
  match?: MatchResult;
  closeAccepted: boolean;
  paused: boolean;
}

const emptyWordForm: WordFormState = {
  targetText: "",
  translations: "",
  notes: "",
  deckId: ""
};

export default function App() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<ViewKey>("study");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() =>
    localStorage.getItem(activeProfileStorageKey)
  );
  const [learningSetups, setLearningSetups] = useState<LearningSetup[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [words, setWords] = useState<WordEntry[]>([]);
  const [subsets, setSubsets] = useState<CustomSubset[]>([]);
  const [cards, setCards] = useState<CardState[]>([]);
  const [usage, setUsage] = useState<TranslationUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;
  const activeSetup =
    learningSetups.find((setup) => setup.id === activeProfile?.activeLearningSetupId) ?? learningSetups[0] ?? null;

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    const updateOnlineState = () => setIsOnline(navigator.onLine);

    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);

    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  useEffect(() => {
    if (activeProfile) {
      void i18n.changeLanguage(activeProfile.uiLanguage);
    }
  }, [activeProfile, i18n]);

  async function refreshAll(nextActiveId = activeProfileId) {
    setLoading(true);
    const loadedProfiles = await db.profiles.orderBy("updatedAt").reverse().toArray();
    let selectedId = nextActiveId;

    if (selectedId && !loadedProfiles.some((profile) => profile.id === selectedId)) {
      selectedId = loadedProfiles[0]?.id ?? null;
    }

    if (!selectedId && loadedProfiles.length > 0) {
      selectedId = loadedProfiles[0].id;
    }

    let selectedSetupId: string | undefined;
    if (selectedId) {
      localStorage.setItem(activeProfileStorageKey, selectedId);
      const selectedProfile = loadedProfiles.find((profile) => profile.id === selectedId);
      const profileSetups = await db.learningSetups.where("profileId").equals(selectedId).sortBy("updatedAt");
      selectedSetupId = selectedProfile?.activeLearningSetupId;
      if (profileSetups.length > 0 && (!selectedSetupId || !profileSetups.some((setup) => setup.id === selectedSetupId))) {
        selectedSetupId = profileSetups[profileSetups.length - 1].id;
        await db.profiles.update(selectedId, { activeLearningSetupId: selectedSetupId, updatedAt: nowIso() });
        if (selectedProfile) {
          selectedProfile.activeLearningSetupId = selectedSetupId;
        }
      }
      const selectedSetup = profileSetups.find((setup) => setup.id === selectedSetupId);
      if (selectedSetup) {
        await ensureDefaultDeck(selectedId, selectedSetup.id, selectedSetup.baseLanguage);
      }
    } else {
      localStorage.removeItem(activeProfileStorageKey);
    }

    const [loadedSetups, loadedDecks, loadedWords, loadedSubsets, loadedCards, loadedUsage] = await Promise.all([
      selectedId ? db.learningSetups.where("profileId").equals(selectedId).sortBy("name") : Promise.resolve([]),
      selectedSetupId ? db.decks.where("learningSetupId").equals(selectedSetupId).sortBy("name") : Promise.resolve([]),
      selectedSetupId ? db.words.where("learningSetupId").equals(selectedSetupId).toArray() : Promise.resolve([]),
      selectedSetupId ? db.subsets.where("learningSetupId").equals(selectedSetupId).sortBy("name") : Promise.resolve([]),
      selectedSetupId ? db.cards.where("learningSetupId").equals(selectedSetupId).toArray() : Promise.resolve([]),
      getTodayTranslationUsage()
    ]);

    setProfiles(loadedProfiles);
    setActiveProfileId(selectedId);
    setLearningSetups(loadedSetups);
    setDecks(loadedDecks);
    setWords(loadedWords.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    setSubsets(loadedSubsets);
    setCards(loadedCards);
    setUsage(loadedUsage);
    setLoading(false);
  }

  async function handleProfileCreated(profile: Profile) {
    setActiveProfileId(profile.id);
    await refreshAll(profile.id);
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="app-chip">Lexora</div>
      </main>
    );
  }

  if (!activeProfile) {
    return <FirstRun onCreated={handleProfileCreated} />;
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-slate-50 text-ink">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-11 w-11" />
            <div>
              <h1 className="text-2xl font-bold tracking-normal">Lexora</h1>
              <p className="text-sm text-slate-600">{t("app.tagline")}</p>
            </div>
          </div>

          <div className="hidden w-full gap-3 sm:grid lg:w-auto lg:grid-cols-[minmax(18rem,22rem)_13rem] lg:items-end">
            <div className="grid gap-2">
              <HeaderSelect label={t("profile.label")}>
                <select
                  className="app-input"
                  value={activeProfile.id}
                  aria-label={t("profile.switch")}
                  title={t("profile.switch")}
                  onChange={(event) => {
                    setActiveProfileId(event.target.value);
                    void refreshAll(event.target.value);
                  }}
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </HeaderSelect>
              <LearningSetupSelect
                label={t("setup.label")}
                value={activeSetup?.id ?? ""}
                setups={learningSetups}
                locale={activeProfile.uiLanguage}
                onChange={async (setupId) => {
                  await db.profiles.update(activeProfile.id, { activeLearningSetupId: setupId, updatedAt: nowIso() });
                  await refreshAll(activeProfile.id);
                }}
              />
            </div>
            <div className="grid gap-2">
              <UsageBadge usage={usage} />
              <ConnectionBadge online={isOnline} />
            </div>
          </div>
        </div>
      </header>

      <nav className="border-b border-slate-200 bg-white" aria-label="Primary">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex min-h-14 items-center justify-between sm:hidden">
            <div className="min-w-0">
              <span className="block text-sm font-bold text-slate-700">{currentNavLabel(view, t)}</span>
              {activeSetup ? (
                <span className="mt-1 flex items-center gap-1 text-xs font-semibold text-slate-500">
                  <FlagIcon code={activeSetup.targetLanguage} />
                  <span className="truncate">{languageOptionLabel(activeSetup.targetLanguage, activeProfile.uiLanguage)}</span>
                  <span className="text-slate-400">·</span>
                  <span className="truncate">{t("setup.baseShort")}:</span>
                  <FlagIcon code={activeSetup.baseLanguage} />
                  <span className="truncate">{languageOptionLabel(activeSetup.baseLanguage, activeProfile.uiLanguage)}</span>
                </span>
              ) : null}
            </div>
            <button
              className="app-button app-button-secondary h-10 w-10 p-0"
              type="button"
              aria-expanded={mobileMenuOpen}
              aria-label={mobileMenuOpen ? t("nav.closeMenu") : t("nav.openMenu")}
              onClick={() => setMobileMenuOpen((open) => !open)}
            >
              {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
          <div className={`${mobileMenuOpen ? "grid" : "hidden"} min-w-0 max-w-full gap-3 overflow-x-clip pb-3 sm:flex sm:gap-1 sm:overflow-visible sm:pb-0`}>
            <div className="grid w-full min-w-0 max-w-full gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:hidden">
              <HeaderSelect label={t("profile.label")}>
                <select
                  className="app-input"
                  value={activeProfile.id}
                  aria-label={t("profile.switch")}
                  title={t("profile.switch")}
                  onChange={(event) => {
                    setActiveProfileId(event.target.value);
                    void refreshAll(event.target.value);
                    setMobileMenuOpen(false);
                  }}
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </HeaderSelect>
              <LearningSetupSelect
                label={t("setup.label")}
                value={activeSetup?.id ?? ""}
                setups={learningSetups}
                locale={activeProfile.uiLanguage}
                onChange={async (setupId) => {
                  await db.profiles.update(activeProfile.id, { activeLearningSetupId: setupId, updatedAt: nowIso() });
                  await refreshAll(activeProfile.id);
                  setMobileMenuOpen(false);
                }}
              />
              <UsageBadge usage={usage} />
              <ConnectionBadge online={isOnline} />
            </div>
            <NavButton
              icon={<BookOpen size={18} />}
              label={t("nav.study")}
              active={view === "study"}
              onClick={() => {
                setView("study");
                setMobileMenuOpen(false);
              }}
            />
            <NavButton
              icon={<Search size={18} />}
              label={t("nav.library")}
              active={view === "library"}
              onClick={() => {
                setView("library");
                setMobileMenuOpen(false);
              }}
            />
            <NavButton
              icon={<Layers size={18} />}
              label={t("nav.decks")}
              active={view === "decks"}
              onClick={() => {
                setView("decks");
                setMobileMenuOpen(false);
              }}
            />
            <NavButton
              icon={<Settings size={18} />}
              label={t("nav.settings")}
              active={view === "settings"}
              onClick={() => {
                setView("settings");
                setMobileMenuOpen(false);
              }}
            />
          </div>
        </div>
      </nav>

      {status ? (
        <div className="border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-center text-sm font-semibold text-indigo-900">
          {status}
        </div>
      ) : null}

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {!activeSetup && view !== "settings" ? (
          <SetupRequired profile={activeProfile} onCreated={() => refreshAll(activeProfile.id)} />
        ) : null}
        {view === "study" && activeSetup ? (
          <StudyView
            profile={activeProfile}
            setup={activeSetup}
            decks={decks}
            words={words}
            subsets={subsets}
            cards={cards}
            onRefresh={refreshAll}
          />
        ) : null}
        {view === "library" && activeSetup ? (
          <LibraryView
            profile={activeProfile}
            setup={activeSetup}
            decks={decks}
            words={words}
            cards={cards}
            usage={usage}
            onRefresh={refreshAll}
            onStatus={setStatus}
          />
        ) : null}
        {view === "decks" && activeSetup ? (
          <DecksView
            profile={activeProfile}
            setup={activeSetup}
            decks={decks}
            words={words}
            subsets={subsets}
            onRefresh={refreshAll}
            onStatus={setStatus}
          />
        ) : null}
        {view === "settings" ? (
          <SettingsView
            profile={activeProfile}
            profiles={profiles}
            learningSetups={learningSetups}
            activeSetup={activeSetup}
            decks={decks}
            words={words}
            subsets={subsets}
            usage={usage}
            onRefresh={refreshAll}
            onStatus={setStatus}
          />
        ) : null}
      </main>
    </div>
  );
}

function FirstRun({ onCreated }: { onCreated: (profile: Profile) => void }) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState("");
  const [uiLanguage, setUiLanguage] = useState<LanguageCode>("en");

  useEffect(() => {
    void i18n.changeLanguage(uiLanguage);
  }, [uiLanguage, i18n]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }

    const profile = await createProfile(name, uiLanguage);
    onCreated(profile);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <form className="w-full max-w-xl rounded-lg border border-slate-200 bg-white p-6 shadow-soft" onSubmit={handleSubmit}>
        <div className="mb-6 flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-12 w-12" />
          <div>
            <h1 className="text-2xl font-bold">{t("profile.firstRunTitle")}</h1>
            <p className="text-sm text-slate-600">{t("profile.firstRunBody")}</p>
          </div>
        </div>

        <div className="grid gap-4">
          <Label text={t("profile.name")}>
            <input className="app-input" value={name} onChange={(event) => setName(event.target.value)} autoFocus required />
          </Label>
          <LanguageSelect label={t("profile.uiLanguage")} value={uiLanguage} onChange={setUiLanguage} />
          <button className="app-button app-button-primary" type="submit">
            <UserRound size={18} />
            {t("common.create")}
          </button>
        </div>
      </form>
    </main>
  );
}

function SetupRequired({ profile, onCreated }: { profile: Profile; onCreated: () => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState("");
  const [baseLanguage, setBaseLanguage] = useState<LanguageCode>("de");
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>("es");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await createLearningSetup(
      profile.id,
      name || setupNamePlaceholder(baseLanguage, targetLanguage, i18n.language, t),
      baseLanguage,
      targetLanguage
    );
    await onCreated();
  }

  return (
    <section className="flex items-center justify-center py-10">
      <form className="w-full max-w-xl rounded-lg border border-slate-200 bg-white p-6 shadow-soft" onSubmit={handleSubmit}>
        <div className="mb-6">
          <h1 className="text-2xl font-bold">{t("setup.firstRunTitle")}</h1>
          <p className="text-sm text-slate-600">{t("setup.firstRunBody")}</p>
        </div>
        <div className="grid gap-4">
          <Label text={t("setup.name")}>
            <input
              className="app-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={setupNamePlaceholder(baseLanguage, targetLanguage, i18n.language, t)}
            />
          </Label>
          <div className="grid gap-4 sm:grid-cols-2">
            <LanguageSelect
              label={t("setup.baseLanguage")}
              value={baseLanguage}
              exclude={[targetLanguage]}
              onChange={(value) => {
                setBaseLanguage(value);
                if (targetLanguage === value) {
                  setTargetLanguage(firstAvailableLanguage(value));
                }
              }}
            />
            <LanguageSelect
              label={t("setup.targetLanguage")}
              value={targetLanguage}
              exclude={[baseLanguage]}
              onChange={(value) => {
                setTargetLanguage(value);
                if (baseLanguage === value) {
                  setBaseLanguage(firstAvailableLanguage(value));
                }
              }}
            />
          </div>
          <button className="app-button app-button-primary" type="submit">
            <Plus size={18} />
            {t("common.create")}
          </button>
        </div>
      </form>
    </section>
  );
}

function StudyView({
  profile,
  setup,
  decks,
  words,
  subsets,
  cards,
  onRefresh
}: {
  profile: Profile;
  setup: LearningSetup;
  decks: Deck[];
  words: WordEntry[];
  subsets: CustomSubset[];
  cards: CardState[];
  onRefresh: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [scope, setScope] = useState<ScopeSelection>({ type: "all" });
  const [direction, setDirection] = useState<StudyDirection>("mixed");
  const [session, setSession] = useState<SessionState | null>(null);
  const [allowFuture, setAllowFuture] = useState(false);

  const activePairWords = useMemo(() => words.filter((word) => word.learningSetupId === setup.id), [setup.id, words]);
  const activePairWordIds = useMemo(() => new Set(activePairWords.map((word) => word.id)), [activePairWords]);
  const dueCount = useMemo(
    () => cards.filter((card) => activePairWordIds.has(card.wordId) && new Date(card.due) <= new Date()).length,
    [activePairWordIds, cards]
  );

  async function startSession(includeFuture = false) {
    await ensureCardsForWords(activePairWords);
    const latestCards = await db.cards.where("profileId").equals(profile.id).toArray();
    const scopedWords = filterWordsByScope(activePairWords, scope, subsets);
    const wordMap = new Map(scopedWords.map((word) => [word.id, word]));
    const directions = direction === "mixed" ? cardDirections : [direction];
    const now = new Date();
    const queue = shuffle(
      latestCards
        .filter((card) => wordMap.has(card.wordId))
        .filter((card) => directions.includes(card.direction))
        .filter((card) => includeFuture || new Date(card.due) <= now)
        .map((card) => ({ card, word: wordMap.get(card.wordId)! }))
    );

    setAllowFuture(false);

    if (queue.length === 0) {
      setSession({
        queue: [],
        reviewed: 0,
        correct: 0,
        streak: 0,
        bestStreak: 0,
        answer: "",
        revealed: false,
        closeAccepted: false,
        paused: false
      });
      return;
    }

    const [current, ...rest] = queue;
    setSession({
      queue: rest,
      current,
      reviewed: 0,
      correct: 0,
      streak: 0,
      bestStreak: 0,
      answer: "",
      revealed: false,
      closeAccepted: false,
      paused: false
    });
  }

  function submitAnswer() {
    if (!session?.current) {
      return;
    }

    const accepted = getAcceptedAnswers(session.current);
    const match = evaluateAnswer(session.answer, accepted);
    setSession({ ...session, revealed: true, match });
  }

  async function rateCurrent(rating: ReviewRating) {
    if (!session?.current) {
      return;
    }

    const scheduled = scheduleReview(session.current.card, rating);
    await db.cards.update(session.current.card.id, scheduled);

    const wasCorrect = session.match === "correct" || (session.match === "close" && session.closeAccepted);
    const reviewed = session.reviewed + 1;
    const correct = session.correct + (wasCorrect ? 1 : 0);
    const streak = wasCorrect ? session.streak + 1 : 0;
    const nextQueue = [...session.queue];

    if (rating === "again") {
      nextQueue.push({
        ...session.current,
        card: {
          ...session.current.card,
          ...scheduled
        }
      });
    }

    const [nextCurrent, ...rest] = nextQueue;
    setSession({
      queue: rest,
      current: nextCurrent,
      reviewed,
      correct,
      streak,
      bestStreak: Math.max(session.bestStreak, streak),
      answer: "",
      revealed: false,
      closeAccepted: false,
      paused: false
    });

    await onRefresh();
  }

  if (session?.paused) {
    return (
      <section className="grid gap-4">
        <ViewTitle title={t("study.paused")} />
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-soft">
          <p className="text-sm text-slate-600">
            {session.reviewed} {t("study.reviewed")} · {session.queue.length + (session.current ? 1 : 0)} {t("study.remaining")}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="app-button app-button-primary" onClick={() => setSession({ ...session, paused: false })}>
              {t("study.resume")}
            </button>
            <button className="app-button app-button-ghost" onClick={() => setSession(null)}>
              {t("study.abandon")}
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (session && !session.current) {
    const accuracy = session.reviewed === 0 ? 0 : Math.round((session.correct / session.reviewed) * 100);
    return (
      <section className="grid gap-4">
        <ViewTitle title={t("study.summary")} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label={t("study.reviewed")} value={session.reviewed.toString()} />
          <Metric label={t("study.accuracy")} value={`${accuracy}%`} />
          <Metric label={t("study.streak")} value={session.bestStreak.toString()} />
        </div>
        {session.reviewed === 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-950">
            <p className="font-semibold">{t("study.noCards")}</p>
            <button className="app-button app-button-secondary mt-3" onClick={() => startSession(true)}>
              <RotateCcw size={18} />
              {t("study.includeFuture")}
            </button>
          </div>
        ) : null}
        <button className="app-button app-button-primary w-fit" onClick={() => setSession(null)}>
          {t("study.start")}
        </button>
      </section>
    );
  }

  if (session?.current) {
    const prompt = getPrompt(session.current);
    const accepted = getAcceptedAnswers(session.current);
    return (
      <section className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ViewTitle title={t("study.title")} />
          <div className="flex flex-wrap gap-2">
            <button className="app-button app-button-secondary" onClick={() => setSession({ ...session, paused: true })}>
              {t("study.pause")}
            </button>
            <button className="app-button app-button-ghost" onClick={() => setSession(null)}>
              {t("study.abandon")}
            </button>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-soft">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="app-chip">{directionLabel(session.current.card.direction, t)}</span>
            <span className="app-chip">{session.reviewed} {t("study.reviewed")}</span>
          </div>
          <div className="mb-4 flex items-start justify-between gap-3">
            <p className="text-3xl font-bold">{prompt}</p>
            <button
              className="app-button app-button-secondary h-11 w-11 shrink-0 p-0"
              type="button"
              disabled
              aria-label={t("study.audioPlaceholder")}
              title={t("study.audioPlaceholder")}
            >
              <Volume2 size={18} />
            </button>
          </div>
          <Label text={t("study.answer")}>
            <input
              className="app-input text-lg"
              value={session.answer}
              onChange={(event) => setSession({ ...session, answer: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !session.revealed) {
                  submitAnswer();
                }
              }}
              disabled={session.revealed}
              autoFocus
            />
          </Label>
          {!session.revealed ? (
            <button className="app-button app-button-primary mt-4" onClick={submitAnswer} disabled={!session.answer.trim()}>
              <Check size={18} />
              {t("study.submit")}
            </button>
          ) : (
            <div className="mt-5 grid gap-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-semibold text-slate-600">{t("study.reveal")}</p>
                <p className="mt-1 text-xl font-bold">{accepted.join(" / ")}</p>
                <p className="mt-2 text-sm font-semibold">
                  {session.match === "correct" ? t("study.correctAnswer") : null}
                  {session.match === "close" ? t("study.closeAnswer") : null}
                  {session.match === "wrong" ? t("study.wrongAnswer") : null}
                </p>
                {session.match === "close" ? (
                  <label className="mt-3 flex items-center gap-2 text-sm font-semibold">
                    <input
                      type="checkbox"
                      checked={session.closeAccepted}
                      onChange={(event) => setSession({ ...session, closeAccepted: event.target.checked })}
                    />
                    {t("study.acceptClose")}
                  </label>
                ) : null}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {ratings.map((rating) => (
                  <button
                    key={rating}
                    className={`app-button ${rating === "again" ? "app-button-danger" : "app-button-secondary"}`}
                    onClick={() => rateCurrent(rating)}
                  >
                    {t(`study.${rating}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="grid gap-5">
      <ViewTitle title={t("study.title")} />
      <div className="grid gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-soft">
        <div className="grid gap-4 md:grid-cols-3">
          <ScopeSelect scope={scope} setScope={setScope} decks={decks} subsets={subsets} />
          <DirectionPicker value={direction} setup={setup} onChange={setDirection} />
          <Metric label={t("common.due")} value={dueCount.toString()} compact />
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="app-button app-button-primary" onClick={() => startSession(false)} disabled={activePairWords.length === 0}>
            <ChevronRight size={18} />
            {t("study.start")}
          </button>
          <button
            className="app-button app-button-secondary"
            onClick={() => {
              setAllowFuture(true);
              void startSession(true);
            }}
            disabled={activePairWords.length === 0 || allowFuture}
          >
            <RotateCcw size={18} />
            {t("study.includeFuture")}
          </button>
        </div>
      </div>
    </section>
  );
}

function LibraryView({
  profile,
  setup,
  decks,
  words,
  cards,
  usage,
  onRefresh,
  onStatus
}: {
  profile: Profile;
  setup: LearningSetup;
  decks: Deck[];
  words: WordEntry[];
  cards: CardState[];
  usage: TranslationUsage | null;
  onRefresh: () => Promise<void>;
  onStatus: (message: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [form, setForm] = useState<WordFormState>(() => ({ ...emptyWordForm, deckId: decks[0]?.id ?? "" }));
  const [suggestions, setSuggestions] = useState<TranslationResult[]>([]);
  const [fetching, setFetching] = useState(false);
  const [lastAutoSuggestedText, setLastAutoSuggestedText] = useState("");
  const [query, setQuery] = useState("");
  const [deckFilter, setDeckFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<ReviewStatus>("all");
  const translationLimitReached = (usage?.count ?? 0) >= myMemoryDailyLimit;

  useEffect(() => {
    if (!form.deckId && decks[0]) {
      setForm((current) => ({ ...current, deckId: decks[0].id }));
    }
  }, [decks, form.deckId]);

  useEffect(() => {
    const text = form.targetText.trim();
    if (
      form.id ||
      text.length < 2 ||
      form.translations.trim() ||
      fetching ||
      translationLimitReached ||
      lastAutoSuggestedText === text
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void fetchSuggestions(true);
    }, 800);

    return () => window.clearTimeout(timeoutId);
  }, [fetching, form.id, form.targetText, form.translations, lastAutoSuggestedText, translationLimitReached]);

  const cardByWord = useMemo(() => groupCardsByWord(cards), [cards]);
  const filteredWords = words.filter((word) => {
    const haystack = `${word.targetText} ${word.translations.join(" ")} ${word.notes}`.toLocaleLowerCase();
    const matchesQuery = !query || haystack.includes(query.toLocaleLowerCase());
    const matchesDeck = deckFilter === "all" || word.deckId === deckFilter;
    const wordCards = cardByWord.get(word.id) ?? [];
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "due" && wordCards.some((card) => new Date(card.due) <= new Date())) ||
      (statusFilter === "new" && wordCards.every((card) => card.reviewCount === 0)) ||
      (statusFilter === "learned" && wordCards.some((card) => card.reviewCount > 0));

    return matchesQuery && matchesDeck && matchesStatus;
  });

  async function fetchSuggestions(automatic = false) {
    if (!form.targetText.trim() || translationLimitReached) {
      if (translationLimitReached) {
        onStatus(t("status.limitReached"));
      }
      return;
    }

    setFetching(true);
    try {
      const result = await fetchTranslationSuggestions(form.targetText, setup.targetLanguage, setup.baseLanguage);
      setSuggestions(result);
      setLastAutoSuggestedText(form.targetText.trim());
      await onRefresh();
    } catch (error) {
      setLastAutoSuggestedText(form.targetText.trim());
      if (!automatic) {
        onStatus(error instanceof Error && error.message === "daily-limit" ? t("status.limitReached") : t("status.offline"));
      }
    } finally {
      setFetching(false);
    }
  }

  async function saveWord(event: FormEvent) {
    event.preventDefault();
    const translations = splitTranslations(form.translations);
    if (!form.targetText.trim() || translations.length === 0 || !form.deckId) {
      return;
    }

    const timestamp = nowIso();
    if (form.id) {
      await db.words.update(form.id, {
        targetText: form.targetText.trim(),
        translations,
        notes: form.notes.trim(),
        deckId: form.deckId,
        updatedAt: timestamp
      });
    } else {
      const word: WordEntry = {
        id: createId("word"),
        profileId: profile.id,
        learningSetupId: setup.id,
        deckId: form.deckId,
        targetText: form.targetText.trim(),
        translations,
        notes: form.notes.trim(),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await db.words.add(word);
      await ensureCardsForWords([word]);
    }

    setForm({ ...emptyWordForm, deckId: decks[0]?.id ?? "" });
    setSuggestions([]);
    onStatus(t("status.saved"));
    await onRefresh();
  }

  async function deleteWord(word: WordEntry) {
    await db.transaction("rw", db.words, db.cards, db.subsets, async () => {
      await db.words.delete(word.id);
      const wordCards = await db.cards.where("wordId").equals(word.id).toArray();
      await db.cards.bulkDelete(wordCards.map((card) => card.id));
      const affectedSubsets = await db.subsets.where("profileId").equals(profile.id).toArray();
      await Promise.all(
        affectedSubsets.map((subset) =>
          db.subsets.update(subset.id, {
            wordIds: subset.wordIds.filter((wordId) => wordId !== word.id),
            updatedAt: nowIso()
          })
        )
      );
    });
    onStatus(t("status.deleted"));
    await onRefresh();
  }

  function editWord(word: WordEntry) {
    setForm({
      id: word.id,
      targetText: word.targetText,
      translations: word.translations.join("; "),
      notes: word.notes,
      deckId: word.deckId
    });
    setSuggestions([]);
  }

  return (
    <section className="grid gap-5">
      <ViewTitle title={t("library.title")} />
      <form className="grid gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-soft" onSubmit={saveWord}>
        <h2 className="text-lg font-bold">{t("library.addWord")}</h2>
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr_220px]">
          <Label
            text={
              <span className="flex items-center gap-1">
                <FlagIcon code={setup.targetLanguage} />
                {t("library.targetText")}
              </span>
            }
          >
            <input className="app-input" value={form.targetText} onChange={(event) => setForm({ ...form, targetText: event.target.value })} required />
          </Label>
          <Label
            text={
              <span className="flex items-center gap-1">
                <FlagIcon code={setup.baseLanguage} />
                {t("library.manualTranslation")}
              </span>
            }
          >
            <input
              className="app-input"
              value={form.translations}
              onChange={(event) => setForm({ ...form, translations: event.target.value })}
              placeholder={t("library.translationHint")}
              required
            />
          </Label>
          <Label text={t("common.deck")}>
            <select className="app-input" value={form.deckId} onChange={(event) => setForm({ ...form, deckId: event.target.value })}>
              {decks.map((deck) => (
                <option key={deck.id} value={deck.id}>
                  {deck.name}
                </option>
              ))}
            </select>
          </Label>
        </div>
        <Label text={`${t("common.notes")} (${t("common.optional")})`}>
          <textarea className="app-input min-h-24" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
        </Label>
        <div className="flex flex-wrap gap-2">
          <button className="app-button app-button-secondary" type="button" onClick={() => fetchSuggestions(false)} disabled={fetching || !form.targetText.trim() || translationLimitReached}>
            <Search size={18} />
            {t("library.fetchSuggestions")}
          </button>
          <button className="app-button app-button-primary" type="submit">
            <Plus size={18} />
            {form.id ? t("common.save") : t("common.add")}
          </button>
          {form.id ? (
            <button className="app-button app-button-ghost" type="button" onClick={() => setForm({ ...emptyWordForm, deckId: decks[0]?.id ?? "" })}>
              {t("common.cancel")}
            </button>
          ) : null}
        </div>
        {suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-2" aria-label={t("library.suggestions")}>
            {suggestions.map((suggestion) => (
              <button
                key={`${suggestion.text}-${suggestion.confidence}`}
                className="app-button app-button-secondary"
                type="button"
                onClick={() => {
                  const next = new Set(splitTranslations(form.translations));
                  next.add(suggestion.text);
                  setForm({ ...form, translations: [...next].join("; ") });
                }}
              >
                {suggestion.text}
                <span className="text-xs text-slate-500">{Math.round(suggestion.confidence * 100)}%</span>
              </button>
            ))}
          </div>
        ) : null}
      </form>

      <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <Label text={t("common.search")}>
            <input className="app-input" value={query} onChange={(event) => setQuery(event.target.value)} />
          </Label>
          <Label text={t("common.deck")}>
            <select className="app-input" value={deckFilter} onChange={(event) => setDeckFilter(event.target.value)}>
              <option value="all">{t("common.all")}</option>
              {decks.map((deck) => (
                <option key={deck.id} value={deck.id}>
                  {deck.name}
                </option>
              ))}
            </select>
          </Label>
          <Label text={t("library.reviewStatus")}>
            <select className="app-input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ReviewStatus)}>
              <option value="all">{t("common.all")}</option>
              <option value="due">{t("common.due")}</option>
              <option value="new">{t("common.new")}</option>
              <option value="learned">{t("common.learned")}</option>
            </select>
          </Label>
        </div>
      </div>

      <div className="grid gap-3">
        {filteredWords.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-slate-600">{t("library.noWords")}</div>
        ) : null}
        {filteredWords.map((word) => (
          <article key={word.id} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-lg font-bold">{word.targetText}</h3>
                <p className="text-slate-700">{word.translations.join(" / ")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="app-chip">{decks.find((deck) => deck.id === word.deckId)?.name ?? t("common.deck")}</span>
                  <span className="app-chip">
                    <FlagIcon code={setup.targetLanguage} />
                    {languageOptionLabel(setup.targetLanguage, profile.uiLanguage)}
                  </span>
                  <span className="app-chip">{formatLastReviewed(cardByWord.get(word.id), t("library.lastReviewed"), profile.uiLanguage)}</span>
                </div>
                {word.notes ? <p className="mt-3 text-sm text-slate-600">{word.notes}</p> : null}
              </div>
              <div className="flex gap-2">
                <button className="app-button app-button-secondary" onClick={() => editWord(word)} aria-label={t("common.edit")}>
                  <Edit2 size={17} />
                </button>
                <button className="app-button app-button-danger" onClick={() => deleteWord(word)} aria-label={t("common.delete")}>
                  <Trash2 size={17} />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DecksView({
  profile,
  setup,
  decks,
  words,
  subsets,
  onRefresh,
  onStatus
}: {
  profile: Profile;
  setup: LearningSetup;
  decks: Deck[];
  words: WordEntry[];
  subsets: CustomSubset[];
  onRefresh: () => Promise<void>;
  onStatus: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [deckName, setDeckName] = useState("");
  const [editingSubsetId, setEditingSubsetId] = useState<string | null>(null);
  const [subsetName, setSubsetName] = useState("");
  const [selectedWordIds, setSelectedWordIds] = useState<string[]>([]);

  async function addDeck(event: FormEvent) {
    event.preventDefault();
    if (!deckName.trim()) {
      return;
    }

    const timestamp = nowIso();
    await db.decks.add({
      id: createId("deck"),
      profileId: profile.id,
      learningSetupId: setup.id,
      name: deckName.trim(),
      createdAt: timestamp,
      updatedAt: timestamp
    });
    setDeckName("");
    onStatus(t("status.saved"));
    await onRefresh();
  }

  async function renameDeck(deck: Deck) {
    const name = window.prompt(t("decks.deckName"), deck.name);
    if (!name?.trim()) {
      return;
    }

    await db.decks.update(deck.id, { name: name.trim(), updatedAt: nowIso() });
    await onRefresh();
  }

  async function deleteDeck(deck: Deck) {
    const deckWords = words.filter((word) => word.deckId === deck.id);
    const otherDeck = decks.find((candidate) => candidate.id !== deck.id);

    if (deckWords.length > 0 && otherDeck) {
      const reassign = window.confirm(`${t("decks.reassignWords")}: ${otherDeck.name}?`);
      await deleteDeckWithWords(deck.id, reassign ? "reassign" : "delete", reassign ? otherDeck.id : undefined);
    } else {
      await deleteDeckWithWords(deck.id, "delete");
    }

    onStatus(t("status.deleted"));
    await onRefresh();
  }

  async function addSubset(event: FormEvent) {
    event.preventDefault();
    if (!subsetName.trim() || selectedWordIds.length === 0) {
      return;
    }

    const timestamp = nowIso();
    if (editingSubsetId) {
      await db.subsets.update(editingSubsetId, {
        name: subsetName.trim(),
        wordIds: selectedWordIds,
        updatedAt: timestamp
      });
    } else {
      await db.subsets.add({
        id: createId("subset"),
        profileId: profile.id,
        learningSetupId: setup.id,
        name: subsetName.trim(),
        wordIds: selectedWordIds,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }

    setEditingSubsetId(null);
    setSubsetName("");
    setSelectedWordIds([]);
    onStatus(t("status.saved"));
    await onRefresh();
  }

  function editSubset(subset: CustomSubset) {
    setEditingSubsetId(subset.id);
    setSubsetName(subset.name);
    setSelectedWordIds(subset.wordIds);
  }

  function cancelSubsetEdit() {
    setEditingSubsetId(null);
    setSubsetName("");
    setSelectedWordIds([]);
  }

  async function deleteSubset(subset: CustomSubset) {
    await db.subsets.delete(subset.id);
    onStatus(t("status.deleted"));
    await onRefresh();
  }

  return (
    <section className="grid gap-5">
      <ViewTitle title={t("decks.title")} />
      <div className="grid gap-4 lg:grid-cols-2">
        <form className="grid gap-3 rounded-lg border border-slate-200 bg-white p-5 shadow-soft" onSubmit={addDeck}>
          <h2 className="text-lg font-bold">{t("decks.createDeck")}</h2>
          <Label text={t("decks.deckName")}>
            <input className="app-input" value={deckName} onChange={(event) => setDeckName(event.target.value)} />
          </Label>
          <button className="app-button app-button-primary w-fit" type="submit">
            <Plus size={18} />
            {t("common.create")}
          </button>
        </form>

        <form className="grid gap-3 rounded-lg border border-slate-200 bg-white p-5 shadow-soft" onSubmit={addSubset}>
          <h2 className="text-lg font-bold">{editingSubsetId ? t("decks.editSubset") : t("decks.createSubset")}</h2>
          <Label text={t("decks.subsetName")}>
            <input className="app-input" value={subsetName} onChange={(event) => setSubsetName(event.target.value)} />
          </Label>
          <div className="max-h-52 overflow-auto rounded-lg border border-slate-200 p-2">
            {words.map((word) => (
              <label key={word.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={selectedWordIds.includes(word.id)}
                  onChange={(event) => {
                    setSelectedWordIds((current) =>
                      event.target.checked ? [...current, word.id] : current.filter((wordId) => wordId !== word.id)
                    );
                  }}
                />
                {word.targetText}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
          <button className="app-button app-button-primary" type="submit" disabled={selectedWordIds.length === 0}>
            {editingSubsetId ? <Check size={18} /> : <Plus size={18} />}
            {t("common.save")}
          </button>
          {editingSubsetId ? (
            <button className="app-button app-button-ghost" type="button" onClick={cancelSubsetEdit}>
              {t("common.cancel")}
            </button>
          ) : null}
          </div>
        </form>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid gap-3">
          {decks.map((deck) => (
            <article key={deck.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold">{deck.name}</h3>
                  <p className="text-sm text-slate-600">{words.filter((word) => word.deckId === deck.id).length} {t("common.word")}</p>
                </div>
                <div className="flex gap-2">
                  <button className="app-button app-button-secondary" onClick={() => renameDeck(deck)} aria-label={t("common.rename")}>
                    <Edit2 size={17} />
                  </button>
                  <button className="app-button app-button-danger" onClick={() => deleteDeck(deck)} aria-label={t("common.delete")}>
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
        <div className="grid gap-3">
          {subsets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-slate-600">{t("decks.noSubsets")}</div>
          ) : null}
          {subsets.map((subset) => (
            <article key={subset.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold">{subset.name}</h3>
                  <p className="text-sm text-slate-600">{subset.wordIds.length} {t("decks.selectedWords")}</p>
                </div>
                <div className="flex gap-2">
                  <button className="app-button app-button-secondary" onClick={() => editSubset(subset)} aria-label={t("common.edit")}>
                    <Edit2 size={17} />
                  </button>
                  <button className="app-button app-button-danger" onClick={() => deleteSubset(subset)} aria-label={t("common.delete")}>
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function SettingsView({
  profile,
  profiles,
  learningSetups,
  activeSetup,
  decks,
  words,
  subsets,
  usage,
  onRefresh,
  onStatus
}: {
  profile: Profile;
  profiles: Profile[];
  learningSetups: LearningSetup[];
  activeSetup: LearningSetup | null;
  decks: Deck[];
  words: WordEntry[];
  subsets: CustomSubset[];
  usage: TranslationUsage | null;
  onRefresh: () => Promise<void>;
  onStatus: (message: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [newProfileName, setNewProfileName] = useState("");
  const [setupName, setSetupName] = useState("");
  const [setupBaseLanguage, setSetupBaseLanguage] = useState<LanguageCode>(activeSetup?.baseLanguage ?? "de");
  const [setupTargetLanguage, setSetupTargetLanguage] = useState<LanguageCode>(activeSetup?.targetLanguage ?? "es");
  const [setupWordCounts, setSetupWordCounts] = useState<Record<string, number>>({});
  const [editingSetupLanguagesId, setEditingSetupLanguagesId] = useState<string | null>(null);
  const [editingBaseLanguage, setEditingBaseLanguage] = useState<LanguageCode>(activeSetup?.baseLanguage ?? "de");
  const [editingTargetLanguage, setEditingTargetLanguage] = useState<LanguageCode>(activeSetup?.targetLanguage ?? "es");

  useEffect(() => {
    if (activeSetup) {
      setSetupBaseLanguage(activeSetup.baseLanguage);
      setSetupTargetLanguage(activeSetup.targetLanguage);
    }
  }, [activeSetup?.baseLanguage, activeSetup?.targetLanguage]);

  useEffect(() => {
    let cancelled = false;

    async function loadCounts() {
      const entries = await Promise.all(
        learningSetups.map(async (setup) => [setup.id, await db.words.where("learningSetupId").equals(setup.id).count()] as const)
      );
      if (!cancelled) {
        setSetupWordCounts(Object.fromEntries(entries));
      }
    }

    void loadCounts();

    return () => {
      cancelled = true;
    };
  }, [learningSetups]);

  async function updateUiLanguage(value: LanguageCode) {
    await db.profiles.update(profile.id, { uiLanguage: value, updatedAt: nowIso() });
    await onRefresh();
  }

  async function createAdditionalProfile(event: FormEvent) {
    event.preventDefault();
    if (!newProfileName.trim()) {
      return;
    }

    const created = await createProfile(newProfileName, profile.uiLanguage);
    localStorage.setItem(activeProfileStorageKey, created.id);
    setNewProfileName("");
    await onRefresh();
  }

  async function createSetup(event: FormEvent) {
    event.preventDefault();
    await createLearningSetup(
      profile.id,
      setupName || setupNamePlaceholder(setupBaseLanguage, setupTargetLanguage, i18n.language, t),
      setupBaseLanguage,
      setupTargetLanguage
    );
    setSetupName("");
    onStatus(t("status.saved"));
    await onRefresh();
  }

  async function renameSetup(setup: LearningSetup) {
    const name = window.prompt(t("setup.name"), setup.name);
    if (!name?.trim()) {
      return;
    }

    await db.learningSetups.update(setup.id, { name: name.trim(), updatedAt: nowIso() });
    await onRefresh();
  }

  async function removeSetup(setup: LearningSetup) {
    if (!window.confirm(`${t("setup.delete")}\n\n${setup.name}`)) {
      return;
    }

    await deleteLearningSetup(setup.id);
    onStatus(t("status.deleted"));
    await onRefresh();
  }

  function beginLanguageEdit(setup: LearningSetup) {
    setEditingSetupLanguagesId(setup.id);
    setEditingBaseLanguage(setup.baseLanguage);
    setEditingTargetLanguage(setup.targetLanguage);
  }

  async function saveSetupLanguages(setup: LearningSetup) {
    const wordCount = await db.words.where("learningSetupId").equals(setup.id).count();
    if (wordCount > 0) {
      onStatus(t("setup.languagesLocked"));
      setEditingSetupLanguagesId(null);
      return;
    }

    await db.learningSetups.update(setup.id, {
      baseLanguage: editingBaseLanguage,
      targetLanguage: editingTargetLanguage,
      updatedAt: nowIso()
    });
    onStatus(t("status.saved"));
    setEditingSetupLanguagesId(null);
    await onRefresh();
  }

  async function resetData() {
    if (!window.confirm(`${t("settings.resetAll")}\n\n${t("settings.resetWarning")}`)) {
      return;
    }

    await resetAllLocalData();
    localStorage.removeItem(activeProfileStorageKey);
    await onRefresh();
  }

  return (
    <section className="grid gap-5">
      <ViewTitle title={t("settings.title")} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-soft">
          <h2 className="text-lg font-bold">{t("settings.languages")}</h2>
          <LanguageSelect label={t("profile.uiLanguage")} value={profile.uiLanguage} onChange={updateUiLanguage} />
        </div>

        <form className="grid gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-soft" onSubmit={createAdditionalProfile}>
          <h2 className="text-lg font-bold">{t("profile.createAnother")}</h2>
          <Label text={t("profile.name")}>
            <input className="app-input" value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} />
          </Label>
          <p className="text-sm text-slate-600">{profiles.length} {t("profile.switch")}</p>
          <button className="app-button app-button-primary w-fit" type="submit">
            <Plus size={18} />
            {t("common.create")}
          </button>
        </form>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <form className="grid gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-soft" onSubmit={createSetup}>
          <h2 className="text-lg font-bold">{t("setup.create")}</h2>
          <Label text={t("setup.name")}>
            <input
              className="app-input"
              value={setupName}
              onChange={(event) => setSetupName(event.target.value)}
              placeholder={setupNamePlaceholder(setupBaseLanguage, setupTargetLanguage, i18n.language, t)}
            />
          </Label>
          <div className="grid gap-4 sm:grid-cols-2">
            <LanguageSelect
              label={t("setup.baseLanguage")}
              value={setupBaseLanguage}
              exclude={[setupTargetLanguage]}
              onChange={(value) => {
                setSetupBaseLanguage(value);
                if (setupTargetLanguage === value) {
                  setSetupTargetLanguage(firstAvailableLanguage(value));
                }
              }}
            />
            <LanguageSelect
              label={t("setup.targetLanguage")}
              value={setupTargetLanguage}
              exclude={[setupBaseLanguage]}
              onChange={(value) => {
                setSetupTargetLanguage(value);
                if (setupBaseLanguage === value) {
                  setSetupBaseLanguage(firstAvailableLanguage(value));
                }
              }}
            />
          </div>
          <button className="app-button app-button-primary w-fit" type="submit">
            <Plus size={18} />
            {t("common.create")}
          </button>
        </form>

        <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-5 shadow-soft">
          <h2 className="text-lg font-bold">{t("setup.title")}</h2>
          {learningSetups.map((setup) => (
            <div key={setup.id} className="grid gap-3 rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-bold">
                    <FlagIcon code={setup.targetLanguage} />
                    <span className="truncate">{learningSetupDisplayName(setup, i18n.language)}</span>
                  </p>
                  <p className="mt-1 flex items-center gap-1 text-sm text-slate-600">
                    <span>{t("setup.baseShort")}:</span>
                    <FlagIcon code={setup.baseLanguage} />
                    <span>{languageOptionLabel(setup.baseLanguage, i18n.language)}</span>
                  </p>
                </div>
                <div className="flex gap-2">
                  <button className="app-button app-button-secondary" onClick={() => renameSetup(setup)} aria-label={t("common.rename")}>
                    <Edit2 size={17} />
                  </button>
                  <button
                    className="app-button app-button-secondary"
                    onClick={() => beginLanguageEdit(setup)}
                    disabled={(setupWordCounts[setup.id] ?? 0) > 0}
                    title={(setupWordCounts[setup.id] ?? 0) > 0 ? t("setup.languagesLocked") : t("setup.editLanguages")}
                  >
                    {t("setup.editLanguages")}
                  </button>
                  <button
                    className="app-button app-button-danger"
                    onClick={() => removeSetup(setup)}
                    aria-label={t("common.delete")}
                    disabled={learningSetups.length <= 1}
                    title={learningSetups.length <= 1 ? t("setup.keepOne") : t("setup.delete")}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
              {editingSetupLanguagesId === setup.id ? (
                <div className="grid gap-3 rounded-lg bg-slate-50 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <LanguageSelect
                      label={t("setup.baseLanguage")}
                      value={editingBaseLanguage}
                      exclude={[editingTargetLanguage]}
                      onChange={(value) => {
                        setEditingBaseLanguage(value);
                        if (editingTargetLanguage === value) {
                          setEditingTargetLanguage(firstAvailableLanguage(value));
                        }
                      }}
                    />
                    <LanguageSelect
                      label={t("setup.targetLanguage")}
                      value={editingTargetLanguage}
                      exclude={[editingBaseLanguage]}
                      onChange={(value) => {
                        setEditingTargetLanguage(value);
                        if (editingBaseLanguage === value) {
                          setEditingBaseLanguage(firstAvailableLanguage(value));
                        }
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className="app-button app-button-primary" onClick={() => saveSetupLanguages(setup)}>
                      {t("common.save")}
                    </button>
                    <button className="app-button app-button-ghost" onClick={() => setEditingSetupLanguagesId(null)}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-soft">
        <h2 className="text-lg font-bold">{t("settings.data")}</h2>
        <div className="flex flex-wrap gap-2">
          <button
            className="app-button app-button-secondary"
            onClick={() =>
              downloadTextFile(
                "lexora-export.json",
                createJsonExport(profile, learningSetups, decks, words, subsets),
                "application/json"
              )
            }
          >
            <Download size={18} />
            {t("library.exportJson")}
          </button>
          <button
            className="app-button app-button-secondary"
            onClick={() => downloadTextFile("lexora-export.csv", createCsvExport(words, decks), "text/csv")}
          >
            <Download size={18} />
            {t("library.exportCsv")}
          </button>
          <button className="app-button app-button-danger" onClick={resetData}>
            <Trash2 size={18} />
            {t("settings.resetAll")}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-amber-950">
        <h2 className="text-lg font-bold">{t("settings.usage")}</h2>
        <p>
          {usage?.count ?? 0} / {myMemoryDailyLimit} {t("common.today")}
        </p>
      </div>
    </section>
  );
}

function UsageBadge({ usage }: { usage: TranslationUsage | null }) {
  const { t } = useTranslation();
  const count = usage?.count ?? 0;
  const remaining = Math.max(0, myMemoryDailyLimit - count);
  const percent = Math.min(100, Math.round((count / myMemoryDailyLimit) * 100));

  return (
    <div className="w-full min-w-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 sm:min-w-52" title={t("settings.usage")}>
      <div className="flex items-center justify-between gap-2 font-semibold">
        <span>{t("settings.usage")}</span>
        <span>{percent}%</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-amber-100">
        <div className="h-full bg-amber-500" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1 text-xs">{remaining} {t("settings.requestsRemaining")}</p>
    </div>
  );
}

function ConnectionBadge({ online }: { online: boolean }) {
  const { t } = useTranslation();

  return (
    <div
      className={`w-full min-w-0 rounded-lg border px-3 py-2 text-sm font-semibold sm:min-w-52 ${
        online ? "border-emerald-200 bg-emerald-50 text-emerald-950" : "border-rose-200 bg-rose-50 text-rose-950"
      }`}
      role="status"
      aria-live="polite"
      title={online ? t("connection.onlineDetail") : t("connection.offlineDetail")}
    >
      <span className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${online ? "bg-emerald-500" : "bg-rose-500"}`} aria-hidden="true" />
        {online ? t("connection.online") : t("connection.offline")}
      </span>
    </div>
  );
}

function ScopeSelect({
  scope,
  setScope,
  decks,
  subsets
}: {
  scope: ScopeSelection;
  setScope: (scope: ScopeSelection) => void;
  decks: Deck[];
  subsets: CustomSubset[];
}) {
  const { t } = useTranslation();
  const value = scope.type === "all" ? "all" : `${scope.type}:${scope.type === "deck" ? scope.deckId : scope.subsetId}`;

  return (
    <Label text={t("study.scope")}>
      <select
        className="app-input"
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "all") {
            setScope({ type: "all" });
          } else if (next.startsWith("deck:")) {
            setScope({ type: "deck", deckId: next.slice(5) });
          } else {
            setScope({ type: "subset", subsetId: next.slice(7) });
          }
        }}
      >
        <option value="all">{t("common.all")}</option>
        {decks.map((deck) => (
          <option key={deck.id} value={`deck:${deck.id}`}>
            {t("common.deck")}: {deck.name}
          </option>
        ))}
        {subsets.map((subset) => (
          <option key={subset.id} value={`subset:${subset.id}`}>
            {t("common.subset")}: {subset.name}
          </option>
        ))}
      </select>
    </Label>
  );
}

function DirectionPicker({
  value,
  setup,
  onChange
}: {
  value: StudyDirection;
  setup: LearningSetup;
  onChange: (value: StudyDirection) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ value: StudyDirection; label: string; flags: React.ReactNode }> = [
    {
      value: "target-base",
      label: t("study.targetBase"),
      flags: (
        <>
          <FlagIcon code={setup.targetLanguage} />
          <span aria-hidden="true">→</span>
          <FlagIcon code={setup.baseLanguage} />
        </>
      )
    },
    {
      value: "base-target",
      label: t("study.baseTarget"),
      flags: (
        <>
          <FlagIcon code={setup.baseLanguage} />
          <span aria-hidden="true">→</span>
          <FlagIcon code={setup.targetLanguage} />
        </>
      )
    },
    {
      value: "mixed",
      label: t("study.mixed"),
      flags: (
        <>
          <FlagIcon code={setup.targetLanguage} />
          <span aria-hidden="true">↔</span>
          <FlagIcon code={setup.baseLanguage} />
        </>
      )
    }
  ];

  return (
    <div className="grid gap-1">
      <span className="text-sm font-semibold text-slate-700">{t("study.direction")}</span>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("study.direction")}>
        {options.map((option) => (
          <button
            key={option.value}
            className={`app-button min-w-0 px-2 ${option.value === value ? "app-button-primary" : "app-button-secondary"}`}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            aria-label={option.label}
            title={option.label}
            onClick={() => onChange(option.value)}
          >
            <span className="flex items-center justify-center gap-1">{option.flags}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LanguageSelect({
  label,
  value,
  exclude = [],
  onChange
}: {
  label: string;
  value: LanguageCode;
  exclude?: LanguageCode[];
  onChange: (value: LanguageCode) => void;
}) {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const excluded = new Set(exclude);
  const availableCodes = languageCodes.filter((code) => !excluded.has(code));
  const selectedLabel = languageOptionLabel(value, i18n.language);
  const selectedIndex = Math.max(
    0,
    availableCodes.findIndex((code) => code === value)
  );

  function selectByIndex(index: number) {
    const next = availableCodes[index];
    if (next) {
      onChange(next);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((current) => !current);
      return;
    }

    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();
    setOpen(true);

    if (event.key === "Home") {
      selectByIndex(0);
      return;
    }

    if (event.key === "End") {
      selectByIndex(availableCodes.length - 1);
      return;
    }

    const offset = event.key === "ArrowDown" ? 1 : -1;
    selectByIndex((selectedIndex + offset + availableCodes.length) % availableCodes.length);
  }

  return (
    <div className="relative min-w-0 max-w-full" onBlur={() => window.setTimeout(() => setOpen(false), 100)}>
      <span className="mb-1 block text-sm font-semibold text-slate-700">{label}</span>
      <button
        className="app-input flex min-h-11 min-w-0 items-center justify-between gap-3 text-left"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selectedLabel}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span className="flex min-w-0 items-center gap-2">
          <FlagIcon code={value} />
          <span className="truncate">{selectedLabel}</span>
        </span>
        <ChevronRight className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} size={16} />
      </button>
      {open ? (
        <div
          className="absolute z-40 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-soft"
          role="listbox"
        >
          {availableCodes.map((code) => (
            <button
              key={code}
              className={`flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-slate-100 ${
                code === value ? "bg-indigo-50 font-bold text-indigo-900" : "text-slate-800"
              }`}
              type="button"
              role="option"
              aria-selected={code === value}
              onClick={() => {
                onChange(code);
                setOpen(false);
              }}
            >
              <FlagIcon code={code} />
              <span className="truncate">{languageOptionLabel(code, i18n.language)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Label({ text, children }: { text: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm font-semibold text-slate-700">
      <span>{text}</span>
      {children}
    </label>
  );
}

function HeaderSelect({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1 text-xs font-bold uppercase tracking-wide text-slate-500">
      <span className="truncate">{label}</span>
      {children}
    </label>
  );
}

function LearningSetupSelect({
  label,
  value,
  setups,
  locale,
  onChange
}: {
  label: string;
  value: string;
  setups: LearningSetup[];
  locale: LanguageCode;
  onChange: (value: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = setups.find((setup) => setup.id === value) ?? setups[0];
  const selectedIndex = Math.max(
    0,
    setups.findIndex((setup) => setup.id === selected?.id)
  );

  function selectByIndex(index: number) {
    const next = setups[index];
    if (next) {
      void onChange(next.id);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((current) => !current);
      return;
    }

    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();
    setOpen(true);

    if (event.key === "Home") {
      selectByIndex(0);
      return;
    }

    if (event.key === "End") {
      selectByIndex(setups.length - 1);
      return;
    }

    const offset = event.key === "ArrowDown" ? 1 : -1;
    selectByIndex((selectedIndex + offset + setups.length) % setups.length);
  }

  return (
    <div className="relative min-w-0 max-w-full" onBlur={() => window.setTimeout(() => setOpen(false), 100)}>
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">{label}</span>
      <button
        className="app-input flex min-h-11 min-w-0 items-center justify-between gap-3 text-left"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected ? `${learningSetupDisplayName(selected, locale)} · ${setupBaseContext(selected.baseLanguage, locale, t("setup.baseShort"))}` : label}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected ? <FlagIcon code={selected.targetLanguage} /> : null}
          <span className="min-w-0">
            <span className="block truncate">{selected ? learningSetupDisplayName(selected, locale) : ""}</span>
            {selected ? (
              <span className="flex items-center gap-1 truncate text-xs font-semibold text-slate-500">
                <span>{t("setup.baseShort")}:</span>
                <FlagIcon code={selected.baseLanguage} />
                <span>{languageOptionLabel(selected.baseLanguage, locale)}</span>
              </span>
            ) : null}
          </span>
        </span>
        <ChevronRight className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} size={16} />
      </button>
      {open ? (
        <div
          className="absolute z-40 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-soft"
          role="listbox"
        >
          {setups.map((setup) => (
            <button
              key={setup.id}
              className={`flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-slate-100 ${
                setup.id === value ? "bg-indigo-50 font-bold text-indigo-900" : "text-slate-800"
              }`}
              type="button"
              role="option"
              aria-selected={setup.id === value}
              onClick={() => {
                void onChange(setup.id);
                setOpen(false);
              }}
            >
              <FlagIcon code={setup.targetLanguage} />
              <span className="min-w-0">
                <span className="block truncate">{learningSetupDisplayName(setup, locale)}</span>
                <span className="flex min-w-0 items-center gap-1 text-xs font-normal text-slate-500">
                  <span>{t("setup.baseShort")}:</span>
                  <FlagIcon code={setup.baseLanguage} />
                  <span className="truncate">{languageOptionLabel(setup.baseLanguage, locale)}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ViewTitle({ title }: { title: string }) {
  return <h2 className="text-2xl font-bold tracking-normal">{title}</h2>;
}

function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={`rounded-lg border border-slate-200 bg-white ${compact ? "p-3" : "p-5 shadow-soft"}`}>
      <p className="text-sm font-semibold text-slate-600">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

function NavButton({
  icon,
  label,
  active,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 text-sm font-bold sm:min-h-12 sm:w-auto sm:rounded-none sm:border-x-0 sm:border-t-0 sm:border-b-2 ${
        active
          ? "border-indigo-700 bg-indigo-50 text-indigo-800 sm:bg-transparent"
          : "border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-950 sm:border-transparent sm:hover:bg-transparent"
      }`}
      onClick={onClick}
      title={label}
    >
      {icon}
      {label}
    </button>
  );
}

function currentNavLabel(view: ViewKey, t: (key: string) => string): string {
  const labels: Record<ViewKey, string> = {
    study: t("nav.study"),
    library: t("nav.library"),
    decks: t("nav.decks"),
    settings: t("nav.settings")
  };

  return labels[view];
}

function FlagIcon({ code }: { code: LanguageCode }) {
  const common = "h-4 w-6 shrink-0 overflow-hidden rounded-[3px] border border-slate-300 shadow-sm";

  if (code === "de") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="30" height="20" fill="#ffce00" />
        <rect width="30" height="13.33" fill="#dd0000" />
        <rect width="30" height="6.67" fill="#000000" />
      </svg>
    );
  }

  if (code === "fr") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="10" height="20" fill="#002395" />
        <rect x="10" width="10" height="20" fill="#ffffff" />
        <rect x="20" width="10" height="20" fill="#ed2939" />
      </svg>
    );
  }

  if (code === "it") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="10" height="20" fill="#009246" />
        <rect x="10" width="10" height="20" fill="#ffffff" />
        <rect x="20" width="10" height="20" fill="#ce2b37" />
      </svg>
    );
  }

  if (code === "es") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="30" height="20" fill="#aa151b" />
        <rect y="5" width="30" height="10" fill="#f1bf00" />
      </svg>
    );
  }

  if (code === "pt") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="12" height="20" fill="#006600" />
        <rect x="12" width="18" height="20" fill="#ff0000" />
        <circle cx="12" cy="10" r="3.4" fill="#ffcc00" />
        <circle cx="12" cy="10" r="2.1" fill="#ffffff" />
      </svg>
    );
  }

  if (code === "ru") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="30" height="20" fill="#d52b1e" />
        <rect width="30" height="13.33" fill="#0039a6" />
        <rect width="30" height="6.67" fill="#ffffff" />
      </svg>
    );
  }

  return (
    <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
      <rect width="30" height="20" fill="#012169" />
      <path d="M0 0L30 20M30 0L0 20" stroke="#ffffff" strokeWidth="4" />
      <path d="M0 0L30 20M30 0L0 20" stroke="#c8102e" strokeWidth="2" />
      <path d="M15 0V20M0 10H30" stroke="#ffffff" strokeWidth="7" />
      <path d="M15 0V20M0 10H30" stroke="#c8102e" strokeWidth="4" />
    </svg>
  );
}

function filterWordsByScope(words: WordEntry[], scope: ScopeSelection, subsets: CustomSubset[]): WordEntry[] {
  if (scope.type === "all") {
    return words;
  }

  if (scope.type === "deck") {
    return words.filter((word) => word.deckId === scope.deckId);
  }

  const subset = subsets.find((candidate) => candidate.id === scope.subsetId);
  const ids = new Set(subset?.wordIds ?? []);
  return words.filter((word) => ids.has(word.id));
}

function defaultSetupName(baseLanguage: LanguageCode, targetLanguage: LanguageCode, locale = "en"): string {
  return `${localizedLanguageName(targetLanguage, locale)} from ${localizedLanguageName(baseLanguage, locale)}`;
}

function firstAvailableLanguage(excluded: LanguageCode): LanguageCode {
  return languageCodes.find((code) => code !== excluded) ?? "en";
}

function setupNamePlaceholder(
  baseLanguage: LanguageCode,
  targetLanguage: LanguageCode,
  locale: string,
  t: (key: string, values?: Record<string, string>) => string
): string {
  return t("setup.namePlaceholder", {
    target: localizedLanguageName(targetLanguage, locale),
    base: localizedLanguageName(baseLanguage, locale)
  });
}

function learningSetupDisplayName(setup: LearningSetup, locale = "en"): string {
  const friendlyName = languageOptionLabel(setup.targetLanguage, locale);
  const generatedNames = new Set([
    defaultSetupName(setup.baseLanguage, setup.targetLanguage, locale),
    defaultSetupName(setup.baseLanguage, setup.targetLanguage),
    `${setup.targetLanguage.toUpperCase()} over ${setup.baseLanguage.toUpperCase()}`,
    `${languageNames[setup.targetLanguage]} over ${languageNames[setup.baseLanguage]}`,
    `${languageNames[setup.targetLanguage]} from ${languageNames[setup.baseLanguage]}`
  ]);

  return generatedNames.has(setup.name) ? friendlyName : `${setup.name} · ${friendlyName}`;
}

function setupBaseContext(baseLanguage: LanguageCode, locale = "en", label = "From"): string {
  return `${label}: ${languageOptionLabel(baseLanguage, locale)}`;
}

function languageOptionLabel(code: LanguageCode, locale = "en"): string {
  return `${localizedLanguageName(code, locale)} (${code.toUpperCase()})`;
}

function localizedLanguageName(code: LanguageCode, locale = "en"): string {
  try {
    const displayNames = new Intl.DisplayNames([locale], { type: "language" });
    const name = displayNames.of(code);
    return name ? capitalizeFirst(name) : languageNames[code];
  } catch {
    return languageNames[code];
  }
}

function capitalizeFirst(value: string): string {
  return value.length > 0 ? `${value[0].toLocaleUpperCase()}${value.slice(1)}` : value;
}

function getPrompt(studyCard: StudyCard): string {
  return studyCard.card.direction === "target-base" ? studyCard.word.targetText : studyCard.word.translations[0] ?? "";
}

function getAcceptedAnswers(studyCard: StudyCard): string[] {
  return studyCard.card.direction === "target-base" ? studyCard.word.translations : [studyCard.word.targetText];
}

function directionLabel(direction: CardDirection, t: (key: string) => string): string {
  return direction === "target-base" ? t("study.targetBase") : t("study.baseTarget");
}

function splitTranslations(value: string): string[] {
  return value
    .split(";")
    .map((translation) => translation.trim())
    .filter(Boolean);
}

function groupCardsByWord(cards: CardState[]): Map<string, CardState[]> {
  const grouped = new Map<string, CardState[]>();
  for (const card of cards) {
    grouped.set(card.wordId, [...(grouped.get(card.wordId) ?? []), card]);
  }
  return grouped;
}

function formatLastReviewed(cards: CardState[] | undefined, label: string, locale: LanguageCode): string {
  const reviewed = cards?.map((card) => card.lastReviewedAt).filter(Boolean) as string[] | undefined;
  if (!reviewed || reviewed.length === 0) {
    return `${label}: -`;
  }

  const sorted = reviewed.sort();
  const latest = sorted[sorted.length - 1];
  return `${label}: ${latest ? new Date(latest).toLocaleDateString(locale) : "-"}`;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}
