import {
  BookOpen,
  Check,
  ChevronLeft,
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
import { FormEvent, ChangeEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
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
  defaultDeckNames,
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
  type LexoraBackup,
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
import { cloudBackupAuthorizationStorageKey, type CloudBackupFile, createGoogleDriveBackupProvider } from "./lib/cloudBackup";

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
const cloudFolderStorageKey = "lexora.cloud.folderPath";
const cloudAutoBackupStorageKey = "lexora.cloud.autoBackup";
const defaultCloudBackupFolder = "Lexora/Backups";
const latestCloudBackupFilename = "lexora-backup-latest.json";
const libraryPageSizeOptions = [10, 25, 50, 100];

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
  const autoBackupInitializedRef = useRef(false);
  const autoBackupTimerRef = useRef<number | null>(null);
  const googleDriveProvider = useMemo(
    () => createGoogleDriveBackupProvider(import.meta.env.VITE_GOOGLE_CLIENT_ID),
    []
  );

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;
  const activeSetup =
    learningSetups.find((setup) => setup.id === activeProfile?.activeLearningSetupId) ?? learningSetups[0] ?? null;
  const autoBackupSignature = useMemo(
    () => [
      collectionSignature(profiles),
      collectionSignature(learningSetups),
      collectionSignature(decks),
      collectionSignature(words),
      collectionSignature(subsets),
      collectionSignature(cards)
    ].join("|"),
    [cards, decks, learningSetups, profiles, subsets, words]
  );

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

  useEffect(() => {
    if (loading) {
      return;
    }

    if (!autoBackupInitializedRef.current) {
      autoBackupInitializedRef.current = true;
      return;
    }

    if (
      localStorage.getItem(cloudAutoBackupStorageKey) !== "true" ||
      !isOnline ||
      localStorage.getItem(cloudBackupAuthorizationStorageKey) !== "true"
    ) {
      return;
    }

    if (autoBackupTimerRef.current) {
      window.clearTimeout(autoBackupTimerRef.current);
    }

    autoBackupTimerRef.current = window.setTimeout(() => {
      autoBackupTimerRef.current = null;
      void createCurrentBackupExport()
        .then((contents) => googleDriveProvider.uploadBackup(
          localStorage.getItem(cloudFolderStorageKey) ?? defaultCloudBackupFolder,
          latestCloudBackupFilename,
          contents
        ))
        .then(() => setStatus(t("cloud.autoBackupSaved")))
        .catch(() => {
          if (!googleDriveProvider.isConnected()) {
            localStorage.removeItem(cloudBackupAuthorizationStorageKey);
          }
          setStatus(t("cloud.autoBackupSkipped"));
        });
    }, 2500);

    return () => {
      if (autoBackupTimerRef.current) {
        window.clearTimeout(autoBackupTimerRef.current);
        autoBackupTimerRef.current = null;
      }
    };
  }, [autoBackupSignature, googleDriveProvider, isOnline, loading, t]);

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
        <div className="app-chip gap-3 px-4 py-2">
          <span>Lexora</span>
          <LoadingIndicator label="Loading Lexora" />
        </div>
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
        <div className="mx-auto grid max-w-7xl gap-2 px-3 py-2 sm:gap-3 sm:px-6 sm:py-3">
          <div className="desktop-top-row">
            <div className="flex min-w-0 items-center gap-3">
              <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-9 w-9 shrink-0 drop-shadow-[0_0_8px_rgba(99,102,241,0.6)] sm:h-11 sm:w-11" />
              <div className="min-w-0">
                <h1 className="app-heading text-lg font-bold tracking-tight sm:text-xl">Lexora</h1>
                <p className="app-muted hidden truncate text-sm sm:block">{t("app.tagline")}</p>
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
                <AppSelect
                  value={activeProfile.id}
                  ariaLabel={t("profile.switch")}
                  tooltip={t("profile.switch")}
                  options={profiles.map((profile) => ({ value: profile.id, label: profile.name, textValue: profile.name }))}
                  onChange={(profileId) => {
                    setActiveProfileId(profileId);
                    void refreshAll(profileId);
                  }}
                />
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
        <div className="mx-auto max-w-7xl px-3 sm:px-6">
          <div className="flex min-h-11 items-center justify-between gap-2 sm:hidden">
            <div className="min-w-0 shrink">
              <span className="app-heading block text-sm font-semibold">{currentNavLabel(view, t)}</span>
            </div>
            {activeSetup ? (
              <span
                className="mobile-active-language"
                data-tooltip={`${learningSetupDisplayName(activeSetup, activeProfile.uiLanguage)} · ${t("setup.baseShort")}: ${languageOptionLabel(activeSetup.baseLanguage, activeProfile.uiLanguage)}`}
              >
                <FlagIcon code={activeSetup.targetLanguage} />
                <span className="truncate">{learningSetupDisplayName(activeSetup, activeProfile.uiLanguage)}</span>
              </span>
            ) : null}
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
            className="app-mobile-drawer app-glass absolute inset-y-0 right-0 flex w-[min(22rem,calc(100vw-0.5rem))] max-w-full flex-col overflow-y-auto p-3 shadow-2xl"
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
                  <AppSelect
                    value={activeProfile.id}
                    ariaLabel={t("profile.switch")}
                    tooltip={t("profile.switch")}
                    options={profiles.map((profile) => ({ value: profile.id, label: profile.name, textValue: profile.name }))}
                    onChange={(profileId) => {
                      setActiveProfileId(profileId);
                      void refreshAll(profileId);
                      setMobileMenuOpen(false);
                    }}
                  />
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

      <main className="mx-auto max-w-7xl px-3 py-3 sm:px-6 sm:py-6">
        <div key={`${view}-${activeSetup?.id ?? "none"}`} className="app-view-transition">
          {!activeSetup && view !== "settings" ? (
            <SetupRequired profile={activeProfile} onCreated={() => refreshAll(activeProfile.id)} />
          ) : null}
          {view === "study" && activeSetup ? (
            <StudyView
              profile={activeProfile}
              setup={activeSetup}
              decks={decks}
              words={words}
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
              cloudProvider={googleDriveProvider}
              online={isOnline}
              onRefresh={refreshAll}
              onStatus={setStatus}
            />
          ) : null}
        </div>
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
  cards,
  onRefresh
}: {
  profile: Profile;
  setup: LearningSetup;
  decks: Deck[];
  words: WordEntry[];
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
    const scopedWords = filterWordsByScope(activePairWords, scope);
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
      if (!isCoarsePointer()) {
        nextButtonRef.current?.focus();
      }
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
    const resultTone = !session.revealed
      ? "pending"
      : session.match === "correct" || (session.match === "close" && session.closeAccepted)
        ? "correct"
        : session.match === "close"
          ? "close"
          : "wrong";
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
          <div className={`study-card study-card-${resultTone} ${session.revealed ? "study-card-revealed" : ""}`}>
            <div className="study-card-inner">
              <div className="study-card-face study-card-front">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <span className="app-chip">{directionLabel(session.current.card.direction, t)}</span>
                  <span className="app-chip">{session.reviewed} {t("study.reviewed")}</span>
                </div>
                <div className="flex items-start justify-between gap-3">
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
              </div>
              <div className="study-card-face study-card-back">
                <div className="study-card-back-layout">
                  <div className="min-w-0">
                    <p className={`text-sm font-semibold ${resultLabelClass}`}>
                      {session.match === "correct" ? t("study.correctAnswer") : null}
                      {session.match === "close" ? t("study.closeAnswer") : null}
                      {session.match === "wrong" ? t("study.wrongAnswer") : null}
                    </p>
                    <p className="app-subtle mt-3 text-xs font-semibold">{directionLabel(session.current.card.direction, t)}</p>
                    <p className="app-muted mt-1 text-sm font-medium">{prompt}</p>
                    <p className="mt-2 text-sm font-semibold opacity-70">{t("study.reveal")}</p>
                    <p className="study-answer-reveal mt-1">{accepted.join(" / ")}</p>
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
                  <div className="study-rating-rail" aria-label={t("study.ratingHelp")}>
                    {ratings.map((rating) => (
                      <button
                        key={rating}
                        className={`app-button study-rating-button ${
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
                </div>
              </div>
            </div>
          </div>
          <Label text={t("study.answer")}>
            <input
              className="app-input text-lg"
              value={session.answer}
              onChange={(event) => {
                if (!session.revealed) {
                  setSession({ ...session, answer: event.target.value });
                }
              }}
              placeholder={t("study.answerPlaceholder")}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !session.revealed) {
                  event.preventDefault();
                  event.stopPropagation();
                  submitAnswer();
                } else if (event.key === "Enter" && session.revealed) {
                  event.preventDefault();
                  event.stopPropagation();
                  void advanceStudyCard();
                }
              }}
              ref={answerInputRef}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Label>
          {!session.revealed ? (
            <button className="app-button app-button-primary mt-4" onClick={submitAnswer} disabled={!session.answer.trim()} data-tooltip={t("study.submit")}>
              <Check size={18} />
              {t("study.submit")}
            </button>
          ) : (
            <div className="mt-5 grid gap-4">
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
          <ScopeSelect scope={scope} setScope={setScope} decks={decks} />
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
  const [form, setForm] = useState<WordFormState>(() => ({ ...emptyWordForm, deckId: preferredLibraryDeckId(decks, setup.baseLanguage) }));
  const [addWordPanelOpen, setAddWordPanelOpen] = useState(false);
  const [editingWord, setEditingWord] = useState<WordEntry | null>(null);
  const [editForm, setEditForm] = useState<WordFormState>({ ...emptyWordForm });
  const [editFormSubmitted, setEditFormSubmitted] = useState(false);
  const [suggestions, setSuggestions] = useState<TranslationResult[]>([]);
  const [fetching, setFetching] = useState(false);
  const [lastAutoSuggestedText, setLastAutoSuggestedText] = useState("");
  const [query, setQuery] = useState("");
  const [deckFilter, setDeckFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<ReviewStatus>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [wordPage, setWordPage] = useState(1);
  const [wordsPerPage, setWordsPerPage] = useState(10);
  const [wordFormSubmitted, setWordFormSubmitted] = useState(false);
  const translationLimitReached = (usage?.count ?? 0) >= myMemoryDailyLimit;
  const translationCount = usage?.count ?? 0;
  const translationRemaining = Math.max(0, myMemoryDailyLimit - translationCount);
  const translationQuotaPercent = Math.min(100, Math.round((translationCount / myMemoryDailyLimit) * 100));
  const duplicateWord = useMemo(() => {
    const candidate = normalizeDuplicateText(form.targetText);
    if (!candidate) {
      return undefined;
    }

    return words.find((word) => normalizeDuplicateText(word.targetText) === candidate);
  }, [form.targetText, words]);

  useEffect(() => {
    if (!decks.some((deck) => deck.id === form.deckId)) {
      setForm((current) => ({ ...current, deckId: preferredLibraryDeckId(decks, setup.baseLanguage) }));
    }
  }, [decks, form.deckId, setup.baseLanguage]);

  useEffect(() => {
    const text = form.targetText.trim();
    if (
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
  }, [fetching, form.targetText, form.translations, lastAutoSuggestedText, translationLimitReached]);

  const cardByWord = useMemo(() => groupCardsByWord(cards), [cards]);
  const filteredWords = useMemo(() => words.filter((word) => {
    const haystack = `${word.targetText} ${word.translations.join(" ")} ${word.notes}`.toLocaleLowerCase();
    const matchesQuery = !query || haystack.includes(query.toLocaleLowerCase());
    const matchesDeck = deckFilter === "all" || wordDeckIds(word).includes(deckFilter);
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
  const editTargetMissing = editFormSubmitted && !editForm.targetText.trim();
  const editTranslationsMissing = editFormSubmitted && splitTranslations(editForm.translations).length === 0;
  const editDuplicateWord = useMemo(() => {
    const candidate = normalizeDuplicateText(editForm.targetText);
    if (!candidate || !editingWord) {
      return undefined;
    }

    return words.find((word) => word.id !== editingWord.id && normalizeDuplicateText(word.targetText) === candidate);
  }, [editForm.targetText, editingWord, words]);

  useEffect(() => {
    setWordPage(1);
  }, [deckFilter, query, statusFilter, wordsPerPage]);

  useEffect(() => {
    setWordPage((current) => Math.min(current, wordPageCount));
  }, [wordPageCount]);

  const wordPager = filteredWords.length > 0 ? (
    <div className="flex items-center gap-2">
      <button
        className="app-button app-button-secondary app-icon-button"
        type="button"
        onClick={() => setWordPage((current) => Math.max(1, current - 1))}
        disabled={safeWordPage <= 1}
        aria-label={t("common.previous")}
        data-tooltip={t("common.previous")}
      >
        <ChevronLeft size={17} />
      </button>
      <span className="app-subtle min-w-12 text-center text-xs font-semibold">
        {safeWordPage} / {wordPageCount}
      </span>
      <button
        className="app-button app-button-secondary app-icon-button"
        type="button"
        onClick={() => setWordPage((current) => Math.min(wordPageCount, current + 1))}
        disabled={safeWordPage >= wordPageCount}
        aria-label={t("common.next")}
        data-tooltip={t("common.next")}
      >
        <ChevronRight size={17} />
      </button>
    </div>
  ) : null;

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
    const word: WordEntry = {
      id: createId("word"),
      profileId: profile.id,
      learningSetupId: setup.id,
      deckId: form.deckId,
      deckIds: [form.deckId],
      targetText: form.targetText.trim(),
      translations,
      notes: form.notes.trim(),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await db.words.add(word);
    await ensureCardsForWords([word]);

    setForm({ ...emptyWordForm, deckId: form.deckId });
    setSuggestions([]);
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

    await db.transaction("rw", db.words, db.cards, async () => {
      await db.words.delete(word.id);
      const wordCards = await db.cards.where("wordId").equals(word.id).toArray();
      await db.cards.bulkDelete(wordCards.map((card) => card.id));
    });
    onStatus(t("status.deleted"));
    await onRefresh();
  }

  function resetWordForm() {
    setForm({ ...emptyWordForm, deckId: form.deckId || preferredLibraryDeckId(decks, setup.baseLanguage) });
    setSuggestions([]);
    setWordFormSubmitted(false);
  }

  function editWord(word: WordEntry) {
    setEditingWord(word);
    setEditForm({
      targetText: word.targetText,
      translations: word.translations.join("; "),
      notes: word.notes,
      deckId: word.deckId
    });
    setEditFormSubmitted(false);
  }

  function closeEditModal() {
    setEditingWord(null);
    setEditForm({ ...emptyWordForm });
    setEditFormSubmitted(false);
  }

  async function updateWord(event: FormEvent) {
    event.preventDefault();
    if (!editingWord) {
      return;
    }

    setEditFormSubmitted(true);
    const translations = splitTranslations(editForm.translations);
    if (!editForm.targetText.trim() || translations.length === 0 || !editForm.deckId) {
      return;
    }

    if (editDuplicateWord) {
      const addDuplicate = await confirm({
        title: t("library.duplicateTitle"),
        message: t("library.duplicateBody", { word: editDuplicateWord.targetText }),
        confirmLabel: t("library.addDuplicate"),
        cancelLabel: t("common.cancel")
      });
      if (!addDuplicate) {
        return;
      }
    }

    await db.words.update(editingWord.id, {
      targetText: editForm.targetText.trim(),
      translations,
      notes: editForm.notes.trim(),
      deckId: editForm.deckId,
      deckIds: mergeDeckIds(editingWord.deckIds, editForm.deckId),
      updatedAt: nowIso()
    });
    closeEditModal();
    onStatus(t("status.saved"));
    await onRefresh();
  }

  return (
    <section className="grid gap-4">
      <ViewTitle title={t("library.title")} />
      <form className="app-panel grid gap-3 p-4" onSubmit={saveWord} noValidate>
        <button
          className="flex w-full items-center justify-between gap-3 rounded-xl px-1 py-1.5 text-left transition hover:bg-[var(--dropdown-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          type="button"
          aria-label={addWordPanelOpen ? t("common.collapse") : t("common.expand")}
          aria-expanded={addWordPanelOpen}
          onClick={() => setAddWordPanelOpen((open) => !open)}
          data-tooltip={addWordPanelOpen ? t("common.collapse") : t("common.expand")}
        >
          <span className="min-w-0">
            <h2 className="app-heading text-base font-semibold">{t("library.addWord")}</h2>
            <p className="app-subtle truncate text-xs">{decks.find((deck) => deck.id === form.deckId)?.name ?? defaultDeckNames[setup.baseLanguage]}</p>
          </span>
          <span className="library-panel-toggle pointer-events-none">
            <ChevronRight className={`shrink-0 transition-transform ${addWordPanelOpen ? "rotate-90" : ""}`} size={18} />
          </span>
        </button>

        {addWordPanelOpen ? (
          <div className="app-expand grid gap-3">
        <div className="flex items-center justify-end">
          <button className="app-button app-button-ghost app-button-compact" type="button" onClick={resetWordForm} data-tooltip={t("common.reset")}>
            {t("common.reset")}
          </button>
        </div>
        <div className="grid gap-2">
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
            {fetching ? <LoadingIndicator label={t("library.fetchSuggestions")} /> : <Search size={18} />}
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
        </div>

        <div className="library-capture-options">
          <AppSelect
            label={t("common.deck")}
            value={form.deckId}
            compact
            options={decks.map((deck) => ({ value: deck.id, label: deck.name, textValue: deck.name }))}
            onChange={(deckId) => setForm({ ...form, deckId })}
          />
          <Label text={`${t("common.notes")} (${t("common.optional")})`}>
            <textarea
              className="app-input library-note-input"
              value={form.notes}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
              placeholder={t("library.notesPlaceholder")}
              autoCapitalize="sentences"
            />
          </Label>
          <button className="app-button app-button-primary" type="submit" data-tooltip={t("common.add")}>
            <Plus size={18} />
            {t("common.add")}
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

          </div>
        ) : null}
      </form>

      {editingWord ? (
        <div className="modal-overlay" role="presentation">
          <form className="edit-word-modal" onSubmit={updateWord} noValidate role="dialog" aria-modal="true" aria-labelledby="edit-word-title">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="edit-word-title" className="app-heading text-lg font-bold">{t("common.edit")}</h2>
                <p className="app-subtle truncate text-xs">{editingWord.targetText}</p>
              </div>
              <button className="app-button app-button-secondary app-icon-button" type="button" onClick={closeEditModal} aria-label={t("common.cancel")} data-tooltip={t("common.cancel")}>
                <X size={17} />
              </button>
            </div>
            <Label
              text={
                <span className="flex items-center gap-1">
                  <FlagIcon code={setup.targetLanguage} />
                  {t("library.targetText")}
                </span>
              }
            >
              <input
                className={`app-input ${editDuplicateWord || editTargetMissing ? "app-input-warning" : ""}`}
                value={editForm.targetText}
                onChange={(event) => setEditForm({ ...editForm, targetText: event.target.value })}
                placeholder={t("library.targetPlaceholder")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={editTargetMissing}
                autoFocus
              />
              {editTargetMissing ? <span className="app-warning-text text-xs">{t("library.targetRequired")}</span> : null}
              {editDuplicateWord ? <span className="app-warning-text text-xs">{t("library.duplicateInline")}</span> : null}
            </Label>
            <Label
              text={
                <span className="flex items-center gap-1">
                  <FlagIcon code={setup.baseLanguage} />
                  {t("common.translations")}
                </span>
              }
            >
              <input
                className={`app-input ${editTranslationsMissing ? "app-input-warning" : ""}`}
                value={editForm.translations}
                onChange={(event) => setEditForm({ ...editForm, translations: event.target.value })}
                placeholder={t("library.translationHint")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={editTranslationsMissing}
              />
              {editTranslationsMissing ? <span className="app-warning-text text-xs">{t("library.translationsRequired")}</span> : null}
            </Label>
            <div className="grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
            <AppSelect
              label={t("common.deck")}
              value={editForm.deckId}
              options={decks.map((deck) => ({ value: deck.id, label: deck.name, textValue: deck.name }))}
              onChange={(deckId) => setEditForm({ ...editForm, deckId })}
            />
              <Label text={`${t("common.notes")} (${t("common.optional")})`}>
                <textarea
                  className="app-input min-h-20"
                  value={editForm.notes}
                  onChange={(event) => setEditForm({ ...editForm, notes: event.target.value })}
                  placeholder={t("library.notesPlaceholder")}
                />
              </Label>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button className="app-button app-button-ghost" type="button" onClick={closeEditModal}>
                {t("common.cancel")}
              </button>
              <button className="app-button app-button-primary" type="submit">
                {t("common.save")}
              </button>
            </div>
          </form>
        </div>
      ) : null}

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
          <div className="app-divider app-expand grid gap-3 border-t pt-3 md:grid-cols-2">
          <AppSelect
            label={t("common.deck")}
            value={deckFilter}
            options={[
              { value: "all", label: t("common.all"), textValue: t("common.all") },
              ...decks.map((deck) => ({ value: deck.id, label: deck.name, textValue: deck.name }))
            ]}
            onChange={setDeckFilter}
          />
          <AppSelect
            label={t("library.reviewStatus")}
            value={statusFilter}
            options={[
              { value: "all", label: t("common.all"), textValue: t("common.all") },
              { value: "due", label: t("common.due"), textValue: t("common.due") },
              { value: "new", label: t("common.new"), textValue: t("common.new") },
              { value: "learned", label: t("common.learned"), textValue: t("common.learned") }
            ]}
            onChange={(value) => setStatusFilter(value as ReviewStatus)}
          />
          </div>
        ) : null}
      </div>

      <div className="app-panel overflow-hidden">
        <div className="app-divider flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2.5">
          <div className="min-w-0">
            <div className="app-muted text-sm font-semibold">
              {filteredWords.length} / {words.length} {t("common.word")}
            </div>
            {filteredWords.length > 0 ? (
              <div className="app-subtle text-xs">
                {wordPageStart}-{wordPageEnd} · {t("library.page", { page: safeWordPage, pages: wordPageCount })}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="app-subtle flex items-center gap-2 text-xs font-semibold">
              <span className="sr-only">{t("library.pageSize")}</span>
              <div className="w-20">
              <AppSelect
                compact
                value={String(wordsPerPage)}
                ariaLabel={t("library.pageSize")}
                tooltip={t("library.pageSizeHint")}
                options={libraryPageSizeOptions.map((pageSize) => ({
                  value: String(pageSize),
                  label: String(pageSize),
                  textValue: String(pageSize)
                }))}
                onChange={(value) => setWordsPerPage(Number(value))}
              />
              </div>
            </div>
            {wordPager}
          </div>
        </div>
        {filteredWords.length === 0 ? (
          <div className="app-muted p-4">{t("library.noWords")}</div>
        ) : null}
        {pagedWords.length > 0 ? (
          <div className="library-card-grid">
            {pagedWords.map((word) => (
              <article key={word.id} className="library-word-card">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="app-subtle text-[0.64rem] font-semibold uppercase tracking-wide">{languageOptionLabel(setup.targetLanguage, profile.uiLanguage)}</p>
                    <h3 className="app-heading mt-0.5 text-base font-bold leading-snug">{word.targetText}</h3>
                    <p className="app-muted mt-0.5 text-xs font-semibold leading-snug">{word.translations.join(" / ")}</p>
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
                <div className="mt-2 flex flex-wrap gap-1">
                  {wordDeckIds(word).map((deckId) => (
                    <span key={deckId} className="app-chip">{decks.find((deck) => deck.id === deckId)?.name ?? t("common.deck")}</span>
                  ))}
                  <span className="app-chip">{formatLastReviewed(cardByWord.get(word.id), t("library.lastReviewed"), profile.uiLanguage)}</span>
                </div>
                {word.notes ? <p className="app-subtle mt-1.5 text-xs leading-relaxed">{word.notes}</p> : null}
              </article>
            ))}
          </div>
        ) : null}
        {wordPageCount > 1 ? (
          <div className="app-divider flex items-center justify-end gap-2 border-t px-3 py-2.5">
            {wordPager}
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
  onRefresh,
  onStatus
}: {
  profile: Profile;
  setup: LearningSetup;
  decks: Deck[];
  words: WordEntry[];
  onRefresh: () => Promise<void>;
  onStatus: (message: string) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [deckName, setDeckName] = useState("");
  const [createToolsOpen, setCreateToolsOpen] = useState(false);
  const [renamingDeck, setRenamingDeck] = useState<Deck | null>(null);
  const [renameDeckName, setRenameDeckName] = useState("");
  const [selectedWordIds, setSelectedWordIds] = useState<string[]>([]);
  const [deckWordSearch, setDeckWordSearch] = useState("");
  const filteredDeckWords = useMemo(() => {
    const query = deckWordSearch.trim().toLocaleLowerCase();
    if (!query) {
      return words;
    }

    return words.filter((word) => {
      const searchable = [word.targetText, word.translations.join(" "), word.notes].join(" ").toLocaleLowerCase();
      return searchable.includes(query);
    });
  }, [deckWordSearch, words]);

  async function addDeck(event: FormEvent) {
    event.preventDefault();
    if (!deckName.trim()) {
      return;
    }

    const timestamp = nowIso();
    const deck: Deck = {
      id: createId("deck"),
      profileId: profile.id,
      learningSetupId: setup.id,
      name: deckName.trim(),
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await db.transaction("rw", db.decks, db.words, async () => {
      await db.decks.add(deck);
      await Promise.all(
        selectedWordIds.map(async (wordId) => {
          const word = await db.words.get(wordId);
          if (!word) {
            return;
          }
          await db.words.update(wordId, {
            deckIds: mergeDeckIds(word.deckIds ?? [word.deckId], deck.id),
            updatedAt: timestamp
          });
        })
      );
    });
    setDeckName("");
    setSelectedWordIds([]);
    setDeckWordSearch("");
    onStatus(t("status.saved"));
    await onRefresh();
  }

  function renameDeck(deck: Deck) {
    setRenamingDeck(deck);
    setRenameDeckName(deck.name);
  }

  function closeDeckRenameModal() {
    setRenamingDeck(null);
    setRenameDeckName("");
  }

  async function submitDeckRename(event: FormEvent) {
    event.preventDefault();
    if (!renamingDeck || !renameDeckName.trim()) {
      return;
    }

    await db.decks.update(renamingDeck.id, { name: renameDeckName.trim(), updatedAt: nowIso() });
    closeDeckRenameModal();
    onStatus(t("status.saved"));
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

    const deckWords = words.filter((word) => wordDeckIds(word).includes(deck.id));
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

  function resetDeckCreation() {
    setDeckName("");
    setSelectedWordIds([]);
    setDeckWordSearch("");
  }

  return (
    <section className="grid gap-4">
      <ViewTitle title={t("decks.title")} />
      {renamingDeck ? (
        <RenameModal
          title={t("common.rename")}
          label={t("decks.deckName")}
          value={renameDeckName}
          placeholder={t("decks.deckNamePlaceholder")}
          description={renamingDeck.name}
          onChange={setRenameDeckName}
          onCancel={closeDeckRenameModal}
          onSubmit={submitDeckRename}
        />
      ) : null}
      <div className="app-panel grid gap-3 p-3">
        <button
          className="flex w-full items-center justify-between gap-3 rounded-xl px-1 py-1.5 text-left transition hover:bg-[var(--dropdown-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          type="button"
          aria-label={createToolsOpen ? t("common.collapse") : t("common.expand")}
          aria-expanded={createToolsOpen}
          onClick={() => setCreateToolsOpen((open) => !open)}
          data-tooltip={createToolsOpen ? t("common.collapse") : t("common.expand")}
        >
          <span className="min-w-0">
            <h2 className="app-heading text-sm font-semibold">{t("decks.createDeck")}</h2>
            <p className="app-subtle truncate text-xs">
              {selectedWordIds.length} {t("decks.selectedWords")}
            </p>
          </span>
          <span className="library-panel-toggle pointer-events-none">
            <ChevronRight className={`shrink-0 transition-transform ${createToolsOpen ? "rotate-90" : ""}`} size={18} />
          </span>
        </button>

        {createToolsOpen ? (
          <form className="app-expand app-subpanel grid gap-3 p-3" onSubmit={addDeck}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="app-heading text-sm font-semibold">{t("decks.createDeck")}</h3>
              <span className="app-chip">{selectedWordIds.length} {t("decks.selectedWords")}</span>
            </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <Label text={t("decks.deckName")}>
                  <input className="app-input app-input-compact" value={deckName} onChange={(event) => setDeckName(event.target.value)} placeholder={t("decks.deckNamePlaceholder")} />
                </Label>
                <button className="app-button app-button-primary app-button-compact w-fit" type="submit" disabled={!deckName.trim()} data-tooltip={t("decks.createDeck")}>
                  <Plus size={16} />
                  {t("decks.createDeck")}
                </button>
              </div>
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="app-heading text-sm font-semibold">{t("decks.selectWords")}</h3>
                  {selectedWordIds.length > 0 ? (
                    <button className="app-button app-button-ghost app-button-compact" type="button" onClick={resetDeckCreation} data-tooltip={t("common.reset")}>
                      {t("common.reset")}
                    </button>
                  ) : null}
                </div>
              <Label text={t("common.search")}>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={16} />
                  <input
                    className="app-input app-input-compact app-input-with-leading-icon"
                    value={deckWordSearch}
                    onChange={(event) => setDeckWordSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                      }
                    }}
                    placeholder={t("library.searchPlaceholder")}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
              </Label>
              <div className="app-subpanel max-h-64 overflow-auto p-1.5">
                {words.length === 0 ? <p className="app-muted p-2 text-sm">{t("library.noWords")}</p> : null}
                {words.length > 0 && filteredDeckWords.length === 0 ? <p className="app-muted p-2 text-sm">{t("library.noWords")}</p> : null}
                {filteredDeckWords.map((word) => (
                  <label key={word.id} className="deck-word-option">
                    <input
                      type="checkbox"
                      checked={selectedWordIds.includes(word.id)}
                      onChange={(event) => {
                        setSelectedWordIds((current) =>
                          event.target.checked ? [...current, word.id] : current.filter((wordId) => wordId !== word.id)
                        );
                      }}
                    />
                    <span className="min-w-0">
                      <span className="deck-word-option-target">{word.targetText}</span>
                      <span className="deck-word-option-translation">{word.translations.join(" / ")}</span>
                    </span>
                  </label>
                ))}
              </div>
              </div>
          </form>
        ) : null}
      </div>

      <div className="grid gap-3">
        <div className="grid gap-3">
          {decks.map((deck) => (
            <article key={deck.id} className="app-panel px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="app-heading truncate font-semibold">{deck.name}</h3>
                  <p className="app-muted text-sm">{words.filter((word) => wordDeckIds(word).includes(deck.id)).length} {t("common.word")}</p>
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
  cloudProvider,
  online,
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
  cloudProvider: ReturnType<typeof createGoogleDriveBackupProvider>;
  online: boolean;
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
  const [renamingSetup, setRenamingSetup] = useState<LearningSetup | null>(null);
  const [renameSetupName, setRenameSetupName] = useState("");
  const [editingSetupLanguagesId, setEditingSetupLanguagesId] = useState<string | null>(null);
  const [editingBaseLanguage, setEditingBaseLanguage] = useState<LanguageCode>(activeSetup?.baseLanguage ?? "de");
  const [editingTargetLanguage, setEditingTargetLanguage] = useState<LanguageCode>(activeSetup?.targetLanguage ?? "es");
  const [localBusy, setLocalBusy] = useState<"exportBackup" | "importBackupMerge" | "importBackupReplace" | "importCsv" | null>(null);
  const [cloudFolderPath, setCloudFolderPath] = useState(() =>
    localStorage.getItem(cloudFolderStorageKey) ?? defaultCloudBackupFolder
  );
  const [cloudAutoBackup, setCloudAutoBackup] = useState(() => localStorage.getItem(cloudAutoBackupStorageKey) === "true");
  const [cloudConnected, setCloudConnected] = useState(() =>
    localStorage.getItem(cloudBackupAuthorizationStorageKey) === "true" || cloudProvider.isConnected()
  );
  const [cloudBackups, setCloudBackups] = useState<CloudBackupFile[]>([]);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [lastCloudBackupAt, setLastCloudBackupAt] = useState<string | null>(null);
  const settingsBusy = Boolean(localBusy || cloudBusy);

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

  useEffect(() => {
    localStorage.setItem(cloudFolderStorageKey, cloudFolderPath);
  }, [cloudFolderPath]);

  useEffect(() => {
    localStorage.setItem(cloudAutoBackupStorageKey, cloudAutoBackup ? "true" : "false");
  }, [cloudAutoBackup]);

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

  function renameSetup(setup: LearningSetup) {
    setRenamingSetup(setup);
    setRenameSetupName(setup.name);
  }

  function closeSetupRenameModal() {
    setRenamingSetup(null);
    setRenameSetupName("");
  }

  async function submitSetupRename(event: FormEvent) {
    event.preventDefault();
    if (!renamingSetup || !renameSetupName.trim()) {
      return;
    }

    await db.learningSetups.update(renamingSetup.id, { name: renameSetupName.trim(), updatedAt: nowIso() });
    closeSetupRenameModal();
    onStatus(t("status.saved"));
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
    setLocalBusy("exportBackup");
    try {
      downloadTextFile("lexora-backup.json", await createCurrentBackupExport(), "application/json");
    } finally {
      setLocalBusy(null);
    }
  }

  async function confirmReplaceBackup(mode: "merge" | "replace"): Promise<boolean> {
    if (mode !== "replace") {
      return true;
    }

    return confirm({
      title: t("settings.importBackupReplace"),
      message: t("settings.importBackupReplaceWarning"),
      confirmLabel: t("settings.importBackupReplace"),
      cancelLabel: t("common.cancel"),
      variant: "danger"
    });
  }

  async function importBackupContents(contents: string, mode: "merge" | "replace") {
    if (!(await confirmReplaceBackup(mode))) {
      return;
    }

    try {
      const backup = parseLexoraBackup(contents);
      await applyBackupToLocalDb(backup, mode);
      localStorage.setItem(activeProfileStorageKey, backup.profiles[0].id);
      onStatus(t("status.imported", { count: backup.words.length }));
      await onRefresh();
    } catch {
      onStatus(t("status.importFailed"));
    }
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>, mode: "merge" | "replace") {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    setLocalBusy(mode === "merge" ? "importBackupMerge" : "importBackupReplace");
    try {
      await importBackupContents(await file.text(), mode);
    } finally {
      setLocalBusy(null);
    }
  }

  async function connectCloud() {
    if (!online) {
      onStatus(t("cloud.offline"));
      return;
    }

    if (!cloudProvider.isConfigured()) {
      onStatus(t("cloud.notConfigured"));
      return;
    }

    setCloudBusy(true);
    try {
      await cloudProvider.connect();
      localStorage.setItem(cloudBackupAuthorizationStorageKey, "true");
      setCloudConnected(true);
      onStatus(t("cloud.connected"));
      await refreshCloudBackups();
    } catch {
      onStatus(t("cloud.connectFailed"));
    } finally {
      setCloudBusy(false);
    }
  }

  function disconnectCloud() {
    cloudProvider.disconnect();
    localStorage.removeItem(cloudBackupAuthorizationStorageKey);
    setCloudConnected(false);
    setCloudBackups([]);
    onStatus(t("cloud.disconnected"));
  }

  async function refreshCloudBackups() {
    if (!online) {
      onStatus(t("cloud.offline"));
      return;
    }

    setCloudBusy(true);
    try {
      const backups = await cloudProvider.listBackups(cloudFolderPath);
      localStorage.setItem(cloudBackupAuthorizationStorageKey, "true");
      setCloudConnected(true);
      setCloudBackups(backups);
    } catch {
      if (!cloudProvider.isConnected()) {
        localStorage.removeItem(cloudBackupAuthorizationStorageKey);
        setCloudConnected(false);
      }
      onStatus(t("cloud.listFailed"));
    } finally {
      setCloudBusy(false);
    }
  }

  async function backupToCloud() {
    if (!online) {
      onStatus(t("cloud.offline"));
      return;
    }

    setCloudBusy(true);
    try {
      const contents = await createCurrentBackupExport();
      const snapshotName = `lexora-backup-${formatBackupTimestamp(new Date())}.json`;
      await cloudProvider.uploadBackup(cloudFolderPath, latestCloudBackupFilename, contents);
      await cloudProvider.uploadBackup(cloudFolderPath, snapshotName, contents);
      localStorage.setItem(cloudBackupAuthorizationStorageKey, "true");
      setCloudConnected(true);
      setLastCloudBackupAt(new Date().toISOString());
      onStatus(t("cloud.backupSaved"));
      await refreshCloudBackups();
    } catch {
      if (!cloudProvider.isConnected()) {
        localStorage.removeItem(cloudBackupAuthorizationStorageKey);
        setCloudConnected(false);
      }
      onStatus(t("cloud.backupFailed"));
    } finally {
      setCloudBusy(false);
    }
  }

  async function importCloudBackup(file: CloudBackupFile, mode: "merge" | "replace") {
    if (!online) {
      onStatus(t("cloud.offline"));
      return;
    }

    setCloudBusy(true);
    try {
      const contents = await cloudProvider.downloadBackup(file.id);
      localStorage.setItem(cloudBackupAuthorizationStorageKey, "true");
      setCloudConnected(true);
      await importBackupContents(contents, mode);
    } catch {
      onStatus(t("status.importFailed"));
    } finally {
      setCloudBusy(false);
    }
  }

  async function deleteCloudBackup(file: CloudBackupFile) {
    if (!online) {
      onStatus(t("cloud.offline"));
      return;
    }

    const confirmed = await confirm({
      title: t("cloud.deleteBackup"),
      message: `${t("common.confirmDelete")}\n\n${file.name}`,
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      variant: "danger"
    });
    if (!confirmed) {
      return;
    }

    setCloudBusy(true);
    try {
      await cloudProvider.deleteBackup(file.id);
      localStorage.setItem(cloudBackupAuthorizationStorageKey, "true");
      setCloudConnected(true);
      setCloudBackups((current) => current.filter((backup) => backup.id !== file.id));
      onStatus(t("status.deleted"));
    } catch {
      if (!cloudProvider.isConnected()) {
        localStorage.removeItem(cloudBackupAuthorizationStorageKey);
        setCloudConnected(false);
      }
      onStatus(t("cloud.deleteFailed"));
    } finally {
      setCloudBusy(false);
    }
  }

  async function importCsvWords(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !activeSetup) {
      return;
    }

    setLocalBusy("importCsv");
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
          deckIds: [deck.id],
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
    } finally {
      setLocalBusy(null);
    }
  }

  return (
    <section className="grid min-w-0 gap-4">
      <ViewTitle title={t("settings.title")} />
      {renamingSetup ? (
        <RenameModal
          title={t("common.rename")}
          label={t("setup.name")}
          value={renameSetupName}
          placeholder={setupNamePlaceholder(renamingSetup.baseLanguage, renamingSetup.targetLanguage, i18n.language, t)}
          description={learningSetupDisplayName(renamingSetup, i18n.language)}
          onChange={setRenameSetupName}
          onCancel={closeSetupRenameModal}
          onSubmit={submitSetupRename}
        />
      ) : null}
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
          <button className="app-button app-button-secondary" onClick={() => void exportBackup()} disabled={settingsBusy} data-tooltip={t("settings.exportBackup")}>
            {localBusy === "exportBackup" ? <LoadingIndicator label={t("settings.exportBackup")} /> : <Download size={18} />}
            {t("settings.exportBackup")}
          </button>
          <button className="app-button app-button-secondary" onClick={() => backupMergeInputRef.current?.click()} disabled={settingsBusy} data-tooltip={t("settings.importBackupMergeHint")}>
            {localBusy === "importBackupMerge" ? <LoadingIndicator label={t("settings.importBackupMerge")} /> : <Plus size={18} />}
            {t("settings.importBackupMerge")}
          </button>
          <button className="app-button app-button-secondary" onClick={() => backupReplaceInputRef.current?.click()} disabled={settingsBusy} data-tooltip={t("settings.importBackupReplaceHint")}>
            {localBusy === "importBackupReplace" ? <LoadingIndicator label={t("settings.importBackupReplace")} /> : <RotateCcw size={18} />}
            {t("settings.importBackupReplace")}
          </button>
          <button className="app-button app-button-secondary" onClick={() => csvImportInputRef.current?.click()} disabled={!activeSetup || settingsBusy} data-tooltip={t("settings.importCsvHint")}>
            {localBusy === "importCsv" ? <LoadingIndicator label={t("settings.importCsv")} /> : <Plus size={18} />}
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

      <div className="app-panel grid min-w-0 gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="app-heading text-base font-semibold">{t("cloud.title")}</h2>
            <p className="app-muted mt-1 text-sm">{t("cloud.body")}</p>
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${cloudConnected ? "app-success" : "app-warning"}`}>
            {cloudConnected ? t("cloud.connected") : t("cloud.notConnected")}
          </span>
        </div>

        <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Label text={t("cloud.folderPath")}>
            <input
              className="app-input"
              value={cloudFolderPath}
              onChange={(event) => setCloudFolderPath(event.target.value)}
              placeholder={defaultCloudBackupFolder}
            />
          </Label>
          <div className="flex flex-wrap gap-2">
            {cloudConnected ? (
              <button className="app-button app-button-secondary" type="button" onClick={disconnectCloud} disabled={cloudBusy}>
                {t("cloud.disconnect")}
              </button>
            ) : (
              <button className="app-button app-button-primary" type="button" onClick={() => void connectCloud()} disabled={cloudBusy || !online || !cloudProvider.isConfigured()}>
                {cloudBusy ? <LoadingIndicator label={t("cloud.connectGoogle")} /> : null}
                {t("cloud.connectGoogle")}
              </button>
            )}
            <button className="app-button app-button-secondary" type="button" onClick={() => void refreshCloudBackups()} disabled={cloudBusy || !online || !cloudConnected}>
              {cloudBusy ? <LoadingIndicator label={t("cloud.refresh")} /> : <RotateCcw size={18} />}
              {t("cloud.refresh")}
            </button>
          </div>
        </div>

        <label className="app-subpanel flex min-w-0 items-start gap-3 p-3 text-sm">
          <input
            className="mt-1"
            type="checkbox"
            checked={cloudAutoBackup}
            onChange={(event) => setCloudAutoBackup(event.target.checked)}
          />
          <span>
            <span className="app-label block font-semibold">{t("cloud.autoBackup")}</span>
            <span className="app-muted">{t("cloud.autoBackupHint")}</span>
          </span>
        </label>

        <div className="settings-actions">
          <button className="app-button app-button-primary" type="button" onClick={() => void backupToCloud()} disabled={cloudBusy || !online || !cloudProvider.isConfigured()}>
            {cloudBusy ? <LoadingIndicator label={t("cloud.backupNow")} /> : <Download size={18} />}
            {t("cloud.backupNow")}
          </button>
          {lastCloudBackupAt ? (
            <div className="app-subpanel flex items-center px-3 py-2 text-sm">
              {t("cloud.lastBackup", { date: new Date(lastCloudBackupAt).toLocaleString(i18n.language) })}
            </div>
          ) : null}
        </div>

        {!cloudProvider.isConfigured() ? <p className="app-danger-surface rounded-lg border px-3 py-2 text-sm">{t("cloud.notConfigured")}</p> : null}
        {!online ? <p className="app-danger-surface rounded-lg border px-3 py-2 text-sm">{t("cloud.offline")}</p> : null}

        <div className="app-subpanel overflow-hidden">
          <div className="app-divider flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
            <span className="app-label text-sm font-semibold">{t("cloud.backups")}</span>
            <span className="app-subtle inline-flex items-center gap-2 text-xs">
              {cloudBusy ? <LoadingIndicator label="Loading cloud backups" /> : null}
              {cloudBackups.length} {t("common.backups")}
            </span>
          </div>
          {cloudBackups.length === 0 ? <p className="app-muted p-3 text-sm">{t("cloud.noBackups")}</p> : null}
          {cloudBackups.map((backup) => (
            <div key={backup.id} className="app-divider grid gap-2 border-t px-3 py-2.5 first:border-t-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div className="min-w-0">
                <p className="app-heading truncate text-sm font-semibold">{backup.name}</p>
                <p className="app-subtle text-xs">{new Date(backup.modifiedTime).toLocaleString(i18n.language)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="app-button app-button-secondary app-button-compact" type="button" onClick={() => void importCloudBackup(backup, "merge")} disabled={cloudBusy || !online}>
                  {t("settings.importBackupMerge")}
                </button>
                <button className="app-button app-button-secondary app-button-compact" type="button" onClick={() => void importCloudBackup(backup, "replace")} disabled={cloudBusy || !online}>
                  {t("settings.importBackupReplace")}
                </button>
                <button
                  className="app-button app-button-danger app-icon-button"
                  type="button"
                  onClick={() => void deleteCloudBackup(backup)}
                  disabled={cloudBusy || !online}
                  aria-label={t("cloud.deleteBackup")}
                  data-tooltip={t("cloud.deleteBackup")}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            </div>
          ))}
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

function LoadingIndicator({ label }: { label: string }) {
  return (
    <span className="loading-indicator" role="status" aria-label={label}>
      <span />
      <span />
      <span />
    </span>
  );
}

function RenameModal({
  title,
  label,
  value,
  placeholder,
  description,
  onChange,
  onCancel,
  onSubmit
}: {
  title: string;
  label: string;
  value: string;
  placeholder?: string;
  description?: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const titleId = useId();

  return (
    <div className="modal-overlay" role="presentation">
      <form className="edit-word-modal" onSubmit={onSubmit} noValidate role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="app-heading text-lg font-bold">{title}</h2>
            {description ? <p className="app-subtle truncate text-xs">{description}</p> : null}
          </div>
          <button className="app-button app-button-secondary app-icon-button" type="button" onClick={onCancel} aria-label={t("common.cancel")} data-tooltip={t("common.cancel")}>
            <X size={17} />
          </button>
        </div>
        <Label text={label}>
          <input
            className="app-input"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            autoFocus
            required
          />
        </Label>
        <div className="flex flex-wrap justify-end gap-2">
          <button className="app-button app-button-ghost" type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="app-button app-button-primary" type="submit" disabled={!value.trim()}>
            {t("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

function preferredLibraryDeckId(decks: Deck[], baseLanguage: LanguageCode): string {
  const defaultName = defaultDeckNames[baseLanguage];
  return decks.find((deck) => deck.name === defaultName)?.id ?? decks[0]?.id ?? "";
}

function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
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

interface SelectOption {
  value: string;
  label: ReactNode;
  textValue: string;
}

function AppSelect({
  label,
  value,
  options,
  onChange,
  compact = false,
  ariaLabel,
  tooltip
}: {
  label?: ReactNode;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  compact?: boolean;
  ariaLabel?: string;
  tooltip?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selected?.value));

  function selectByIndex(index: number) {
    const next = options[index];
    if (next) {
      onChange(next.value);
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
    const lastIndex = options.length - 1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? lastIndex
          : event.key === "ArrowDown"
            ? Math.min(lastIndex, selectedIndex + 1)
            : Math.max(0, selectedIndex - 1);
    selectByIndex(nextIndex);
    setOpen(true);
  }

  const control = (
    <div className="relative min-w-0 max-w-full" onBlur={() => window.setTimeout(() => setOpen(false), 100)}>
      <button
        className={`app-input flex min-w-0 items-center justify-between gap-2 text-left ${compact ? "app-input-compact min-h-9" : "min-h-10"}`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-tooltip={open ? "" : tooltip}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span className="min-w-0 truncate">{selected?.label}</span>
        <ChevronRight className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} size={compact ? 15 : 16} />
      </button>
      <div
        className={`app-panel dropdown-panel absolute z-40 mt-1 max-h-72 w-full p-1 ${open ? "dropdown-panel-open" : ""}`}
        role="listbox"
        aria-hidden={!open}
      >
        {options.map((option) => (
          <button
            key={option.value}
            className={`dropdown-option flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm ${
              option.value === selected?.value ? "dropdown-option-active" : ""
            }`}
            type="button"
            role="option"
            aria-selected={option.value === selected?.value}
            tabIndex={open ? 0 : -1}
            onClick={() => {
              onChange(option.value);
              setOpen(false);
            }}
          >
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  if (!label) {
    return control;
  }

  return (
    <div className="app-label grid min-w-0 gap-1 text-sm font-semibold">
      <span>{label}</span>
      {control}
    </div>
  );
}

function ScopeSelect({
  scope,
  setScope,
  decks
}: {
  scope: ScopeSelection;
  setScope: (scope: ScopeSelection) => void;
  decks: Deck[];
}) {
  const { t } = useTranslation();
  const value = scope.type === "all" ? "all" : `deck:${scope.deckId}`;

  return (
    <AppSelect
      label={t("study.scope")}
      value={value}
      options={[
        { value: "all", label: t("common.all"), textValue: t("common.all") },
        ...decks.map((deck) => ({
          value: `deck:${deck.id}`,
          label: `${t("common.deck")}: ${deck.name}`,
          textValue: `${t("common.deck")}: ${deck.name}`
        }))
      ]}
      onChange={(next) => {
          if (next === "all") {
            setScope({ type: "all" });
          } else if (next.startsWith("deck:")) {
            setScope({ type: "deck", deckId: next.slice(5) });
          }
        }}
    />
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
        data-tooltip={open ? "" : selectedLabel}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span className="flex min-w-0 items-center gap-2">
          <FlagIcon code={value} />
          <span className="truncate">{selectedLabel}</span>
        </span>
        <ChevronRight className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} size={16} />
      </button>
      <div
        className={`app-panel dropdown-panel absolute z-40 mt-1 max-h-72 w-full overflow-auto p-1 ${
          open ? "dropdown-panel-open" : ""
        }`}
        role="listbox"
        aria-hidden={!open}
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
              tabIndex={open ? 0 : -1}
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
        data-tooltip={open ? "" : languageOptionLabel(value, i18n.language)}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span className="flex min-w-0 items-center gap-2">
          <FlagIcon code={value} />
          {iconOnly ? null : <span className="truncate">{languageOptionLabel(value, i18n.language)}</span>}
        </span>
        <ChevronRight className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} size={iconOnly ? 14 : 15} />
      </button>
      <div
        className={`app-panel dropdown-panel absolute top-full z-40 mt-1 max-h-64 overflow-auto p-1 ${
          iconOnly ? "right-0 w-56" : "w-full"
        } ${open ? "dropdown-panel-open" : ""}`}
        role="listbox"
        aria-hidden={!open}
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
              tabIndex={open ? 0 : -1}
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
        data-tooltip={open || !selected ? "" : `${learningSetupDisplayName(selected, locale)} · ${setupBaseContext(selected.baseLanguage, locale, t("setup.baseShort"))}`}
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
      <div
        className={`app-panel dropdown-panel absolute z-40 mt-1 max-h-72 w-full overflow-auto p-1 ${
          open ? "dropdown-panel-open" : ""
        }`}
        role="listbox"
        aria-hidden={!open}
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
              tabIndex={open ? 0 : -1}
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

function filterWordsByScope(words: WordEntry[], scope: ScopeSelection): WordEntry[] {
  if (scope.type === "all") {
    return words;
  }

  return words.filter((word) => wordDeckIds(word).includes(scope.deckId));
}

function wordDeckIds(word: WordEntry): string[] {
  return mergeDeckIds(word.deckIds, word.deckId);
}

function mergeDeckIds(deckIds: string[] | undefined, deckId: string): string[] {
  return Array.from(new Set([...(deckIds ?? []), deckId].filter(Boolean)));
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
  const generatedNames = generatedSetupNames(setup.baseLanguage, setup.targetLanguage, locale);

  return generatedNames.has(setup.name) ? friendlyName : `${setup.name} · ${friendlyName}`;
}

function generatedSetupNames(baseLanguage: LanguageCode, targetLanguage: LanguageCode, locale = "en"): Set<string> {
  const generatedNames = new Set([
    defaultSetupName(baseLanguage, targetLanguage, locale),
    defaultSetupName(baseLanguage, targetLanguage),
    `${targetLanguage.toUpperCase()} over ${baseLanguage.toUpperCase()}`,
    `${languageNames[targetLanguage]} over ${languageNames[baseLanguage]}`,
    `${languageNames[targetLanguage]} from ${languageNames[baseLanguage]}`
  ]);
  const generatedNameConnectors = ["from", "over", "mit", "от", "depuis", "da", "desde", "a partir de", "с"];

  for (const generatedLocale of languageCodes) {
    const targetName = localizedLanguageName(targetLanguage, generatedLocale);
    const baseName = localizedLanguageName(baseLanguage, generatedLocale);
    generatedNames.add(defaultSetupName(baseLanguage, targetLanguage, generatedLocale));
    for (const connector of generatedNameConnectors) {
      generatedNames.add(`${targetName} ${connector} ${baseName}`);
    }
  }

  return generatedNames;
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

async function createCurrentBackupExport(): Promise<string> {
  const [allProfiles, allSetups, allDecks, allWords, allSubsets, allCards, allUsage] = await Promise.all([
    db.profiles.toArray(),
    db.learningSetups.toArray(),
    db.decks.toArray(),
    db.words.toArray(),
    db.subsets.toArray(),
    db.cards.toArray(),
    db.translationUsage.toArray()
  ]);

  return createBackupExport(allProfiles, allSetups, allDecks, allWords, allSubsets, allCards, allUsage);
}

async function applyBackupToLocalDb(backup: LexoraBackup, mode: "merge" | "replace"): Promise<void> {
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
}

function formatBackupTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
}

function collectionSignature(items: Array<{ id: string; updatedAt?: string }>): string {
  return `${items.length}:${items.map((item) => `${item.id}:${item.updatedAt ?? ""}`).sort().join(",")}`;
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
