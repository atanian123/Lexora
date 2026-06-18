import {
  BookOpen,
  Check,
  ChevronRight,
  Download,
  Edit2,
  Gauge,
  Layers,
  Menu,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Moon,
  Sun,
  Trash2,
  UserRound,
  Volume2,
  X
} from "lucide-react";
import { FormEvent, ChangeEvent, useEffect, useId, useMemo, useRef, useState } from "react";
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
  createInitialCardState,
  createProfile,
  db,
  deleteDeckWithWords,
  deleteLearningSetup,
  ensureCardsForWords,
  ensureDefaultDeck,
  resetAllLocalData
} from "./lib/db";
import {
  createBackupExport,
  createCsvExport,
  downloadTextFile,
  parseLexoraBackup,
  parseWordCsv
} from "./lib/export";
import { createId, nowIso } from "./lib/ids";
import { evaluateAnswer, type MatchResult } from "./lib/matching";
import { scheduleReview } from "./lib/srs";
import { fetchTranslationSuggestions, getTodayTranslationUsage } from "./lib/translation";
import { ConfirmationProvider, useConfirm } from "./components/confirmation";
import { FlagIcon, HeaderSelect, Label, Metric, NavButton, ViewTitle } from "./components/ui";

type ViewKey = "study" | "library" | "decks" | "settings";
type ThemeMode = "light" | "dark";

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
  selectedRating?: ReviewRating;
  paused: boolean;
}

const emptyWordForm: WordFormState = {
  targetText: "",
  translations: "",
  notes: "",
  deckId: ""
};

const themeStorageKey = "lexora.theme";

function readStoredTheme(): ThemeMode {
  const stored = localStorage.getItem(themeStorageKey);
  return stored === "light" || stored === "dark" ? stored : "dark";
}

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
  const [theme, setThemeState] = useState<ThemeMode>(readStoredTheme);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;
  const activeSetup =
    learningSetups.find((setup) => setup.id === activeProfile?.activeLearningSetupId) ?? learningSetups[0] ?? null;

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      "content",
      theme === "dark" ? "#0f0f1a" : "#f7f9fc"
    );
    localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    if (!mobileMenuOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };

    window.addEventListener("keydown", closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileMenuOpen]);

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

  async function refreshAll(nextActiveId = activeProfileId, showLoading = loading) {
    if (showLoading) {
      setLoading(true);
    }
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
      <main className="app-screen flex min-h-dvh items-center justify-center px-4">
        <div className="app-chip">Lexora</div>
      </main>
    );
  }

  if (!activeProfile) {
    return <FirstRun onCreated={handleProfileCreated} />;
  }

  function setTheme(value: ThemeMode) {
    setThemeState(value);
  }

  async function updateActiveUiLanguage(value: LanguageCode) {
    if (!activeProfile) {
      return;
    }

    await db.profiles.update(activeProfile.id, { uiLanguage: value, updatedAt: nowIso() });
    await refreshAll(activeProfile.id, false);
  }

  return (
    <ConfirmationProvider>
    <div className="app-shell">
      <header className="app-header app-glass sticky top-0 z-30 border-b">
        <div className="mx-auto grid max-w-7xl gap-3 px-4 py-3 sm:px-6">
          <div className="desktop-top-row">
            <div className="flex min-w-0 items-center gap-3">
              <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-11 w-11 shrink-0 drop-shadow-[0_0_8px_rgba(99,102,241,0.6)]" />
              <div className="min-w-0">
                <h1 className="app-heading text-xl font-bold tracking-tight">Lexora</h1>
                <p className="app-muted truncate text-sm">{t("app.tagline")}</p>
              </div>
            </div>
            <div className="desktop-nav-tabs" aria-label="Primary">
              <NavButton
                icon={<BookOpen size={18} />}
                label={t("nav.study")}
                active={view === "study"}
                onClick={() => setView("study")}
              />
              <NavButton
                icon={<Search size={18} />}
                label={t("nav.library")}
                active={view === "library"}
                onClick={() => setView("library")}
              />
              <NavButton
                icon={<Layers size={18} />}
                label={t("nav.decks")}
                active={view === "decks"}
                onClick={() => setView("decks")}
              />
              <NavButton
                icon={<Settings size={18} />}
                label={t("nav.settings")}
                active={view === "settings"}
                onClick={() => setView("settings")}
              />
            </div>
            <button
              className="mobile-menu-trigger app-button app-button-secondary h-10 w-10 shrink-0 p-0"
              type="button"
              aria-expanded={mobileMenuOpen}
              aria-label={mobileMenuOpen ? t("nav.closeMenu") : t("nav.openMenu")}
              data-tooltip={mobileMenuOpen ? t("nav.closeMenu") : t("nav.openMenu")}
              onClick={() => setMobileMenuOpen((open) => !open)}
            >
              {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
            <div className="desktop-preferences">
              <ChromePreferences
                uiLanguage={activeProfile.uiLanguage}
                theme={theme}
                onLanguageChange={updateActiveUiLanguage}
                onThemeChange={setTheme}
              />
            </div>
          </div>

          <div className="desktop-header-controls">
            <div className="desktop-practice-control">
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
            <div className="desktop-meta-controls">
            <HeaderSelect label={t("profile.label")} tooltip={t("profile.switch")}>
                <select
                  className="app-input"
                  value={activeProfile.id}
                  aria-label={t("profile.switch")}
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
              <div className="desktop-status-row">
                <UsageBadge usage={usage} compact />
                <ConnectionBadge online={isOnline} compact />
              </div>
            </div>
          </div>
        </div>
      </header>

      <nav className="app-nav app-glass border-b sm:hidden" aria-label="Primary">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex min-h-14 items-center sm:hidden">
            <div className="min-w-0">
              <span className="app-heading block text-sm font-semibold">{currentNavLabel(view, t)}</span>
              {activeSetup ? (
                <span className="app-subtle mt-1 flex items-center gap-1 text-xs font-semibold">
                  <FlagIcon code={activeSetup.targetLanguage} />
                  <span className="truncate">{languageOptionLabel(activeSetup.targetLanguage, activeProfile.uiLanguage)}</span>
                  <span className="app-muted">·</span>
                  <span className="truncate">{t("setup.baseShort")}:</span>
                  <FlagIcon code={activeSetup.baseLanguage} />
                  <span className="truncate">{languageOptionLabel(activeSetup.baseLanguage, activeProfile.uiLanguage)}</span>
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </nav>

      {mobileMenuOpen ? (
        <div className="fixed inset-0 z-50 sm:hidden" role="presentation">
          <button
            className="app-backdrop absolute inset-0"
            type="button"
            aria-label={t("nav.closeMenu")}
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside
            className="app-mobile-drawer app-glass absolute inset-y-0 right-0 flex w-[min(22rem,calc(100vw-1rem))] max-w-full flex-col overflow-y-auto p-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={t("nav.menu")}
          >
            <div className="mb-4 flex h-11 items-center justify-between gap-3">
              <ChromePreferences
                uiLanguage={activeProfile.uiLanguage}
                theme={theme}
                onLanguageChange={updateActiveUiLanguage}
                onThemeChange={setTheme}
              />
              <button
                className="app-button app-button-secondary h-10 w-10 shrink-0 p-0"
                type="button"
                aria-label={t("nav.closeMenu")}
                data-tooltip={t("nav.closeMenu")}
                onClick={() => setMobileMenuOpen(false)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="grid gap-4">
              <section className="app-subpanel grid gap-3 p-3">
                <HeaderSelect label={t("profile.label")} tooltip={t("profile.switch")}>
                  <select
                    className="app-input"
                    value={activeProfile.id}
                    aria-label={t("profile.switch")}
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
              </section>

              <section className="grid gap-2" aria-label={t("nav.menu")}>
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
              </section>

              <section className="grid gap-2">
                <UsageBadge usage={usage} />
                <ConnectionBadge online={isOnline} />
              </section>
            </div>
          </aside>
        </div>
      ) : null}

      {status ? (
        <div className="app-status app-glass border-b px-4 py-2 text-center text-sm font-semibold">
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
            usage={usage}
            onRefresh={refreshAll}
            onStatus={setStatus}
          />
        ) : null}
      </main>
    </div>
    </ConfirmationProvider>
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
    <main className="app-screen flex min-h-dvh items-center justify-center px-4 py-10">
      <form className="app-panel w-full max-w-xl p-4" onSubmit={handleSubmit}>
        <div className="mb-6 flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-12 w-12" />
          <div>
            <h1 className="text-xl font-semibold">{t("profile.firstRunTitle")}</h1>
            <p className="app-muted text-sm">{t("profile.firstRunBody")}</p>
          </div>
        </div>

        <div className="grid gap-4">
          <Label text={t("profile.name")}>
            <input
              className="app-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("profile.namePlaceholder")}
              autoFocus
              required
            />
          </Label>
          <LanguageSelect label={t("profile.uiLanguage")} value={uiLanguage} onChange={setUiLanguage} />
          <button className="app-button app-button-primary" type="submit" data-tooltip={t("common.create")}>
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
      <form className="app-panel w-full max-w-xl p-4" onSubmit={handleSubmit}>
        <div className="mb-6">
          <h1 className="text-xl font-semibold">{t("setup.firstRunTitle")}</h1>
          <p className="app-muted text-sm">{t("setup.firstRunBody")}</p>
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
          <button className="app-button app-button-primary" type="submit" data-tooltip={t("setup.create")}>
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
  const answerInputRef = useRef<HTMLInputElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const advancingRef = useRef(false);

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
    setSession({ ...session, revealed: true, match, selectedRating: defaultRatingForMatch(match, false) });
  }

  async function rateCurrent(rating = session?.selectedRating) {
    if (!session?.current) {
      return;
    }
    const selectedRating = rating ?? defaultRatingForMatch(session.match ?? "wrong", session.closeAccepted);

    const scheduled = scheduleReview(session.current.card, selectedRating);
    await db.cards.update(session.current.card.id, scheduled);

    const wasCorrect = session.match === "correct" || (session.match === "close" && session.closeAccepted);
    const reviewed = session.reviewed + 1;
    const correct = session.correct + (wasCorrect ? 1 : 0);
    const streak = wasCorrect ? session.streak + 1 : 0;
    const nextQueue = [...session.queue];

    if (selectedRating === "again") {
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
      selectedRating: undefined,
      paused: false
    });

    await onRefresh();
  }

  async function advanceStudyCard() {
    if (!session?.revealed || advancingRef.current) {
      return;
    }

    advancingRef.current = true;
    try {
      await rateCurrent(session.selectedRating ?? defaultRatingForMatch(session.match ?? "wrong", session.closeAccepted));
    } finally {
      advancingRef.current = false;
    }
  }

  useEffect(() => {
    if (session?.revealed) {
      nextButtonRef.current?.focus();
    }
  }, [session?.revealed, session?.current?.card.id]);

  useEffect(() => {
    if (session?.current && !session.revealed && !session.paused) {
      answerInputRef.current?.focus();
    }
  }, [session?.current?.card.id, session?.revealed, session?.paused]);

  useEffect(() => {
    if (!session?.revealed) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const inputTarget = target?.closest("input") as HTMLInputElement | null;
      if (target?.closest("button, a, select, textarea, [contenteditable='true']") || (inputTarget && !inputTarget.disabled)) {
        return;
      }

      event.preventDefault();
      void advanceStudyCard();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [session?.revealed, session?.selectedRating, session?.closeAccepted, session?.match, session?.current?.card.id]);

  if (session?.paused) {
    return (
      <section className="grid gap-4">
        <ViewTitle title={t("study.paused")} />
        <div className="app-panel p-4">
          <p className="app-muted text-sm">
            {session.reviewed} {t("study.reviewed")} · {session.queue.length + (session.current ? 1 : 0)} {t("study.remaining")}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="app-button app-button-primary"
              onClick={() => setSession({ ...session, paused: false })}
              data-tooltip={t("study.resumeHint")}
            >
              {t("study.resume")}
            </button>
            <button className="app-button app-button-ghost" onClick={() => setSession(null)} data-tooltip={t("study.abandonHint")}>
              {t("study.abandon")}
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (session && !session.current) {
    const accuracy = session.reviewed === 0 ? 0 : Math.round((session.correct / session.reviewed) * 100);
    if (session.reviewed === 0) {
      return (
        <section className="grid gap-4">
          <ViewTitle title={t("study.noDueTitle")} />
          <div className="app-warning rounded-xl border p-4">
            <p className="font-semibold">{t("study.noCards")}</p>
            <p className="mt-1 text-sm">{t("study.noDueBody")}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="app-button app-button-secondary" onClick={() => startSession(true)} data-tooltip={t("study.practiceAnywayHint")}>
                <RotateCcw size={18} />
                {t("study.includeFuture")}
              </button>
              <button className="app-button app-button-ghost" onClick={() => setSession(null)} data-tooltip={t("study.backToStudyHint")}>
                {t("study.backToStudy")}
              </button>
            </div>
          </div>
        </section>
      );
    }

    return (
      <section className="grid gap-4">
        <ViewTitle title={t("study.summary")} />
        <p className="app-muted text-sm">{t("study.summaryBody")}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label={t("study.reviewed")} value={session.reviewed.toString()} hint={t("study.reviewedHint")} />
          <Metric label={t("study.accuracy")} value={`${accuracy}%`} hint={t("study.accuracyHint")} />
          <Metric label={t("study.streak")} value={session.bestStreak.toString()} hint={t("study.streakHint")} />
        </div>
        <button className="app-button app-button-primary w-fit" onClick={() => setSession(null)} data-tooltip={t("study.backToStudyHint")}>
          {t("study.backToStudy")}
        </button>
      </section>
    );
  }

  if (session?.current) {
    const prompt = getPrompt(session.current);
    const accepted = getAcceptedAnswers(session.current);
    const resultTone =
      session.match === "correct" || (session.match === "close" && session.closeAccepted)
        ? "correct"
        : session.match === "close"
          ? "close"
          : "wrong";
    const resultPanelClass =
      resultTone === "correct"
        ? "app-success shadow-[0_0_0_1px_rgba(16,185,129,0.15),0_12px_30px_rgba(16,185,129,0.15)]"
        : resultTone === "wrong"
          ? "app-danger-surface shadow-[0_0_0_1px_rgba(244,63,94,0.15),0_12px_30px_rgba(244,63,94,0.15)]"
          : "app-warning shadow-[0_0_0_1px_rgba(245,158,11,0.12),0_12px_30px_rgba(245,158,11,0.12)]";
    const resultLabelClass =
      resultTone === "correct" ? "text-emerald-500" : resultTone === "wrong" ? "text-rose-500" : "text-amber-500";
    return (
      <section className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ViewTitle title={t("study.title")} />
          <div className="flex flex-wrap gap-2">
            <button className="app-button app-button-secondary" onClick={() => setSession({ ...session, paused: true })} data-tooltip={t("study.pauseHint")}>
              {t("study.pause")}
            </button>
            <button className="app-button app-button-ghost" onClick={() => setSession(null)} data-tooltip={t("study.abandonHint")}>
              {t("study.abandon")}
            </button>
          </div>
        </div>
        <div className="app-panel p-4">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="app-chip">{directionLabel(session.current.card.direction, t)}</span>
            <span className="app-chip">{session.reviewed} {t("study.reviewed")}</span>
          </div>
          <div className="mb-4 flex items-start justify-between gap-3">
            <p className="app-heading text-2xl font-bold">{prompt}</p>
            <button
              className="app-button app-button-secondary h-11 w-11 shrink-0 p-0"
              type="button"
              disabled
              aria-label={t("study.audioPlaceholder")}
              data-tooltip={t("study.audioPlaceholder")}
            >
              <Volume2 size={18} />
            </button>
          </div>
          <Label text={t("study.answer")}>
            <input
              className="app-input text-lg"
              value={session.answer}
              onChange={(event) => setSession({ ...session, answer: event.target.value })}
              placeholder={t("study.answerPlaceholder")}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !session.revealed) {
                  event.preventDefault();
                  event.stopPropagation();
                  submitAnswer();
                }
              }}
              disabled={session.revealed}
              ref={answerInputRef}
              autoFocus
            />
          </Label>
          {!session.revealed ? (
            <button className="app-button app-button-primary mt-4" onClick={submitAnswer} disabled={!session.answer.trim()} data-tooltip={t("study.submit")}>
              <Check size={18} />
              {t("study.submit")}
            </button>
          ) : (
            <div className="mt-5 grid gap-4">
              <div className={`rounded-lg border p-3 ${resultPanelClass}`}>
                <p className={`text-sm font-semibold ${resultLabelClass}`}>
                  {session.match === "correct" ? t("study.correctAnswer") : null}
                  {session.match === "close" ? t("study.closeAnswer") : null}
                  {session.match === "wrong" ? t("study.wrongAnswer") : null}
                </p>
                <p className="mt-2 text-sm font-semibold opacity-60">{t("study.reveal")}</p>
                <p className="mt-1 text-lg font-semibold">{accepted.join(" / ")}</p>
                {session.match === "close" ? (
                  <label className="mt-3 flex items-center gap-2 text-sm font-semibold">
                    <input
                      type="checkbox"
                      checked={session.closeAccepted}
                      onChange={(event) =>
                        setSession({
                          ...session,
                          closeAccepted: event.target.checked,
                          selectedRating: defaultRatingForMatch(session.match ?? "wrong", event.target.checked)
                        })
                      }
                    />
                    {t("study.acceptClose")}
                  </label>
                ) : null}
              </div>
              <p className="app-muted text-sm">{t("study.ratingHelp")}</p>
              <div className="grid grid-cols-4 gap-1.5 sm:w-fit">
                {ratings.map((rating) => (
                  <button
                    key={rating}
                    className={`app-button min-h-9 px-2 py-1 text-xs ${
                      session.selectedRating === rating
                        ? rating === "again"
                          ? "app-button-danger"
                          : "app-button-primary"
                        : "app-button-secondary"
                    }`}
                    onClick={() => setSession({ ...session, selectedRating: rating })}
                    data-tooltip={`${t(`study.${rating}`)}: ${t(`study.${rating}Hint`)}`}
                    type="button"
                  >
                    {t(`study.${rating}`)}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="app-subtle text-xs">
                  {t("study.selectedRating", {
                    rating: t(`study.${session.selectedRating ?? "again"}`),
                    hint: t(`study.${session.selectedRating ?? "again"}Hint`)
                  })}
                </p>
                <button className="app-button app-button-primary" onClick={() => void advanceStudyCard()} type="button" ref={nextButtonRef} data-tooltip={t("study.next")}>
                  {t("study.next")}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="grid gap-4">
      <ViewTitle title={t("study.title")} />
      <div className="app-panel grid gap-3 p-4">
        <p className="app-muted text-sm">{t("study.setupHelp")}</p>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <ScopeSelect scope={scope} setScope={setScope} decks={decks} subsets={subsets} />
          <DirectionPicker value={direction} setup={setup} onChange={setDirection} />
          <DueStatus count={dueCount} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="app-button app-button-primary" onClick={() => startSession(false)} disabled={activePairWords.length === 0} data-tooltip={t("study.startHint")}>
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
            data-tooltip={t("study.practiceAnywayHint")}
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
  const confirm = useConfirm();
  const [form, setForm] = useState<WordFormState>(() => ({ ...emptyWordForm, deckId: decks[0]?.id ?? "" }));
  const [suggestions, setSuggestions] = useState<TranslationResult[]>([]);
  const [fetching, setFetching] = useState(false);
  const [lastAutoSuggestedText, setLastAutoSuggestedText] = useState("");
  const [query, setQuery] = useState("");
  const [deckFilter, setDeckFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<ReviewStatus>("all");
  const [showWordDetails, setShowWordDetails] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [wordPage, setWordPage] = useState(1);
  const [wordFormSubmitted, setWordFormSubmitted] = useState(false);
  const translationLimitReached = (usage?.count ?? 0) >= myMemoryDailyLimit;
  const translationCount = usage?.count ?? 0;
  const translationRemaining = Math.max(0, myMemoryDailyLimit - translationCount);
  const translationQuotaPercent = Math.min(100, Math.round((translationCount / myMemoryDailyLimit) * 100));
  const wordsPerPage = 50;
  const duplicateWord = useMemo(() => {
    const candidate = normalizeDuplicateText(form.targetText);
    if (!candidate) {
      return undefined;
    }

    return words.find((word) => word.id !== form.id && normalizeDuplicateText(word.targetText) === candidate);
  }, [form.id, form.targetText, words]);

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
  const filteredWords = useMemo(() => words.filter((word) => {
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
  }), [cardByWord, deckFilter, query, statusFilter, words]);
  const wordPageCount = Math.max(1, Math.ceil(filteredWords.length / wordsPerPage));
  const safeWordPage = Math.min(wordPage, wordPageCount);
  const wordPageStart = filteredWords.length === 0 ? 0 : (safeWordPage - 1) * wordsPerPage + 1;
  const wordPageEnd = Math.min(safeWordPage * wordsPerPage, filteredWords.length);
  const pagedWords = filteredWords.slice((safeWordPage - 1) * wordsPerPage, safeWordPage * wordsPerPage);
  const targetMissing = wordFormSubmitted && !form.targetText.trim();
  const translationsMissing = wordFormSubmitted && splitTranslations(form.translations).length === 0;

  useEffect(() => {
    setWordPage(1);
  }, [deckFilter, query, statusFilter]);

  useEffect(() => {
    setWordPage((current) => Math.min(current, wordPageCount));
  }, [wordPageCount]);

  async function fetchSuggestions(automatic = false) {
    const targetText = form.targetText.trim();
    if (!targetText || translationLimitReached) {
      if (translationLimitReached) {
        onStatus(t("status.limitReached"));
      }
      return;
    }

    setFetching(true);
    try {
      const result = await fetchTranslationSuggestions(targetText, setup.targetLanguage, setup.baseLanguage);
      setSuggestions(result);
      setLastAutoSuggestedText(targetText);
      if (!automatic && result.length === 0) {
        onStatus(t("status.noSuggestions"));
      }
      await onRefresh();
    } catch (error) {
      setLastAutoSuggestedText(targetText);
      if (!automatic) {
        onStatus(error instanceof Error && error.message === "daily-limit" ? t("status.limitReached") : t("status.offline"));
      }
    } finally {
      setFetching(false);
    }
  }

  async function saveWord(event: FormEvent) {
    event.preventDefault();
    setWordFormSubmitted(true);
    const translations = splitTranslations(form.translations);
    if (!form.targetText.trim() || translations.length === 0 || !form.deckId) {
      return;
    }

    if (duplicateWord) {
      const addDuplicate = await confirm({
        title: t("library.duplicateTitle"),
        message: t("library.duplicateBody", { word: duplicateWord.targetText }),
        confirmLabel: t("library.addDuplicate"),
        cancelLabel: t("common.cancel")
      });
      if (!addDuplicate) {
        return;
      }
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
    setShowWordDetails(false);
    setWordFormSubmitted(false);
    onStatus(t("status.saved"));
    await onRefresh();
  }

  async function deleteWord(word: WordEntry) {
    const confirmed = await confirm({
      title: t("common.confirmDeleteTitle"),
      message: `${t("common.confirmDelete")}\n\n${word.targetText}`,
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      variant: "danger"
    });
    if (!confirmed) {
      return;
    }

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

  function resetWordForm() {
    setForm({ ...emptyWordForm, deckId: decks[0]?.id ?? "" });
    setSuggestions([]);
    setShowWordDetails(false);
    setWordFormSubmitted(false);
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
    setShowWordDetails(true);
    setWordFormSubmitted(false);
  }

  return (
    <section className="grid gap-4">
      <ViewTitle title={t("library.title")} />
      <form className="app-panel grid gap-3 p-4" onSubmit={saveWord} noValidate>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="app-heading text-base font-semibold">{form.id ? t("common.edit") : t("library.addWord")}</h2>
            {form.id ? <p className="app-subtle truncate text-xs">{form.targetText}</p> : null}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {form.id ? (
              <button className="app-button app-button-ghost" type="button" onClick={resetWordForm} data-tooltip={t("common.cancel")}>
                {t("common.cancel")}
              </button>
            ) : null}
            <button className="app-button app-button-ghost" type="button" onClick={() => setShowWordDetails((visible) => !visible)} data-tooltip={t("common.details")}>
              <Settings size={16} />
              {t("common.details")}
            </button>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Label
            text={
              <span className="flex items-center gap-1">
                <FlagIcon code={setup.targetLanguage} />
                {t("library.targetText")}
              </span>
            }
          >
            <input
              className={`app-input ${duplicateWord || targetMissing ? "app-input-warning" : ""}`}
              value={form.targetText}
              onChange={(event) => setForm({ ...form, targetText: event.target.value })}
              placeholder={t("library.targetPlaceholder")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={targetMissing}
            />
            {targetMissing ? <span className="app-warning-text text-xs">{t("library.targetRequired")}</span> : null}
            {duplicateWord ? <span className="app-warning-text text-xs">{t("library.duplicateInline")}</span> : null}
          </Label>
          <button
            className="app-button app-button-secondary"
            type="button"
            onClick={() => fetchSuggestions(false)}
            disabled={fetching || !form.targetText.trim() || translationLimitReached}
            data-tooltip={t("library.fetchSuggestions")}
            data-tooltip-placement="top"
          >
            <Search size={18} />
            {t("library.fetchSuggestions")}
          </button>
        </div>

        {suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" aria-label={t("library.suggestions")}>
            {suggestions.map((suggestion) => (
              <button
                key={`${suggestion.text}-${suggestion.confidence}`}
                className="app-suggestion inline-flex min-h-8 items-center gap-1 rounded-full border px-2.5 py-1 text-sm font-medium transition-colors"
                type="button"
                onClick={() => {
                  const next = new Set(splitTranslations(form.translations));
                  next.add(suggestion.text);
                  setForm({ ...form, translations: [...next].join("; ") });
                }}
                data-tooltip={t("library.acceptSuggestion")}
              >
                {suggestion.text}
                <span className="rounded-full bg-black/10 px-1.5 text-[0.68rem]">{Math.round(suggestion.confidence * 100)}%</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Label
            text={
              <span className="flex items-center gap-1">
                <FlagIcon code={setup.baseLanguage} />
                {t("common.translations")}
              </span>
            }
          >
            <input
              className={`app-input ${translationsMissing ? "app-input-warning" : ""}`}
              value={form.translations}
              onChange={(event) => setForm({ ...form, translations: event.target.value })}
              placeholder={t("library.translationHint")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={translationsMissing}
            />
            {translationsMissing ? <span className="app-warning-text text-xs">{t("library.translationsRequired")}</span> : null}
          </Label>
          <button className="app-button app-button-primary" type="submit" data-tooltip={form.id ? t("common.save") : t("common.add")}>
            <Plus size={18} />
            {form.id ? t("common.save") : t("common.add")}
          </button>
        </div>

        <div
          className={`flex items-center justify-between gap-3 rounded-md border px-2.5 py-1.5 text-xs ${
            translationLimitReached
              ? "app-danger-surface"
              : translationQuotaPercent >= 80
                ? "app-warning"
                : "border-[color:var(--border-subtle)] bg-[var(--subpanel-bg)] app-muted"
          }`}
          data-tooltip={t("settings.usage")}
        >
          <span>{t("settings.usage")}</span>
          <span className="font-semibold">
            {translationRemaining} / {myMemoryDailyLimit} {t("settings.requestsRemaining")}
          </span>
        </div>

        {showWordDetails ? (
          <div className="app-subpanel grid gap-3 p-3 md:grid-cols-[16rem_minmax(0,1fr)]">
            <Label text={t("common.deck")}>
              <select className="app-input" value={form.deckId} onChange={(event) => setForm({ ...form, deckId: event.target.value })}>
                {decks.map((deck) => (
                  <option key={deck.id} value={deck.id}>
                    {deck.name}
                  </option>
                ))}
              </select>
            </Label>
            <Label text={`${t("common.notes")} (${t("common.optional")})`}>
              <textarea
                className="app-input min-h-20"
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
                placeholder={t("library.notesPlaceholder")}
              />
            </Label>
          </div>
        ) : null}

      </form>

      <div className="app-panel grid gap-3 p-4">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Label text={t("common.search")}>
            <input
              className="app-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("library.searchPlaceholder")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Label>
          <button className="app-button app-button-secondary" type="button" onClick={() => setShowFilters((visible) => !visible)} data-tooltip={t("library.filters")}>
            <Search size={16} />
            {t("library.filters")}
          </button>
        </div>
        {showFilters ? (
          <div className="app-divider grid gap-3 border-t pt-3 md:grid-cols-2">
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
        ) : null}
      </div>

      <div className="app-panel overflow-hidden">
        <div className="app-divider flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2.5">
          <div className="app-muted text-sm font-semibold">
            {filteredWords.length} / {words.length} {t("common.word")}
          </div>
          {filteredWords.length > 0 ? (
            <div className="app-subtle text-xs">
              {wordPageStart}-{wordPageEnd} · {t("library.page", { page: safeWordPage, pages: wordPageCount })}
            </div>
          ) : null}
        </div>
        {filteredWords.length === 0 ? (
          <div className="app-muted p-4">{t("library.noWords")}</div>
        ) : null}
        {pagedWords.map((word) => (
          <article key={word.id} className="app-divider border-t px-3 py-2.5 first:border-t-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h3 className="app-heading font-semibold leading-snug">{word.targetText}</h3>
                  <p className="app-muted text-sm leading-snug">{word.translations.join(" / ")}</p>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <span className="app-chip">{decks.find((deck) => deck.id === word.deckId)?.name ?? t("common.deck")}</span>
                  <span className="app-chip">{formatLastReviewed(cardByWord.get(word.id), t("library.lastReviewed"), profile.uiLanguage)}</span>
                </div>
                {word.notes ? <p className="app-subtle mt-1.5 text-xs leading-relaxed">{word.notes}</p> : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <button className="app-button app-button-secondary app-icon-button" onClick={() => editWord(word)} aria-label={t("common.edit")} data-tooltip={t("common.edit")}>
                  <Edit2 size={17} />
                </button>
                <button className="app-button app-button-danger app-icon-button" onClick={() => deleteWord(word)} aria-label={t("common.delete")} data-tooltip={t("common.delete")}>
                  <Trash2 size={17} />
                </button>
              </div>
            </div>
          </article>
        ))}
        {wordPageCount > 1 ? (
          <div className="app-divider flex items-center justify-between gap-2 border-t px-3 py-2.5">
            <button
              className="app-button app-button-secondary app-button-compact"
              type="button"
              onClick={() => setWordPage((current) => Math.max(1, current - 1))}
              disabled={safeWordPage <= 1}
              data-tooltip={t("common.previous")}
            >
              {t("common.previous")}
            </button>
            <span className="app-subtle text-xs font-semibold">{safeWordPage} / {wordPageCount}</span>
            <button
              className="app-button app-button-secondary app-button-compact"
              type="button"
              onClick={() => setWordPage((current) => Math.min(wordPageCount, current + 1))}
              disabled={safeWordPage >= wordPageCount}
              data-tooltip={t("common.next")}
            >
              {t("common.next")}
            </button>
          </div>
        ) : null}
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
  const confirm = useConfirm();
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
    const confirmed = await confirm({
      title: t("common.confirmDeleteTitle"),
      message: `${t("common.confirmDelete")}\n\n${deck.name}`,
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      variant: "danger"
    });
    if (!confirmed) {
      return;
    }

    const deckWords = words.filter((word) => word.deckId === deck.id);
    const otherDeck = decks.find((candidate) => candidate.id !== deck.id);

    if (deckWords.length > 0 && otherDeck) {
      const reassign = await confirm({
        title: t("decks.reassignWords"),
        message: otherDeck.name,
        confirmLabel: t("decks.reassignWords"),
        cancelLabel: t("decks.deleteWords")
      });
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
    const confirmed = await confirm({
      title: t("common.confirmDeleteTitle"),
      message: `${t("common.confirmDelete")}\n\n${subset.name}`,
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      variant: "danger"
    });
    if (!confirmed) {
      return;
    }

    await db.subsets.delete(subset.id);
    onStatus(t("status.deleted"));
    await onRefresh();
  }

  return (
    <section className="grid gap-4">
      <ViewTitle title={t("decks.title")} />
      <div className="grid gap-4 lg:grid-cols-2">
        <form className="app-panel grid gap-2 p-3" onSubmit={addDeck}>
          <h2 className="app-heading text-sm font-semibold">{t("decks.createDeck")}</h2>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <Label text={t("decks.deckName")}>
              <input className="app-input app-input-compact" value={deckName} onChange={(event) => setDeckName(event.target.value)} placeholder={t("decks.deckNamePlaceholder")} />
            </Label>
            <button className="app-button app-button-primary app-button-compact w-fit" type="submit" data-tooltip={t("decks.createDeck")}>
              <Plus size={16} />
              {t("common.create")}
            </button>
          </div>
        </form>

        <form className="app-panel grid gap-3 p-4" onSubmit={addSubset}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="app-heading text-base font-semibold">{editingSubsetId ? t("decks.editSubset") : t("decks.createSubset")}</h2>
            <span className="app-chip">{selectedWordIds.length} {t("decks.selectedWords")}</span>
          </div>
          <Label text={t("decks.subsetName")}>
            <input className="app-input" value={subsetName} onChange={(event) => setSubsetName(event.target.value)} placeholder={t("decks.subsetNamePlaceholder")} />
          </Label>
          <div className="app-subpanel max-h-56 overflow-auto p-2">
            {words.length === 0 ? <p className="app-muted p-2 text-sm">{t("library.noWords")}</p> : null}
            {words.map((word) => (
              <label key={word.id} className="app-label grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--dropdown-hover-bg)]">
                <input
                  type="checkbox"
                  checked={selectedWordIds.includes(word.id)}
                  onChange={(event) => {
                    setSelectedWordIds((current) =>
                      event.target.checked ? [...current, word.id] : current.filter((wordId) => wordId !== word.id)
                    );
                  }}
                />
                <span className="truncate">{word.targetText}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="app-button app-button-primary" type="submit" disabled={selectedWordIds.length === 0} data-tooltip={editingSubsetId ? t("common.save") : t("decks.createSubset")}>
              {editingSubsetId ? <Check size={18} /> : <Plus size={18} />}
              {t("common.save")}
            </button>
            {editingSubsetId ? (
              <button className="app-button app-button-ghost" type="button" onClick={cancelSubsetEdit} data-tooltip={t("common.cancel")}>
                {t("common.cancel")}
              </button>
            ) : null}
          </div>
        </form>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid gap-3">
          {decks.map((deck) => (
            <article key={deck.id} className="app-panel px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="app-heading truncate font-semibold">{deck.name}</h3>
                  <p className="app-muted text-sm">{words.filter((word) => word.deckId === deck.id).length} {t("common.word")}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button className="app-button app-button-secondary app-icon-button" onClick={() => renameDeck(deck)} aria-label={t("common.rename")} data-tooltip={t("common.rename")}>
                    <Edit2 size={17} />
                  </button>
                  <button className="app-button app-button-danger app-icon-button" onClick={() => deleteDeck(deck)} aria-label={t("common.delete")} data-tooltip={t("common.delete")}>
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
        <div className="grid gap-3">
          {subsets.length === 0 ? (
            <div className="app-muted rounded-xl border border-dashed border-[color:var(--border-default)] bg-[var(--subpanel-bg)] p-4">{t("decks.noSubsets")}</div>
          ) : null}
          {subsets.map((subset) => (
            <article key={subset.id} className="app-panel px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="app-heading truncate font-semibold">{subset.name}</h3>
                  <p className="app-muted text-sm">{subset.wordIds.length} {t("decks.selectedWords")}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button className="app-button app-button-secondary app-icon-button" onClick={() => editSubset(subset)} aria-label={t("common.edit")} data-tooltip={t("common.edit")}>
                    <Edit2 size={17} />
                  </button>
                  <button className="app-button app-button-danger app-icon-button" onClick={() => deleteSubset(subset)} aria-label={t("common.delete")} data-tooltip={t("common.delete")}>
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
  usage: TranslationUsage | null;
  onRefresh: () => Promise<void>;
  onStatus: (message: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const backupMergeInputRef = useRef<HTMLInputElement>(null);
  const backupReplaceInputRef = useRef<HTMLInputElement>(null);
  const csvImportInputRef = useRef<HTMLInputElement>(null);
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
    const confirmed = await confirm({
      title: t("setup.delete"),
      message: setup.name,
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      variant: "danger"
    });
    if (!confirmed) {
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
    const confirmed = await confirm({
      title: t("settings.resetAll"),
      message: t("settings.resetWarning"),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      variant: "danger"
    });
    if (!confirmed) {
      return;
    }

    await resetAllLocalData();
    localStorage.removeItem(activeProfileStorageKey);
    await onRefresh();
  }

  async function exportBackup() {
    const [allProfiles, allSetups, allDecks, allWords, allSubsets, allCards, allUsage] = await Promise.all([
      db.profiles.toArray(),
      db.learningSetups.toArray(),
      db.decks.toArray(),
      db.words.toArray(),
      db.subsets.toArray(),
      db.cards.toArray(),
      db.translationUsage.toArray()
    ]);

    downloadTextFile(
      "lexora-backup.json",
      createBackupExport(allProfiles, allSetups, allDecks, allWords, allSubsets, allCards, allUsage),
      "application/json"
    );
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>, mode: "merge" | "replace") {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    if (mode === "replace") {
      const confirmed = await confirm({
        title: t("settings.importBackupReplace"),
        message: t("settings.importBackupReplaceWarning"),
        confirmLabel: t("settings.importBackupReplace"),
        cancelLabel: t("common.cancel"),
        variant: "danger"
      });
      if (!confirmed) {
        return;
      }
    }

    try {
      const backup = parseLexoraBackup(await file.text());
      await db.transaction("rw", [db.profiles, db.learningSetups, db.decks, db.words, db.subsets, db.cards, db.translationUsage], async () => {
        if (mode === "replace") {
          await Promise.all([
            db.profiles.clear(),
            db.learningSetups.clear(),
            db.decks.clear(),
            db.words.clear(),
            db.subsets.clear(),
            db.cards.clear(),
            db.translationUsage.clear()
          ]);
        }

        await Promise.all([
          backup.profiles.length ? db.profiles.bulkPut(backup.profiles) : Promise.resolve(),
          backup.learningSetups.length ? db.learningSetups.bulkPut(backup.learningSetups) : Promise.resolve(),
          backup.decks.length ? db.decks.bulkPut(backup.decks) : Promise.resolve(),
          backup.words.length ? db.words.bulkPut(backup.words) : Promise.resolve(),
          backup.subsets.length ? db.subsets.bulkPut(backup.subsets) : Promise.resolve(),
          backup.cards.length ? db.cards.bulkPut(backup.cards) : Promise.resolve(),
          backup.translationUsage.length ? db.translationUsage.bulkPut(backup.translationUsage) : Promise.resolve()
        ]);
      });

      localStorage.setItem(activeProfileStorageKey, backup.profiles[0].id);
      onStatus(t("status.imported", { count: backup.words.length }));
      await onRefresh();
    } catch {
      onStatus(t("status.importFailed"));
    }
  }

  async function importCsvWords(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !activeSetup) {
      return;
    }

    try {
      const importedRows = parseWordCsv(await file.text());
      const timestamp = nowIso();
      const existingDecks = await db.decks.where("learningSetupId").equals(activeSetup.id).toArray();
      const defaultDeck = existingDecks[0] ?? (await ensureDefaultDeck(profile.id, activeSetup.id, activeSetup.baseLanguage));
      const decksByName = new Map(existingDecks.map((deck) => [deck.name.trim().toLocaleLowerCase(), deck]));
      decksByName.set(defaultDeck.name.trim().toLocaleLowerCase(), defaultDeck);

      const newDecks: Deck[] = [];
      const deckForName = (name: string): Deck => {
        const normalized = name.trim().toLocaleLowerCase();
        if (!normalized) {
          return defaultDeck;
        }

        const existing = decksByName.get(normalized);
        if (existing) {
          return existing;
        }

        const deck: Deck = {
          id: createId("deck"),
          profileId: profile.id,
          learningSetupId: activeSetup.id,
          name: name.trim(),
          createdAt: timestamp,
          updatedAt: timestamp
        };
        decksByName.set(normalized, deck);
        newDecks.push(deck);
        return deck;
      };

      const existingWords = await db.words.where("learningSetupId").equals(activeSetup.id).toArray();
      const existingTargets = new Set(existingWords.map((word) => word.targetText.trim().toLocaleLowerCase()));
      const importedWords: WordEntry[] = [];

      for (const row of importedRows) {
        const normalizedTarget = row.targetText.trim().toLocaleLowerCase();
        if (existingTargets.has(normalizedTarget)) {
          continue;
        }

        existingTargets.add(normalizedTarget);
        const deck = deckForName(row.deckName);
        importedWords.push({
          id: createId("word"),
          profileId: profile.id,
          learningSetupId: activeSetup.id,
          deckId: deck.id,
          targetText: row.targetText,
          translations: row.translations,
          notes: row.notes,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      }

      const importedCards = importedWords.flatMap((word) => cardDirections.map((direction) => createInitialCardState(word, direction, timestamp)));
      await db.transaction("rw", [db.decks, db.words, db.cards], async () => {
        if (newDecks.length > 0) {
          await db.decks.bulkAdd(newDecks);
        }
        if (importedWords.length > 0) {
          await db.words.bulkAdd(importedWords);
          await db.cards.bulkAdd(importedCards);
        }
      });

      onStatus(t("status.imported", { count: importedWords.length }));
      await onRefresh();
    } catch {
      onStatus(t("status.importFailed"));
    }
  }

  return (
    <section className="grid min-w-0 gap-4">
      <ViewTitle title={t("settings.title")} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <form className="app-panel grid min-w-0 gap-3 p-4" onSubmit={createAdditionalProfile}>
          <h2 className="app-heading text-base font-semibold">{t("profile.createAnother")}</h2>
          <Label text={t("profile.name")}>
            <input className="app-input" value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} placeholder={t("profile.namePlaceholder")} />
          </Label>
          <p className="app-muted text-sm">{profiles.length} {t("profile.switch")}</p>
          <button className="app-button app-button-primary w-fit" type="submit" data-tooltip={t("profile.createAnother")}>
            <Plus size={18} />
            {t("common.create")}
          </button>
        </form>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <form className="app-panel grid min-w-0 gap-3 p-4" onSubmit={createSetup}>
          <h2 className="app-heading text-base font-semibold">{t("setup.create")}</h2>
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
          <button className="app-button app-button-primary w-fit" type="submit" data-tooltip={t("setup.create")}>
            <Plus size={18} />
            {t("common.create")}
          </button>
        </form>

        <div className="app-panel grid min-w-0 gap-3 p-4">
          <h2 className="app-heading text-base font-semibold">{t("setup.title")}</h2>
          {learningSetups.map((setup) => (
            <div key={setup.id} className="app-subpanel grid min-w-0 gap-3 p-3">
              <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-semibold">
                    <FlagIcon code={setup.targetLanguage} />
                    <span className="truncate">{learningSetupDisplayName(setup, i18n.language)}</span>
                  </p>
                  <p className="app-muted mt-1 flex min-w-0 items-center gap-1 text-sm">
                    <span>{t("setup.baseShort")}:</span>
                    <FlagIcon code={setup.baseLanguage} />
                    <span className="truncate">{languageOptionLabel(setup.baseLanguage, i18n.language)}</span>
                  </p>
                </div>
                <div className="setup-actions">
                  <button className="app-button app-button-secondary app-icon-button" onClick={() => renameSetup(setup)} aria-label={t("common.rename")} data-tooltip={t("common.rename")}>
                    <Edit2 size={17} />
                  </button>
                  <button
                    className="app-button app-button-secondary"
                    onClick={() => beginLanguageEdit(setup)}
                    disabled={(setupWordCounts[setup.id] ?? 0) > 0}
                    data-tooltip={(setupWordCounts[setup.id] ?? 0) > 0 ? t("setup.languagesLocked") : t("setup.editLanguages")}
                  >
                    {t("setup.editLanguages")}
                  </button>
                  <button
                    className="app-button app-button-danger app-icon-button"
                    onClick={() => removeSetup(setup)}
                    aria-label={t("common.delete")}
                    disabled={learningSetups.length <= 1}
                    data-tooltip={learningSetups.length <= 1 ? t("setup.keepOne") : t("setup.delete")}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
              {editingSetupLanguagesId === setup.id ? (
        <div className="app-subpanel grid min-w-0 gap-3 p-3">
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
                    <button className="app-button app-button-primary" onClick={() => saveSetupLanguages(setup)} data-tooltip={t("common.save")}>
                      {t("common.save")}
                    </button>
                    <button className="app-button app-button-ghost" onClick={() => setEditingSetupLanguagesId(null)} data-tooltip={t("common.cancel")}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="app-panel grid min-w-0 gap-3 p-4">
        <h2 className="app-heading text-base font-semibold">{t("settings.data")}</h2>
        <p className="app-muted text-sm">{t("settings.importHelp")}</p>
        <input
          ref={backupMergeInputRef}
          className="hidden"
          type="file"
          accept="application/json,.json"
          onChange={(event) => void importBackup(event, "merge")}
        />
        <input
          ref={backupReplaceInputRef}
          className="hidden"
          type="file"
          accept="application/json,.json"
          onChange={(event) => void importBackup(event, "replace")}
        />
        <input
          ref={csvImportInputRef}
          className="hidden"
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => void importCsvWords(event)}
        />
        <div className="settings-actions">
          <button className="app-button app-button-secondary" onClick={() => void exportBackup()} data-tooltip={t("settings.exportBackup")}>
            <Download size={18} />
            {t("settings.exportBackup")}
          </button>
          <button className="app-button app-button-secondary" onClick={() => backupMergeInputRef.current?.click()} data-tooltip={t("settings.importBackupMergeHint")}>
            <Plus size={18} />
            {t("settings.importBackupMerge")}
          </button>
          <button className="app-button app-button-secondary" onClick={() => backupReplaceInputRef.current?.click()} data-tooltip={t("settings.importBackupReplaceHint")}>
            <RotateCcw size={18} />
            {t("settings.importBackupReplace")}
          </button>
          <button className="app-button app-button-secondary" onClick={() => csvImportInputRef.current?.click()} disabled={!activeSetup} data-tooltip={t("settings.importCsvHint")}>
            <Plus size={18} />
            {t("settings.importCsv")}
          </button>
          <button
            className="app-button app-button-secondary"
            onClick={() => downloadTextFile("lexora-export.csv", createCsvExport(words, decks), "text/csv")}
            data-tooltip={t("library.exportCsv")}
          >
            <Download size={18} />
            {t("library.exportCsv")}
          </button>
          <button className="app-button app-button-danger" onClick={resetData} data-tooltip={t("settings.resetWarning")}>
            <Trash2 size={18} />
            {t("settings.resetAll")}
          </button>
        </div>
        <div className="app-muted grid min-w-0 gap-2 text-xs leading-relaxed md:grid-cols-3">
          <p className="app-subpanel p-2">
            <span className="app-label font-semibold">{t("settings.importBackupMerge")}:</span> {t("settings.importBackupMergeHint")}
          </p>
          <p className="app-subpanel p-2">
            <span className="app-label font-semibold">{t("settings.importBackupReplace")}:</span> {t("settings.importBackupReplaceHint")}
          </p>
          <p className="app-subpanel p-2">
            <span className="app-label font-semibold">{t("settings.importCsv")}:</span> {t("settings.importCsvHint")}
          </p>
        </div>
      </div>

      <div className="app-warning rounded-xl border p-4">
        <h2 className="text-base font-semibold">{t("settings.usage")}</h2>
        <p className="mt-1 text-sm">
          {usage?.count ?? 0} / {myMemoryDailyLimit} {t("common.today")}
        </p>
      </div>
    </section>
  );
}

function UsageBadge({ usage, compact = false }: { usage: TranslationUsage | null; compact?: boolean }) {
  const { t } = useTranslation();
  const tooltipId = useId();
  const count = usage?.count ?? 0;
  const remaining = Math.max(0, myMemoryDailyLimit - count);
  const percent = Math.min(100, Math.round((count / myMemoryDailyLimit) * 100));

  return (
    <div
      className={`app-warning usage-badge w-full min-w-0 rounded-xl border px-3 py-2 text-sm ${compact ? "status-badge-compact" : ""}`}
      tabIndex={0}
      aria-describedby={tooltipId}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 font-semibold">
        {compact ? (
          <span className="usage-badge-icon" aria-label={t("settings.usage")}>
            <Gauge size={15} />
          </span>
        ) : (
          <span className="usage-badge-label">{t("settings.usage")}</span>
        )}
        <span className="shrink-0">{percent}%</span>
      </div>
      <div className="usage-progress mt-1 h-1.5 overflow-hidden rounded-full">
        <div className="usage-progress-fill h-full transition-all duration-500" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1 text-xs opacity-75">{remaining} {t("settings.requestsRemaining")}</p>
      <span id={tooltipId} className="tooltip-bubble" role="tooltip">
        <span className="tooltip-title">{t("settings.usage")}</span>
        <span>{count} / {myMemoryDailyLimit} {t("common.today")}</span>
        <span>{remaining} {t("settings.requestsRemaining")}</span>
      </span>
    </div>
  );
}

function ConnectionBadge({ online, compact = false }: { online: boolean; compact?: boolean }) {
  const { t } = useTranslation();

  return (
    <div
      className={`w-full min-w-0 rounded-xl border px-3 py-2 text-sm font-semibold ${compact ? "status-badge-compact" : ""} ${
        online ? "app-success" : "app-danger-surface"
      }`}
      role="status"
      aria-live="polite"
      data-tooltip={online ? t("connection.onlineDetail") : t("connection.offlineDetail")}
    >
      <span className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" : "bg-rose-400"}`} aria-hidden="true" />
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
      <span className="app-label text-sm font-semibold">{t("study.direction")}</span>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("study.direction")}>
        {options.map((option) => (
          <button
            key={option.value}
            className={`app-button min-w-0 px-2 ${option.value === value ? "app-button-primary" : "app-button-secondary"}`}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            aria-label={option.label}
            data-tooltip={option.label}
            onClick={() => onChange(option.value)}
          >
            <span className="flex items-center justify-center gap-1">{option.flags}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DueStatus({ count }: { count: number }) {
  const { t } = useTranslation();

  return (
    <div className="due-status" data-tooltip={t("study.dueHint")} tabIndex={0}>
      <span className="app-subtle text-xs font-semibold uppercase tracking-wide">{t("common.due")}</span>
      <span className="app-heading text-lg font-bold">{count}</span>
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
      <span className="app-label mb-1 block text-sm font-semibold">{label}</span>
      <button
        className="app-input flex min-h-10 min-w-0 items-center justify-between gap-3 text-left"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={selectedLabel}
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
          className="app-panel absolute z-40 mt-1 max-h-72 w-full overflow-auto p-1"
          role="listbox"
        >
          {availableCodes.map((code) => (
            <button
              key={code}
              className={`dropdown-option flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
                code === value ? "dropdown-option-active" : ""
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

function CompactLanguageSelect({
  label,
  value,
  onChange,
  iconOnly = false
}: {
  label?: string;
  value: LanguageCode;
  onChange: (value: LanguageCode) => void;
  iconOnly?: boolean;
}) {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, languageCodes.findIndex((code) => code === value));

  function selectByIndex(index: number) {
    const next = languageCodes[index];
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
      selectByIndex(languageCodes.length - 1);
      return;
    }

    const offset = event.key === "ArrowDown" ? 1 : -1;
    selectByIndex((selectedIndex + offset + languageCodes.length) % languageCodes.length);
  }

  return (
    <div className="relative grid min-w-0 gap-1" onBlur={() => window.setTimeout(() => setOpen(false), 100)}>
      {label && !iconOnly ? <span className="app-label text-sm font-semibold">{label}</span> : null}
      <button
        className={`${
          iconOnly
            ? "app-icon-select"
            : "app-input app-input-compact flex min-h-9 min-w-0 items-center justify-between gap-2 text-left"
        }`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={languageOptionLabel(value, i18n.language)}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span className="flex min-w-0 items-center gap-2">
          <FlagIcon code={value} />
          {iconOnly ? null : <span className="truncate">{languageOptionLabel(value, i18n.language)}</span>}
        </span>
        <ChevronRight className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} size={iconOnly ? 14 : 15} />
      </button>
      {open ? (
        <div
          className={`app-panel absolute top-full z-40 mt-1 max-h-64 overflow-auto p-1 ${
            iconOnly ? "right-0 w-56" : "w-full"
          }`}
          role="listbox"
        >
          {languageCodes.map((code) => (
            <button
              key={code}
              className={`dropdown-option flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
                code === value ? "dropdown-option-active" : ""
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

function ThemeToggle({
  value,
  onChange,
  compact = false
}: {
  value: ThemeMode;
  onChange: (value: ThemeMode) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const nextTheme = value === "dark" ? "light" : "dark";

  return (
    <div className={compact ? "min-w-0" : "grid min-w-0 gap-1"}>
      {compact ? null : <span className="app-label text-sm font-semibold">{t("settings.theme")}</span>}
      <button
        className={`theme-toggle ${compact ? "theme-toggle-compact" : ""}`}
        type="button"
        role="switch"
        aria-checked={value === "dark"}
        data-tooltip={value === "dark" ? t("settings.themeDark") : t("settings.themeLight")}
        onClick={() => onChange(nextTheme)}
      >
        <span className="theme-toggle-track" aria-hidden="true">
          <span className="theme-toggle-thumb">
          {value === "dark" ? <Moon size={14} /> : <Sun size={14} />}
        </span>
      </span>
        {compact ? null : <span className="theme-toggle-label">
          {value === "dark" ? t("settings.themeDark") : t("settings.themeLight")}
        </span>}
      </button>
    </div>
  );
}

function ChromePreferences({
  uiLanguage,
  theme,
  onLanguageChange,
  onThemeChange
}: {
  uiLanguage: LanguageCode;
  theme: ThemeMode;
  onLanguageChange: (value: LanguageCode) => void;
  onThemeChange: (value: ThemeMode) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="chrome-preferences" aria-label={t("settings.preferences")}>
      <CompactLanguageSelect
        label={t("profile.uiLanguage")}
        value={uiLanguage}
        onChange={onLanguageChange}
        iconOnly
      />
      <ThemeToggle value={theme} onChange={onThemeChange} compact />
    </div>
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
      <span className="app-subtle mb-1 block text-xs font-semibold uppercase tracking-wide">{label}</span>
      <button
        className="app-input flex min-h-10 min-w-0 items-center justify-between gap-3 text-left"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={selected ? `${learningSetupDisplayName(selected, locale)} · ${setupBaseContext(selected.baseLanguage, locale, t("setup.baseShort"))}` : label}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected ? <FlagIcon code={selected.targetLanguage} /> : null}
          <span className="min-w-0">
            <span className="block truncate">{selected ? learningSetupDisplayName(selected, locale) : ""}</span>
            {selected ? (
              <span className="app-subtle flex items-center gap-1 truncate text-xs font-semibold">
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
          className="app-panel absolute z-40 mt-1 max-h-72 w-full overflow-auto p-1"
          role="listbox"
        >
          {setups.map((setup) => (
            <button
              key={setup.id}
              className={`dropdown-option flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
                setup.id === value ? "dropdown-option-active" : ""
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
                <span className="app-subtle flex min-w-0 items-center gap-1 text-xs font-normal">
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

function currentNavLabel(view: ViewKey, t: (key: string) => string): string {
  const labels: Record<ViewKey, string> = {
    study: t("nav.study"),
    library: t("nav.library"),
    decks: t("nav.decks"),
    settings: t("nav.settings")
  };

  return labels[view];
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

function defaultRatingForMatch(match: MatchResult, closeAccepted: boolean): ReviewRating {
  if (match === "correct") {
    return "good";
  }

  if (match === "close" && closeAccepted) {
    return "hard";
  }

  return "again";
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

function normalizeDuplicateText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
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
