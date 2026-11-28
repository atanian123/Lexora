import {
  ArrowRight,
  BookOpen,
  Camera,
  Check,
  Cloud,
  FileDown,
  FileUp,
  ChevronRight,
  Download,
  Edit2,
  EqualApproximately,
  Gauge,
  House,
  Languages,
  Layers,
  MoreHorizontal,
  Plus,
  RotateCcw,
  ScanLine,
  Search,
  Settings,
  Moon,
  Sun,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  X
} from "lucide-react";
import { type ChangeEvent, type SubmitEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
  localizedLanguageName,
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
  findDefaultDeck,
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
import { AppSelect } from "./components/AppSelect";
import { LanguageBackdrop } from "./components/LanguageBackdrop";
import { Modal } from "./components/Modal";
import { FlagIcon, HeaderSelect, Label, NavButton } from "./components/ui";
import { VocabularyScanner } from "./components/VocabularyScanner";
import { normalizeDuplicateText, splitTranslations } from "./lib/vocabulary";
import {
  accentKeys,
  addDays,
  countDueBetween,
  dueForecast,
  formatInterval,
  greetings,
  secondsPerCard,
  startOfLocalDay,
  wordStrength
} from "./lib/progress";
import { canSpeak, speak } from "./lib/speech";
import { navigateToView, useBackDismiss } from "./lib/history";
import { trackRatingWrite, waitForPendingRatingWrites } from "./lib/pendingWrites";
import { closestAnswer, diffAnswer } from "./lib/answerDiff";
import { MobileTabBar } from "./components/MobileTabBar";
import { cloudBackupAuthorizationStorageKey, type CloudBackupFile, createGoogleDriveBackupProvider } from "./lib/cloudBackup";

type ViewKey = "study" | "library" | "decks" | "settings";
type ThemeMode = "light" | "dark";
type DeckSort = "newest" | "nameDescending" | "nameAscending";

const studyOutcomes = {
  correct: { label: "ui.correct", icon: Check },
  close: { label: "ui.almost", icon: EqualApproximately },
  wrong: { label: "ui.notQuite", icon: X },
  revealed: { label: "ui.answerRevealed", icon: BookOpen }
} as const;

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
  /** Identifies this session, so work that finishes after it was dismissed cannot revive it. */
  id: string;
  queue: StudyCard[];
  current?: StudyCard;
  reviewed: number;
  correct: number;
  /** Ids of cards rated Again at least once in this session. */
  again: string[];
  /** Each reviewed card with its latest rating and the schedule saved for it. */
  latest: Record<string, { item: StudyCard; rating: ReviewRating }>;
  answer: string;
  revealed: boolean;
  match?: MatchResult;
  closeAccepted: boolean;
  selectedRating?: ReviewRating;
}

const emptyWordForm: WordFormState = {
  targetText: "",
  translations: "",
  notes: "",
  deckId: ""
};

const themeStorageKey = "lexora.theme";
const deckSortStorageKey = "lexora.deckSort";
const cloudFolderStorageKey = "lexora.cloud.folderPath";
const cloudAutoBackupStorageKey = "lexora.cloud.autoBackup";
const defaultCloudBackupFolder = "Lexora/Backups";
const latestCloudBackupFilename = "lexora-backup-latest.json";
const libraryPageSize = 40;
const statusDurationMs = 5_000;

const viewKeys: ViewKey[] = ["study", "library", "decks", "settings"];

function isViewKey(value: unknown): value is ViewKey {
  return typeof value === "string" && viewKeys.includes(value as ViewKey);
}

function readViewFromLocation(): ViewKey {
  const fromHash = window.location.hash.slice(1);
  return isViewKey(fromHash) ? fromHash : "study";
}

function readStoredTheme(): ThemeMode {
  const stored = localStorage.getItem(themeStorageKey);
  return stored === "light" || stored === "dark" ? stored : "light";
}

export default function App() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<ViewKey>(readViewFromLocation);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() =>
    localStorage.getItem(activeProfileStorageKey)
  );
  const [learningSetups, setLearningSetups] = useState<LearningSetup[]>([]);
  const [loadedDecks, setDecks] = useState<Deck[]>([]);
  const [deckSort, setDeckSort] = useState<DeckSort>(() => {
    const stored = localStorage.getItem(deckSortStorageKey);
    return stored === "nameDescending" || stored === "nameAscending" ? stored : "newest";
  });
  const [words, setWords] = useState<WordEntry[]>([]);
  const [subsets, setSubsets] = useState<CustomSubset[]>([]);
  const [cards, setCards] = useState<CardState[]>([]);
  const [usage, setUsage] = useState<TranslationUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<{ message: string } | null>(null);
  const showStatus = useCallback((message: string) => setStatus(message ? { message } : null), []);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [captureRequest, setCaptureRequest] = useState<"word" | "scan" | null>(null);
  const [studyRequest, setStudyRequest] = useState<ScopeSelection | null>(null);
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
  const locale = activeProfile?.uiLanguage;
  const decks = useMemo(() => {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    return [...loadedDecks].sort((left, right) => {
      const byName = collator.compare(left.name, right.name);
      if (deckSort === "nameAscending") return byName;
      if (deckSort === "nameDescending") return -byName;
      return right.createdAt.localeCompare(left.createdAt) || -byName;
    });
  }, [deckSort, loadedDecks, locale]);
  const autoBackupSignature = useMemo(
    () => [
      collectionSignature(profiles),
      collectionSignature(learningSetups),
      collectionSignature(loadedDecks),
      collectionSignature(words),
      collectionSignature(subsets),
      collectionSignature(cards)
    ].join("|"),
    [cards, loadedDecks, learningSetups, profiles, subsets, words]
  );

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (!status) return;
    const timeout = window.setTimeout(() => {
      setStatus((current) => current === status ? null : current);
    }, statusDurationMs);
    return () => window.clearTimeout(timeout);
  }, [status]);

  useEffect(() => {
    // Each tab change is a history entry, so the phone's back button returns to the previous
    // screen instead of closing the app.
    window.history.replaceState({ ...(window.history.state ?? {}), view }, "", `#${view}`);
    const handlePopState = (event: PopStateEvent) => {
      const next = event.state?.view;
      setView(isViewKey(next) ? next : readViewFromLocation());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useBackDismiss(mobileMenuOpen, () => setMobileMenuOpen(false), "lexoraMenu");

  function navigate(next: ViewKey) {
    setMobileMenuOpen(false);
    if (next === view) return;
    navigateToView(next);
    setView(next);
  }

  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const touch = window.matchMedia("(pointer: coarse)");
    let fullHeight = window.innerHeight;
    let layoutWidth = window.innerWidth;
    let keyboardOpen = false;
    let keyboardResizedViewport = false;
    let focusFrame = 0;

    const update = () => {
      const focused = document.activeElement;
      const textField = focused instanceof HTMLTextAreaElement || (focused instanceof HTMLInputElement &&
        ["text", "search", "email", "tel", "url", "password", "number"].includes(focused.type));
      const editing = textField && !focused.readOnly && !focused.disabled && focused.inputMode !== "none";
      const zoomed = Math.abs((viewport?.scale ?? 1) - 1) > 0.01;
      const layoutHeight = window.innerHeight;
      const visualHeight = zoomed ? layoutHeight : viewport?.height ?? layoutHeight;
      if (!zoomed) {
        if (window.innerWidth !== layoutWidth || (!editing && !keyboardOpen)) fullHeight = layoutHeight;
        else fullHeight = Math.max(fullHeight, layoutHeight);
        layoutWidth = window.innerWidth;
      }

      // The layout viewport itself shrinks with Chrome's resizes-content mode. The difference
      // from the pre-keyboard height detects that case as well as a visual-only resize.
      const keyboardInset = zoomed ? 0 : Math.max(0, layoutHeight - visualHeight - (viewport?.offsetTop ?? 0));
      const resized = !zoomed && (keyboardInset > 120 || (editing && fullHeight - visualHeight > 120));
      const open = !zoomed && (resized || (touch.matches && editing));
      const revealField = (open && !keyboardOpen) || (resized && !keyboardResizedViewport);
      keyboardOpen = open;
      keyboardResizedViewport = resized;
      root.style.setProperty("--keyboard-inset", `${Math.round(keyboardInset)}px`);
      root.style.setProperty("--visual-height", `${Math.round(visualHeight)}px`);
      if (open) root.dataset.keyboard = "open";
      else delete root.dataset.keyboard;
      if (revealField && editing && focused.closest("dialog[open]")) {
        focused.scrollIntoView({ block: "nearest" });
      }
    };
    const onFocusChange = () => {
      window.cancelAnimationFrame(focusFrame);
      focusFrame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    document.addEventListener("focusin", onFocusChange);
    document.addEventListener("focusout", onFocusChange);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      document.removeEventListener("focusin", onFocusChange);
      document.removeEventListener("focusout", onFocusChange);
      root.style.removeProperty("--keyboard-inset");
      root.style.removeProperty("--visual-height");
      delete root.dataset.keyboard;
    };
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
        .then(() => showStatus(t("cloud.autoBackupSaved")))
        .catch(() => {
          if (!googleDriveProvider.isConnected()) {
            localStorage.removeItem(cloudBackupAuthorizationStorageKey);
          }
          showStatus(t("cloud.autoBackupSkipped"));
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
      selectedSetupId ? db.decks.where("learningSetupId").equals(selectedSetupId).toArray() : Promise.resolve([]),
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

  if (!activeSetup) {
    return (
      <ConfirmationProvider>
        <SetupRequired profile={activeProfile} onCreated={() => refreshAll(activeProfile.id)} />
      </ConfirmationProvider>
    );
  }

  return (
    <ConfirmationProvider>
    <div className="app-shell">
      <LanguageBackdrop target={activeSetup.targetLanguage} base={activeSetup.baseLanguage} />
      <header className="app-header app-glass sticky top-0 z-30 hidden border-b sm:block">
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
                icon={<House size={18} />}
                label={t("ui.today")}
                active={view === "study"}
                onClick={() => navigate("study")}
              />
              <NavButton
                icon={<Search size={18} />}
                label={t("nav.library")}
                active={view === "library"}
                onClick={() => navigate("library")}
              />
              <NavButton
                icon={<Layers size={18} />}
                label={t("nav.decks")}
                active={view === "decks"}
                onClick={() => navigate("decks")}
              />
              <NavButton
                icon={<Settings size={18} />}
                label={t("nav.settings")}
                active={view === "settings"}
                onClick={() => navigate("settings")}
              />
            </div>
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
                  options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
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
                    options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
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

              <section className="grid gap-2">
                <UsageBadge usage={usage} />
                <ConnectionBadge online={isOnline} />
              </section>
            </div>
          </aside>
        </div>
      ) : null}

      {status ? (
        <div className="app-status app-status-toast app-glass border-b px-4 py-2 text-center text-sm font-semibold" role="status">
          {status.message}
        </div>
      ) : null}

      <main className="app-main mx-auto max-w-7xl px-4 pt-4 sm:px-6 sm:py-6">
        <div key={`${view}-${activeSetup?.id ?? "none"}`} className="app-view-transition">
          {view === "study" && activeSetup ? (
            <StudyView
              profile={activeProfile}
              setup={activeSetup}
              decks={decks}
              words={words}
              cards={cards}
              studyRequest={studyRequest}
              onStudyRequestHandled={() => setStudyRequest(null)}
              onOpenSwitcher={() => setMobileMenuOpen(true)}
              onOpenDecks={() => navigate("decks")}
              onStatus={showStatus}
              onAddWords={() => {
                setCaptureRequest("word");
                navigate("library");
              }}
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
              captureRequest={captureRequest}
              onCaptureRequestHandled={() => setCaptureRequest(null)}
              onRefresh={refreshAll}
              onStatus={showStatus}
            />
          ) : null}
          {view === "decks" && activeSetup ? (
            <DecksView
              profile={activeProfile}
              setup={activeSetup}
              decks={decks}
              words={words}
              cards={cards}
              onStudyDeck={(deckId) => {
                setStudyRequest({ type: "deck", deckId });
                navigate("study");
              }}
              deckSort={deckSort}
              onSortChange={(sort) => {
                setDeckSort(sort);
                localStorage.setItem(deckSortStorageKey, sort);
              }}
              onRefresh={refreshAll}
              onStatus={showStatus}
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
              theme={theme}
              onThemeChange={setTheme}
              onUiLanguageChange={updateActiveUiLanguage}
              onSwitchProfile={(profileId) => {
                setActiveProfileId(profileId);
                void refreshAll(profileId);
              }}
              onSwitchSetup={async (setupId) => {
                await db.profiles.update(activeProfile.id, { activeLearningSetupId: setupId, updatedAt: nowIso() });
                await refreshAll(activeProfile.id);
              }}
              onRefresh={refreshAll}
              onStatus={showStatus}
            />
          ) : null}
        </div>
      </main>
      <MobileTabBar
        active={view}
        onSelect={(next) => {
          navigate(next);
        }}
        onAdd={() => {
          setCaptureRequest("word");
          navigate("library");
        }}
      />
    </div>
    </ConfirmationProvider>
  );
}

function FirstRun({ onCreated }: { onCreated: (profile: Profile) => void | Promise<void> }) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState("");
  const [uiLanguage, setUiLanguage] = useState<LanguageCode>("en");

  useEffect(() => {
    void i18n.changeLanguage(uiLanguage);
  }, [uiLanguage, i18n]);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }

    const profile = await createProfile(name, uiLanguage);
    await onCreated(profile);
  }

  return (
    <main className="app-screen onboarding-screen">
      <section className="onboarding-shell">
        <div className="onboarding-intro">
          <div className="flex items-center gap-3">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-12 w-12 shrink-0 drop-shadow-[0_0_14px_rgba(99,102,241,0.45)]" />
            <div>
              <p className="app-subtle text-xs font-semibold uppercase tracking-wide">{t("app.installable")}</p>
              <h1 className="app-heading text-2xl font-bold">Lexora</h1>
            </div>
          </div>
          <div className="grid gap-2">
            <h2 className="app-heading text-3xl font-bold tracking-tight">{t("profile.firstRunTitle")}</h2>
            <p className="app-muted max-w-md text-sm leading-relaxed">{t("profile.firstRunBody")}</p>
          </div>
        </div>

        <form className="onboarding-form app-panel" onSubmit={handleSubmit}>
          <div className="grid gap-1">
            <h2 className="app-heading text-lg font-semibold">{t("profile.name")}</h2>
            <p className="app-subtle text-sm">{t("profile.uiLanguage")}</p>
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
      </section>
    </main>
  );
}

function SetupRequired({ profile, onCreated }: { profile: Profile; onCreated: () => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState("");
  const [baseLanguage, setBaseLanguage] = useState<LanguageCode>("de");
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>("es");

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
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
    <section className="app-screen onboarding-screen">
      <div className="onboarding-shell">
        <div className="onboarding-intro">
          <div className="flex items-center gap-3">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-12 w-12 shrink-0 drop-shadow-[0_0_14px_rgba(99,102,241,0.45)]" />
            <div>
              <p className="app-subtle text-xs font-semibold uppercase tracking-wide">Lexora</p>
              <h1 className="app-heading text-2xl font-bold">{t("setup.label")}</h1>
            </div>
          </div>
          <div className="grid gap-2">
            <h2 className="app-heading text-3xl font-bold tracking-tight">{t("setup.firstRunTitle")}</h2>
            <p className="app-muted max-w-md text-sm leading-relaxed">{t("setup.firstRunBody")}</p>
          </div>
        </div>

      <form className="onboarding-form app-panel" onSubmit={handleSubmit}>
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
      </div>
    </section>
  );
}

function StudyView({
  profile,
  setup,
  decks,
  words,
  cards,
  studyRequest,
  onStudyRequestHandled,
  onOpenSwitcher,
  onOpenDecks,
  onAddWords,
  onStatus,
  onRefresh
}: {
  profile: Profile;
  setup: LearningSetup;
  decks: Deck[];
  words: WordEntry[];
  cards: CardState[];
  studyRequest: ScopeSelection | null;
  onStudyRequestHandled: () => void;
  onOpenSwitcher: () => void;
  onOpenDecks: () => void;
  onAddWords: () => void;
  onStatus: (message: string) => void;
  onRefresh: (nextActiveId?: string, showLoading?: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const locale = profile.uiLanguage;
  const [direction, setDirection] = useState<StudyDirection>("mixed");
  const [session, setSession] = useState<SessionState | null>(null);
  const [starting, setStarting] = useState(false);
  // Back during a session or on its summary returns to Today; ratings are already saved.
  useBackDismiss(session !== null, () => setSession(null), "lexoraSession");
  // The session the screen shows right now, read after awaits to see if it was dismissed meanwhile.
  const activeSessionId = useRef<string | null>(null);
  activeSessionId.current = session?.id ?? null;
  // The card on screen. The summary keeps the session ID but shows no card.
  const activeCardId = useRef<string | null>(null);
  activeCardId.current = session?.current?.card.id ?? null;
  const [scheduleError, setScheduleError] = useState(false);
  // The rating whose save failed. The card stays revealed; Continue retries this rating unless the
  // user picks another one. Cleared after a successful save and when the card or session changes.
  const [failedRating, setFailedRating] = useState<ReviewRating | null>(null);

  useEffect(() => {
    setFailedRating(null);
  }, [session?.id, session?.current?.card.id]);
  const answerInputRef = useRef<HTMLInputElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const [ratingOpen, setRatingOpen] = useState(false);
  // The answer field has focus, so on a phone the keyboard is up: the layout compacts.
  const [typing, setTyping] = useState(false);
  const advancingRef = useRef(false);
  const answerId = useId();
  const speechAvailable = canSpeak();

  const activePairWords = useMemo(() => words.filter((word) => word.learningSetupId === setup.id), [setup.id, words]);
  const activePairWordIds = useMemo(() => new Set(activePairWords.map((word) => word.id)), [activePairWords]);
  const pairCards = useMemo(() => cards.filter((card) => activePairWordIds.has(card.wordId)), [activePairWordIds, cards]);
  const directionCards = useMemo(
    () => (direction === "mixed" ? pairCards : pairCards.filter((card) => card.direction === direction)),
    [direction, pairCards]
  );
  const cardsByWord = useMemo(() => groupCardsByWord(pairCards), [pairCards]);
  // Bumped when a card becomes due, at midnight and when the app returns to the foreground,
  // so the counts below are recomputed even if nothing else re-renders Today.
  const [clock, setClock] = useState(() => Date.now());
  const forecast = useMemo(() => dueForecast(directionCards, new Date(clock)), [clock, directionCards]);
  const now = new Date(Math.max(clock, Date.now()));
  const dueCount = directionCards.filter((card) => new Date(card.due) <= now).length;
  const deckStats = useMemo(() => {
    const current = new Date(clock);
    return decks.map((deck) => {
      const deckWords = activePairWords.filter((word) => wordDeckIds(word).includes(deck.id));
      const deckWordIds = new Set(deckWords.map((word) => word.id));
      return {
        deck,
        words: deckWords.length,
        due: directionCards.filter((card) => deckWordIds.has(card.wordId) && new Date(card.due) <= current).length,
        learned: deckWords.filter((word) => wordStrength(cardsByWord.get(word.id)) >= 2).length
      };
    });
  }, [activePairWords, cardsByWord, clock, decks, directionCards]);

  useEffect(() => {
    if (session) return;

    const current = Date.now();
    const nextDue = directionCards.reduce((next, card) => {
      const due = new Date(card.due).getTime();
      return due > current && due < next ? due : next;
    }, Number.POSITIVE_INFINITY);
    const nextMidnight = addDays(startOfLocalDay(new Date(current)), 1).getTime();
    // setTimeout overflows above 2^31-1 ms (about 24.8 days); the effect re-arms when it fires.
    const delay = Math.min(Math.min(nextDue, nextMidnight) - current + 250, 2_147_483_647);
    const timeout = window.setTimeout(() => setClock(Date.now()), Math.max(0, delay));
    const refreshOnForeground = () => {
      if (document.visibilityState === "visible") setClock(Date.now());
    };
    document.addEventListener("visibilitychange", refreshOnForeground);
    window.addEventListener("focus", refreshOnForeground);
    window.addEventListener("pageshow", refreshOnForeground);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", refreshOnForeground);
      window.removeEventListener("focus", refreshOnForeground);
      window.removeEventListener("pageshow", refreshOnForeground);
    };
  }, [clock, directionCards, session]);

  // Cards can fall due while a session or its summary is open, when the timer above is paused.
  // Re-read the time on returning to Today so every count, deck badges included, is current.
  const onToday = session === null;
  useEffect(() => {
    if (onToday) setClock(Date.now());
  }, [onToday]);

  useEffect(() => {
    if (!studyRequest) return;
    onStudyRequestHandled();
    void startSession(false, studyRequest);
  }, [studyRequest]);

  async function startSession(includeFuture = false, scope: ScopeSelection = { type: "all" }, onlyCardIds?: Set<string>) {
    if (starting) return;
    setStarting(true);
    try {
      // A rating from a session the user just left may still be saving, possibly started on another
      // screen; read cards only after it lands, so the new queue uses the saved schedule.
      await waitForPendingRatingWrites();
      await ensureCardsForWords(activePairWords);
      const latestCards = await db.cards.where("learningSetupId").equals(setup.id).toArray();
      const scopedWords = filterWordsByScope(activePairWords, scope);
      const wordMap = new Map(scopedWords.map((word) => [word.id, word]));
      const directions = direction === "mixed" ? cardDirections : [direction];
      const startedAt = new Date();
      const queue = shuffle(
        latestCards
          .filter((card) => wordMap.has(card.wordId))
          .filter((card) => (onlyCardIds ? onlyCardIds.has(card.id) : directions.includes(card.direction)))
          .filter((card) => includeFuture || onlyCardIds || new Date(card.due) <= startedAt)
          .map((card) => ({ card, word: wordMap.get(card.wordId)! }))
      );
      const [current, ...rest] = queue;
      setScheduleError(false);
      setFailedRating(null);
      setSession({
        id: createId("session"),
        queue: rest,
        current,
        reviewed: 0,
        correct: 0,
        again: [],
        latest: {},
        answer: "",
        revealed: false,
        closeAccepted: false
      });
    } finally {
      setStarting(false);
    }
  }

  function submitAnswer() {
    if (!session?.current || !session.answer.trim()) {
      return;
    }

    const match = evaluateAnswer(session.answer, getAcceptedAnswers(session.current));
    setSession({ ...session, revealed: true, match, selectedRating: defaultRatingForMatch(match, false) });
  }

  function revealUnknownAnswer() {
    if (!session?.current) {
      return;
    }

    setSession({ ...session, answer: "", revealed: true, match: undefined, closeAccepted: false, selectedRating: "again" });
  }

  function keepAnswerFocused(event: React.PointerEvent<HTMLButtonElement>) {
    // Keep the field focused until the click lands so the keyboard and card stay in place.
    if (event.button === 0 && document.activeElement === answerInputRef.current) event.preventDefault();
  }

  async function rateCurrent(rating: ReviewRating) {
    if (!session?.current || advancingRef.current) {
      return;
    }

    advancingRef.current = true;
    try {
      const result = scheduleWithSavedHistory(session.current.card, rating);
      if (!result.ok) {
        // Nothing is written, so the card keeps its saved history.
        setScheduleError(true);
        return;
      }
      setScheduleError(false);
      const scheduled = result.scheduled;
      const sessionId = session.id;
      const cardId = session.current.card.id;
      try {
        await trackRatingWrite(db.cards.update(cardId, scheduled));
      } catch (error) {
        // Nothing was saved. Keep the card revealed so Continue retries the same rating.
        console.error("Could not save rating for card", cardId, error);
        if (activeSessionId.current === sessionId && activeCardId.current === cardId) {
          setFailedRating(rating);
        } else {
          // The user already left this card, so the message on the card would never be seen.
          onStatus(t("ui.ratingNotSaved"));
        }
        return;
      }
      setFailedRating(null);

      const wasCorrect = session.match === "correct" || (session.match === "close" && session.closeAccepted);
      const rated: StudyCard = { ...session.current, card: { ...session.current.card, ...scheduled } };
      const again = rating === "again" && !session.again.includes(rated.card.id)
        ? [...session.again, rated.card.id]
        : session.again;

      if (activeSessionId.current !== sessionId) {
        // The session was left (for example with Back) while the rating was being saved.
        // The rating is stored; only refresh the counts and stay where the user went.
        await onRefresh();
        return;
      }

      if (activeCardId.current !== cardId) {
        // Same session, but it moved on while saving: End session opened the summary. Count the
        // rating there and keep the summary open instead of advancing the queue.
        setSession((latest) => latest && latest.id === sessionId && !latest.current
          ? {
              ...latest,
              reviewed: latest.reviewed + 1,
              correct: latest.correct + (wasCorrect ? 1 : 0),
              again: rating === "again" && !latest.again.includes(cardId) ? [...latest.again, cardId] : latest.again,
              latest: { ...latest.latest, [cardId]: { item: rated, rating } }
            }
          : latest);
        await onRefresh();
        return;
      }

      const nextQueue = rating === "again" ? [...session.queue, rated] : [...session.queue];
      const [nextCurrent, ...rest] = nextQueue;
      setRatingOpen(false);
      setSession({
        id: session.id,
        queue: rest,
        current: nextCurrent,
        reviewed: session.reviewed + 1,
        correct: session.correct + (wasCorrect ? 1 : 0),
        again,
        latest: { ...session.latest, [rated.card.id]: { item: rated, rating } },
        answer: "",
        revealed: false,
        closeAccepted: false,
        selectedRating: undefined
      });

      await onRefresh();
    } finally {
      advancingRef.current = false;
    }
  }

  /** Moves past a card that could not be scheduled, without saving anything for it. */
  function skipCurrent() {
    if (!session?.current) return;
    const [nextCurrent, ...rest] = session.queue;
    setScheduleError(false);
    setFailedRating(null);
    setRatingOpen(false);
    if (!nextCurrent && session.reviewed === 0) {
      // Nothing was reviewed and the skipped card is still due: go back to Today rather than
      // showing a "nothing due" screen.
      setSession(null);
      return;
    }
    setSession({ ...session, queue: rest, current: nextCurrent, answer: "", revealed: false, closeAccepted: false, selectedRating: undefined });
  }

  function endSession() {
    if (!session) return;
    setSession(session.reviewed > 0 ? { ...session, queue: [], current: undefined } : null);
  }

  function insertCharacter(character: string) {
    const input = answerInputRef.current;
    if (!input || !session || session.revealed) return;
    const start = input.selectionStart ?? session.answer.length;
    const end = input.selectionEnd ?? start;
    setSession({ ...session, answer: `${session.answer.slice(0, start)}${character}${session.answer.slice(end)}` });
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + character.length, start + character.length);
    });
  }

  useEffect(() => {
    if (session?.revealed && !isCoarsePointer()) {
      continueRef.current?.focus();
    }
  }, [session?.revealed, session?.current?.card.id]);

  useEffect(() => {
    // Focus on phones too: answers are typed for every card, so keep the keyboard flowing.
    if (session?.current && !session.revealed) {
      answerInputRef.current?.focus({ preventScroll: true });
    }
  }, [session?.current?.card.id, session?.revealed]);

  useEffect(() => {
    // When the on-screen keyboard opens, keep the prompt at the top in view rather than
    // letting the browser scroll it away to reveal the answer field.
    const viewport = window.visualViewport;
    if (!session?.current || session.revealed || !viewport) return;
    const keepPromptVisible = () => {
      // A resize from pinch-zoom is not the keyboard; leave the user's zoom and position alone.
      if (Math.abs(viewport.scale - 1) > 0.01) return;
      if (document.activeElement === answerInputRef.current) window.scrollTo({ top: 0 });
    };
    viewport.addEventListener("resize", keepPromptVisible);
    return () => viewport.removeEventListener("resize", keepPromptVisible);
  }, [session?.current?.card.id, session?.revealed]);

  useEffect(() => {
    if (!session?.revealed) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [contenteditable='true']")) {
        return;
      }

      const ratingIndex = ["1", "2", "3", "4"].indexOf(event.key);
      if (ratingIndex >= 0) {
        event.preventDefault();
        void rateCurrent(ratings[ratingIndex]);
        return;
      }

      if (event.key === "Enter" && !target?.closest("button, a")) {
        event.preventDefault();
        void rateCurrent(failedRating ?? session.selectedRating ?? "again");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [session, failedRating]);

  if (session && !session.current) {
    if (session.reviewed === 0) {
      return (
        <section className="study-summary grid gap-4">
          <div className="grid gap-2">
            <h1 className="app-display text-3xl">{t("ui.nothingDue")}</h1>
            <p className="app-muted">{t("study.noDueBody")}</p>
          </div>
          <div className="study-summary-actions">
            <button className="app-button app-button-primary app-button-large" type="button" onClick={() => startSession(true)} disabled={starting}>
              <RotateCcw size={18} />
              {t("study.includeFuture")}
            </button>
            <button className="app-button app-button-secondary app-button-large" type="button" onClick={() => setSession(null)}>
              {t("ui.done")}
            </button>
          </div>
        </section>
      );
    }

    const today = startOfLocalDay(now);
    const tomorrowCount = countDueBetween(pairCards, addDays(today, 1), addDays(today, 2));
    const weekCount = countDueBetween(pairCards, now, addDays(today, 7));
    // Only cards whose most recent rating was Again still need an immediate retry.
    const retry = Object.values(session.latest).filter((entry) => entry.rating === "again").map((entry) => entry.item);
    return (
      <section className="study-summary grid gap-4">
        <div className="grid gap-3">
          <span className="study-summary-mark" aria-hidden="true"><Check size={28} strokeWidth={2.6} /></span>
          <h1 className="app-display text-3xl">{t("ui.sessionFinished")}</h1>
        </div>
        <div className="study-summary-stats">
          <div className="study-stat"><span className="study-stat-value">{session.reviewed}</span><span className="study-stat-label">{t("ui.cardsReviewed")}</span></div>
          <div className="study-stat"><span className="study-stat-value">{session.correct}</span><span className="study-stat-label">{t("ui.answeredCorrectly")}</span></div>
          <div className="study-stat"><span className="study-stat-value">{session.again.length}</span><span className="study-stat-label">{t("ui.ratedAgain")}</span></div>
        </div>
        {retry.length > 0 ? (
          <section className="app-surface-card grid gap-2 p-4" aria-labelledby="study-again-heading">
            <h2 id="study-again-heading" className="app-display text-base">{t("ui.stillToReview")}</h2>
            {retry.map((item) => (
              <div key={item.card.id} className="study-again-row">
                <span className="min-w-0">
                  <span className="app-heading block truncate font-semibold">{getPrompt(item)}</span>
                  <span className="app-muted block truncate text-sm">{getAcceptedAnswers(item).join(" / ")}</span>
                </span>
                <span className="app-muted shrink-0 text-sm">
                  {t("ui.backIn", { time: formatInterval(new Date(item.card.due).getTime() - now.getTime(), locale) })}
                </span>
              </div>
            ))}
          </section>
        ) : null}
        <section className="app-surface-card flex flex-wrap items-center justify-between gap-3 p-4" aria-labelledby="study-next-heading">
          <h2 id="study-next-heading" className="app-display text-base">{t("ui.nextReviews")}</h2>
          <span className="app-muted flex gap-4 text-sm">
            <span><strong className="app-heading">{tomorrowCount}</strong> {t("ui.tomorrow")}</span>
            <span><strong className="app-heading">{weekCount}</strong> {t("ui.thisWeek")}</span>
          </span>
        </section>
        <div className="study-summary-actions">
          <button className="app-button app-button-dark app-button-large" type="button" onClick={() => setSession(null)}>
            {t("ui.done")}
          </button>
          {retry.length > 0 ? (
            <button
              className="app-button app-button-secondary app-button-large"
              type="button"
              disabled={starting}
              onClick={() => startSession(true, { type: "all" }, new Set(retry.map((item) => item.card.id)))}
            >
              {t("ui.reviewAgainNow")}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  if (session?.current) {
    const prompt = getPrompt(session.current);
    const accepted = getAcceptedAnswers(session.current);
    const promptLanguage = session.current.card.direction === "target-base" ? setup.targetLanguage : setup.baseLanguage;
    const answerLanguage = session.current.card.direction === "target-base" ? setup.baseLanguage : setup.targetLanguage;
    const remaining = session.queue.length + 1;
    const total = session.reviewed + remaining;
    const tone = session.match === "close" && session.closeAccepted ? "correct" : (session.match ?? "revealed");
    const { label: outcomeLabel, icon: OutcomeIcon } = studyOutcomes[tone];
    // After a failed save, Continue retries what the user actually chose.
    const suggested = failedRating ?? session.selectedRating ?? "again";
    const previewTime = new Date();
    const previews = session.revealed
      ? ratings.map((rating) => {
          // Previews run on every render; the failure is reported once, when the user rates.
          const preview = scheduleWithSavedHistory(session.current!.card, rating, previewTime, { logFailure: false });
          const due = preview.ok ? preview.scheduled.due : undefined;
          return { rating, interval: due ? formatInterval(new Date(due).getTime() - previewTime.getTime(), locale) : "" };
        })
      : [];
    const suggestedInterval = previews.find((preview) => preview.rating === suggested)?.interval;
    // When the answer wasn't exactly right, mark the wrong letters in it and the missing ones in the
    // closest correct answer.
    const solution = session.revealed && session.answer ? closestAnswer(session.answer, accepted) : accepted[0];
    const answerDiff = session.revealed && session.answer && solution && session.match !== "correct"
      ? diffAnswer(session.answer.trim(), solution)
      : undefined;
    const otherAnswers = [...new Set(accepted)].filter((answer) => answer !== solution);
    return (
      <section className={`study-session ${typing && !session.revealed ? "study-session-typing" : ""}`} aria-label={t("study.title")}>
        <div className="study-session-top">
          <button className="study-round-button" type="button" onClick={endSession} aria-label={t("study.abandon")} data-tooltip={t("study.abandon")}>
            <X size={20} />
          </button>
          <div
            className="study-progress"
            role="progressbar"
            aria-label={t("ui.sessionProgress")}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={session.reviewed}
          >
            <span style={{ width: `${Math.round((session.reviewed / total) * 100)}%` }} />
          </div>
          <span className="study-progress-count">{session.reviewed + 1}/{total}</span>
        </div>

        {/* The card turns over to show the answer side, like a flashcard. A new card starts face up. */}
        <div key={session.current.card.id} className={`study-flip ${session.revealed ? "study-flip-revealed" : ""}`}>
          <div className="study-flip-inner">
              <div className="study-prompt-card study-flip-face study-flip-front" inert={session.revealed}>
                <div className="study-prompt-meta">
                  <span className="study-chip">
                    <FlagIcon code={promptLanguage} />
                    {directionLabel(session.current.card.direction, t)}
                  </span>
                  <span className="study-chip study-chip-accent">
                    {session.current.card.reviewCount === 0 ? t("common.new") : t("ui.review")}
                  </span>
                </div>
                <p className="study-prompt" lang={promptLanguage}>{prompt}</p>
                {speechAvailable ? (
                  <button
                    className="study-speak"
                    type="button"
                    onPointerDown={keepAnswerFocused}
                    onClick={() => speak(prompt, promptLanguage)}
                    aria-label={t("ui.playPronunciation")}
                    data-tooltip={t("ui.playPronunciation")}
                  >
                    <Volume2 size={22} />
                  </button>
                ) : null}
              </div>
              <div className={`study-result study-result-${tone} study-flip-face study-flip-back`} inert={!session.revealed}>
                {session.revealed ? (
                  <>
                  <div className="study-result-head">
                    <span className="study-result-icon" aria-hidden="true">
                      <OutcomeIcon size={22} strokeWidth={2.5} />
                    </span>
                    <div className="min-w-0">
                      <p className="study-result-title">{t(outcomeLabel)}</p>
                      <p className="study-result-context" lang={promptLanguage}>{prompt}</p>
                    </div>
                  </div>
                  <div className="study-solution">
                    <div className="study-solution-head">
                      <span className="study-answer-caption">{t("ui.expectedAnswer")}</span>
                      {speechAvailable && solution ? (
                        <button className="study-speak study-speak-small" type="button" onClick={() => speak(solution, answerLanguage)} aria-label={t("ui.playPronunciation")} data-tooltip={t("ui.playPronunciation")}>
                          <Volume2 size={20} />
                        </button>
                      ) : null}
                    </div>
                    <p className="study-solution-answer" lang={answerLanguage}>
                      {answerDiff ? answerDiff.correct.map((part, index) => (
                        <span key={index} className={part.differs ? "diff-missing" : undefined}>{part.text}</span>
                      )) : solution}
                    </p>
                    {otherAnswers.length ? (
                      <div className="study-other-answers">
                        <span className="study-answer-caption">{t("ui.otherAnswers")}</span>
                        <ul lang={answerLanguage}>
                          {otherAnswers.map((answer) => <li key={answer}>{answer}</li>)}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                  {session.answer && session.match !== "correct" ? (
                    <div className="study-your-answer">
                      <span className="study-answer-caption">{t("ui.yourAnswer")}</span>
                      <span className="study-your-answer-text" lang={answerLanguage}>
                        {answerDiff
                          ? answerDiff.typed.map((part, index) => (
                              <span key={index} className={part.differs ? "diff-wrong" : undefined}>{part.text}</span>
                            ))
                          : session.answer}
                      </span>
                    </div>
                  ) : null}
                  {session.current.word.notes ? (
                    <p className="app-muted text-sm leading-relaxed">
                      <strong className="app-heading">{t("common.notes")}:</strong> {session.current.word.notes}
                    </p>
                  ) : null}
                  {session.match === "close" ? (
                    <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
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
                  </>
                ) : null}
              </div>
          </div>
        </div>
        {!session.revealed ? (
          <>
            <form
              className="study-answer"
              onSubmit={(event) => {
                event.preventDefault();
                submitAnswer();
              }}
            >
              <label className="study-answer-label" htmlFor={answerId}>
                <FlagIcon code={answerLanguage} />
                {t("ui.answerIn", { language: localizedLanguageName(answerLanguage, locale) })}
              </label>
              <input
                id={answerId}
                className="app-input study-answer-input"
                onFocus={() => setTyping(true)}
                onBlur={() => setTyping(false)}
                value={session.answer}
                onChange={(event) => setSession({ ...session, answer: event.target.value })}
                placeholder={t("study.answerPlaceholder")}
                ref={answerInputRef}
                lang={answerLanguage}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="done"
              />
              {accentKeys[answerLanguage].length > 0 ? (
                <div className="accent-keys" role="group" aria-label={t("ui.specialCharacters")}>
                  {accentKeys[answerLanguage].map((character) => (
                    <button
                      key={character}
                      type="button"
                      className="accent-key"
                      onPointerDown={(event) => event.preventDefault()}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertCharacter(character)}
                    >
                      {character}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="study-answer-actions">
                <button className="app-button app-button-secondary app-button-large" type="button" onPointerDown={keepAnswerFocused} onClick={revealUnknownAnswer}>
                  {t("study.dontKnow")}
                </button>
                <button className="app-button app-button-primary app-button-large" type="submit" onPointerDown={keepAnswerFocused} disabled={!session.answer.trim()}>
                  <Check size={19} strokeWidth={2.6} />
                  {t("study.submit")}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="study-continue">
              {failedRating ? (
                <div className="study-error" role="alert">
                  <p>{t("ui.saveRatingError")}</p>
                </div>
              ) : null}
              {scheduleError ? (
                <div className="study-error" role="alert">
                  <p>{t("ui.scheduleError")}</p>
                  <button className="app-button app-button-secondary" type="button" onClick={skipCurrent}>
                    {t("ui.skipCard")}
                  </button>
                </div>
              ) : null}
              {suggestedInterval ? (
                <p className="app-muted text-center text-sm">{t("ui.nextReviewIn", { time: suggestedInterval })}</p>
              ) : null}
              {ratingOpen ? (
                <div className="rating-grid" role="group" aria-label={t("ui.changeRating")}>
                  {previews.map(({ rating, interval }, index) => (
                    <button
                      key={rating}
                      className={`rating-button rating-button-${rating} ${rating === suggested ? "rating-button-suggested" : ""}`}
                      type="button"
                      onClick={() => void rateCurrent(rating)}
                      aria-keyshortcuts={String(index + 1)}
                    >
                      <span className="rating-button-name">{t(`study.${rating}`)}</span>
                      <span className="rating-button-interval">{interval}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <button
                ref={continueRef}
                className="app-button app-button-primary app-button-large"
                type="button"
                onClick={() => void rateCurrent(suggested)}
              >
                {t("ui.continue")}
                <ArrowRight size={19} strokeWidth={2.4} />
              </button>
              <button className="text-button justify-self-center" type="button" aria-expanded={ratingOpen} onClick={() => setRatingOpen((open) => !open)}>
                {t("ui.changeRating")}
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  const maxForecast = Math.max(1, ...forecast.map((day) => day.count));
  // Today shows a short list; the Decks tab has all of them.
  const topDecks = deckStats
    .map((stats, tone) => ({ ...stats, tone }))
    .filter((stats) => stats.words > 0)
    .sort((left, right) => right.due - left.due)
    .slice(0, todayDeckLimit);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const minutes = Math.max(1, Math.round((dueCount * secondsPerCard) / 60));
  const directionOptions: Array<{ value: StudyDirection; label: string; title: string }> = [
    { value: "target-base", label: `${setup.targetLanguage.toUpperCase()}→${setup.baseLanguage.toUpperCase()}`, title: t("study.targetBase") },
    { value: "base-target", label: `${setup.baseLanguage.toUpperCase()}→${setup.targetLanguage.toUpperCase()}`, title: t("study.baseTarget") },
    { value: "mixed", label: t("ui.both"), title: t("study.mixed") }
  ];
  return (
    <section className="today grid gap-4">
      <header className="today-header">
        <div className="min-w-0">
          <p className="app-muted text-sm font-semibold">
            {new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "short" }).format(now)}
          </p>
          <h1 className="app-display text-3xl" lang={setup.targetLanguage}>{greetings[setup.targetLanguage]}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:hidden">
          <button
            className="today-pill"
            type="button"
            onClick={onOpenSwitcher}
            aria-label={`${learningSetupDisplayName(setup, locale)}. ${t("ui.switchProfileOrLanguage")}`}
          >
            <FlagIcon code={setup.targetLanguage} />
            {setup.targetLanguage.toUpperCase()}
          </button>
          <button className="today-avatar" type="button" onClick={onOpenSwitcher} aria-label={`${profile.name}. ${t("ui.switchProfileOrLanguage")}`}>
            {initials(profile.name)}
          </button>
        </div>
      </header>

      {activePairWords.length === 0 ? (
        <section className="today-empty">
          <h2 className="app-display text-xl">{t("ui.emptyTitle")}</h2>
          <p className="app-muted">{t("ui.emptyBody")}</p>
          <button className="app-button app-button-primary app-button-large w-fit" type="button" onClick={onAddWords}>
            <Plus size={18} />
            {t("ui.addWords")}
          </button>
        </section>
      ) : (
        <div className="today-grid">
          <section className="forecast-card" aria-labelledby="forecast-heading">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="forecast-heading" className="app-display text-lg">{t("ui.comingUp")}</h2>
              <span className="forecast-meta">
                {t("ui.wordCount", { count: activePairWords.length })} · {t("ui.deckCount", { count: decks.length })}
              </span>
            </div>
            <div
              className="forecast-bars"
              role="img"
              aria-label={forecast.map((day, index) => `${index === 0 ? t("ui.today") : weekday.format(day.date)}: ${day.count}`).join(", ")}
            >
              {forecast.map((day, index) => (
                <div key={day.date.toISOString()} className={`forecast-day ${index === 0 ? "forecast-day-today" : ""}`}>
                  <span className="forecast-count">{day.count}</span>
                  <span className="forecast-bar" style={{ height: `${Math.max(3, Math.round((day.count / maxForecast) * 56))}px` }} />
                  <span className="forecast-label">{index === 0 ? t("ui.today") : weekday.format(day.date)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="review-card" aria-labelledby="review-heading">
            <div className="review-card-top">
              <div className="min-w-0">
                <h2 id="review-heading" className="review-card-label">{t("ui.dueNow")}</h2>
                <p className="review-card-count">{dueCount}</p>
                <p className="review-card-label">{dueCount > 0 ? t("ui.aboutMinutes", { count: minutes }) : t("ui.nothingDue")}</p>
              </div>
              <div className="review-direction" role="group" aria-label={t("study.direction")}>
                {directionOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={direction === option.value}
                    aria-label={option.title}
                    onClick={() => setDirection(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <button className="review-card-start" type="button" onClick={() => startSession(false)} disabled={dueCount === 0 || starting}>
              {starting ? <LoadingIndicator label={t("ui.startReview")} /> : null}
              {t("ui.startReview")}
              <ArrowRight size={20} strokeWidth={2.4} />
            </button>
            <button className="review-card-secondary" type="button" onClick={() => startSession(true)} disabled={starting}>
              <RotateCcw size={16} />
              {t("study.includeFuture")}
            </button>
          </section>
        </div>
      )}

      {activePairWords.length > 0 ? (
        <section className="grid gap-2" aria-labelledby="today-decks-heading">
          <div className="flex items-center justify-between gap-3">
            <h2 id="today-decks-heading" className="app-display text-lg">{t("ui.yourDecks")}</h2>
            <button className="text-button" type="button" onClick={onOpenDecks}>{t("ui.seeAll")}</button>
          </div>
          <div className="deck-tiles">
            {topDecks.map(({ deck, words: wordCount, due, learned, tone: index }) => (
              <button
                key={deck.id}
                className="deck-tile"
                type="button"
                onClick={() => startSession(due === 0, { type: "deck", deckId: deck.id })}
                disabled={wordCount === 0 || starting}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className={`deck-badge deck-tone-${index % deckToneCount}`} aria-hidden="true">{deck.name.charAt(0).toLocaleUpperCase()}</span>
                  {due > 0 ? <span className="due-pill">{t("ui.dueCount", { count: due })}</span> : null}
                </span>
                <span className="deck-tile-name">{deck.name}</span>
                <span className="deck-tile-meta">
                  {t("ui.wordCount", { count: wordCount })} · {t("ui.learnedCount", { count: learned })}
                </span>
                <span className={`deck-meter deck-tone-${index % deckToneCount}`} aria-hidden="true">
                  <span style={{ width: `${wordCount ? Math.round((learned / wordCount) * 100) : 0}%` }} />
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
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
  captureRequest,
  onCaptureRequestHandled,
  onRefresh,
  onStatus
}: {
  profile: Profile;
  setup: LearningSetup;
  decks: Deck[];
  words: WordEntry[];
  cards: CardState[];
  usage: TranslationUsage | null;
  captureRequest: "word" | "scan" | null;
  onCaptureRequestHandled: () => void;
  onRefresh: () => Promise<void>;
  onStatus: (message: string) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [form, setForm] = useState<WordFormState>(() => ({ ...emptyWordForm, deckId: preferredLibraryDeckId(decks, setup.baseLanguage) }));
  const [captureDialog, setCaptureDialog] = useState<"word" | "scan" | null>(null);
  const wordInput = useRef<HTMLInputElement>(null);
  const wordTranslationHintId = useId();
  const suggestionRequest = useRef<AbortController | null>(null);
  const [savingWord, setSavingWord] = useState(false);
  const [savingScan, setSavingScan] = useState(false);
  const [wordStatus, setWordStatus] = useState("");
  const [editingWord, setEditingWord] = useState<WordEntry | null>(null);
  const [editForm, setEditForm] = useState<WordFormState>({ ...emptyWordForm });
  const [editDeckIds, setEditDeckIds] = useState<string[]>([]);
  const [editFormSubmitted, setEditFormSubmitted] = useState(false);
  const [suggestions, setSuggestions] = useState<TranslationResult[]>([]);
  const [fetching, setFetching] = useState(false);
  const [lastAutoSuggestedText, setLastAutoSuggestedText] = useState("");
  const [query, setQuery] = useState("");
  const [deckFilter, setDeckFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<ReviewStatus>("all");
  const [visibleCount, setVisibleCount] = useState(libraryPageSize);
  const [wordFormSubmitted, setWordFormSubmitted] = useState(false);
  const [lastAdded, setLastAdded] = useState<{ word: string; deck: string } | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
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
      captureDialog !== "word" ||
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
  }, [captureDialog, fetching, form.targetText, form.translations, lastAutoSuggestedText, translationLimitReached]);

  useEffect(() => () => suggestionRequest.current?.abort(), []);

  useEffect(() => {
    if (!captureRequest) return;
    setCaptureDialog(captureRequest);
    onCaptureRequestHandled();
  }, [captureRequest]);

  const cardByWord = useMemo(() => groupCardsByWord(cards), [cards]);
  const wordProgress = useMemo(() => {
    const now = new Date();
    return new Map(words.map((word) => {
      const wordCards = cardByWord.get(word.id) ?? [];
      return [word.id, {
        due: wordCards.some((card) => new Date(card.due) <= now && card.reviewCount > 0),
        isNew: wordCards.every((card) => card.reviewCount === 0),
        strength: wordStrength(wordCards)
      }];
    }));
  }, [cardByWord, words]);
  const statusCounts = useMemo(() => {
    const values = [...wordProgress.values()];
    return {
      all: words.length,
      due: values.filter((value) => value.due).length,
      new: values.filter((value) => value.isNew).length,
      learned: values.filter((value) => value.strength >= 2).length
    };
  }, [wordProgress, words.length]);
  const filteredWords = useMemo(() => words.filter((word) => {
    const haystack = `${word.targetText} ${word.translations.join(" ")} ${word.notes}`.toLocaleLowerCase();
    const matchesQuery = !query || haystack.includes(query.toLocaleLowerCase());
    const matchesDeck = deckFilter === "all" || wordDeckIds(word).includes(deckFilter);
    const status = wordProgress.get(word.id);
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "due" && status?.due) ||
      (statusFilter === "new" && status?.isNew) ||
      (statusFilter === "learned" && (status?.strength ?? 0) >= 2);

    return matchesQuery && matchesDeck && matchesStatus;
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [deckFilter, query, statusFilter, wordProgress, words]);
  const visibleWords = filteredWords.slice(0, visibleCount);
  const wordGroups = useMemo(() => {
    const today = startOfLocalDay(new Date()).getTime();
    const yesterday = addDays(new Date(today), -1).getTime();
    const groups: Array<{ key: string; label: string; words: WordEntry[] }> = [
      { key: "today", label: t("ui.addedToday"), words: [] },
      { key: "yesterday", label: t("ui.addedYesterday"), words: [] },
      { key: "earlier", label: t("ui.addedEarlier"), words: [] }
    ];
    for (const word of visibleWords) {
      const created = new Date(word.createdAt).getTime();
      groups[created >= today ? 0 : created >= yesterday ? 1 : 2].words.push(word);
    }
    return groups.filter((group) => group.words.length > 0);
  }, [t, visibleWords]);
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
    setVisibleCount(libraryPageSize);
  }, [deckFilter, query, statusFilter]);

  async function fetchSuggestions(automatic = false) {
    const targetText = form.targetText.trim();
    if (!targetText || translationLimitReached) {
      if (translationLimitReached) {
        setWordStatus(t("status.limitReached"));
      }
      return;
    }

    suggestionRequest.current?.abort();
    const controller = new AbortController();
    suggestionRequest.current = controller;
    setFetching(true);
    try {
      const result = await fetchTranslationSuggestions(targetText, setup.targetLanguage, setup.baseLanguage, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSuggestions(result);
      setLastAutoSuggestedText(targetText);
      if (!automatic && result.length === 0) {
        setWordStatus(t("status.noSuggestions"));
      }
      await onRefresh();
    } catch (error) {
      if (controller.signal.aborted) return;
      setLastAutoSuggestedText(targetText);
      if (!automatic) {
        setWordStatus(t(error instanceof Error && error.message === "daily-limit" ? "status.limitReached" : "status.offline"));
      }
    } finally {
      if (suggestionRequest.current === controller) {
        suggestionRequest.current = null;
        setFetching(false);
      }
    }
  }

  async function saveWord(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingWord) return;
    setWordFormSubmitted(true);
    const translations = splitTranslations(form.translations);
    if (!form.targetText.trim() || translations.length === 0 || !form.deckId) {
      return;
    }

    setSavingWord(true);
    setWordStatus("");
    try {
      if (duplicateWord) {
        const addDuplicate = await confirm({
          title: t("library.duplicateTitle"),
          message: t("library.duplicateBody", { word: duplicateWord.targetText }),
          confirmLabel: t("library.addDuplicate"),
          cancelLabel: t("common.cancel")
        });
        if (!addDuplicate) {
          requestAnimationFrame(() => wordInput.current?.focus());
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
      await db.transaction("rw", db.decks, db.words, db.cards, async () => {
        const deck = await db.decks.get(word.deckId);
        if (!deck || deck.learningSetupId !== setup.id) throw new Error("Destination deck is no longer available.");
        await db.words.add(word);
        await ensureCardsForWords([word]);
      });
    } catch {
      setWordStatus(t("status.saveFailed"));
      return;
    } finally {
      setSavingWord(false);
    }

    const savedWord = form.targetText.trim();
    const savedDeck = decks.find((deck) => deck.id === form.deckId)?.name ?? "";
    resetWordForm();
    setLastAdded({ word: savedWord, deck: savedDeck });
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
    clearSuggestions();
    setWordFormSubmitted(false);
    setWordStatus("");
    setNotesOpen(false);
    requestAnimationFrame(() => wordInput.current?.focus());
  }

  function cancelSuggestions() {
    suggestionRequest.current?.abort();
    suggestionRequest.current = null;
    setFetching(false);
  }

  function clearSuggestions() {
    cancelSuggestions();
    setSuggestions([]);
    setLastAutoSuggestedText("");
  }

  function closeCaptureDialog() {
    cancelSuggestions();
    setWordStatus("");
    setLastAdded(null);
    // A finished import closes the dialog before the scanner can report that saving ended.
    setSavingScan(false);
    setCaptureDialog(null);
  }

  // Switching tabs during a save could let the finished save close or reset the other panel.
  const captureLocked = savingWord || savingScan;
  const captureTabs = (
    <div className="capture-tabs" role="tablist" aria-label={t("ui.addWords")}>
      <button
        type="button"
        role="tab"
        aria-selected={captureDialog === "word"}
        onClick={() => {
          setCaptureDialog("word");
          requestAnimationFrame(() => wordInput.current?.focus());
        }}
        disabled={captureLocked}
      >
        <Edit2 size={17} />
        {t("ui.typeTab")}
      </button>
      <button type="button" role="tab" aria-selected={captureDialog === "scan"} onClick={() => setCaptureDialog("scan")} disabled={captureLocked}>
        <Camera size={17} />
        {t("ui.scanTab")}
      </button>
    </div>
  );

  function editWord(word: WordEntry) {
    const deckIds = wordDeckIds(word);
    const primaryDeckId = deckIds.includes(word.deckId) ? word.deckId : deckIds[0] ?? preferredLibraryDeckId(decks, setup.baseLanguage);
    setEditingWord(word);
    setEditForm({
      targetText: word.targetText,
      translations: word.translations.join("; "),
      notes: word.notes,
      deckId: primaryDeckId
    });
    setEditDeckIds(deckIds.length > 0 ? deckIds : [primaryDeckId]);
    setEditFormSubmitted(false);
  }

  function closeEditModal() {
    setEditingWord(null);
    setEditForm({ ...emptyWordForm });
    setEditDeckIds([]);
    setEditFormSubmitted(false);
  }

  function toggleEditDeck(deckId: string, checked: boolean) {
    const next = checked ? Array.from(new Set([...editDeckIds, deckId])) : editDeckIds.filter((candidate) => candidate !== deckId);
    setEditDeckIds(next);
    if (next.length > 0 && !next.includes(editForm.deckId)) {
      setEditForm((formState) => ({ ...formState, deckId: next[0] }));
    }
  }

  async function updateWord(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingWord) {
      return;
    }

    setEditFormSubmitted(true);
    const translations = splitTranslations(editForm.translations);
    const selectedDeckIds = editDeckIds.length > 0 ? editDeckIds : [editForm.deckId].filter(Boolean);
    const primaryDeckId = selectedDeckIds.includes(editForm.deckId) ? editForm.deckId : selectedDeckIds[0];
    if (!editForm.targetText.trim() || translations.length === 0 || !primaryDeckId || selectedDeckIds.length === 0) {
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
      deckId: primaryDeckId,
      deckIds: selectedDeckIds,
      updatedAt: nowIso()
    });
    closeEditModal();
    onStatus(t("status.saved"));
    await onRefresh();
  }

  return (
    <section className="grid gap-4">
      <header className="view-header">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="app-display text-3xl">{t("library.title")}</h1>
          <span className="app-muted whitespace-nowrap text-sm font-semibold">{t("ui.wordCount", { count: words.length })}</span>
        </div>
        <div className="flex shrink-0 gap-2">
          <span className="hidden sm:contents">
            <button className="app-button app-button-primary" type="button" aria-haspopup="dialog" onClick={() => setCaptureDialog("word")}>
              <Plus size={17} />
              {t("library.addWord")}
            </button>
          </span>
          <button
            className="app-button app-button-secondary icon-tile"
            type="button"
            aria-haspopup="dialog"
            aria-label={t("scan.title")}
            data-tooltip={t("scan.title")}
            onClick={() => setCaptureDialog("scan")}
          >
            <ScanLine size={21} />
          </button>
        </div>
      </header>

      {captureDialog ? (
        <Modal title={t("ui.addWords")} onClose={closeCaptureDialog} closeDisabled={captureLocked} toolbar={captureTabs} wide={captureDialog === "scan"}>
          {/* Both panels stay mounted while the dialog is open so each keeps its draft. */}
          <div hidden={captureDialog !== "scan"}>
            <VocabularyScanner
              setup={setup}
              decks={decks}
              defaultDeckId={preferredLibraryDeckId(decks, setup.baseLanguage)}
              onRefresh={onRefresh}
              onSavingChange={setSavingScan}
              onImported={(count, duplicates) => {
                onStatus(t(duplicates ? "scan.importedWithDuplicates" : "status.imported", { count, duplicates }));
                closeCaptureDialog();
              }}
            />
          </div>
          <div hidden={captureDialog !== "word"}>
          <form className="capture-form grid gap-4" onSubmit={saveWord} noValidate>
            {lastAdded ? (
              <p className="capture-success" role="status">
                <Check size={18} strokeWidth={2.6} aria-hidden="true" />
                <span>{t("ui.addedTo", { word: lastAdded.word, deck: lastAdded.deck })}</span>
              </p>
            ) : null}
            <fieldset className="capture-fields grid min-w-0 gap-4" disabled={savingWord}>
              <div className="grid gap-2">
                <Label
                  text={
                    <span className="flex items-center gap-1.5">
                      <FlagIcon code={setup.targetLanguage} />
                      {localizedLanguageName(setup.targetLanguage, profile.uiLanguage)}
                    </span>
                  }
                >
                  <input
                    ref={wordInput}
                    data-autofocus
                    className={`app-input capture-input ${duplicateWord || targetMissing ? "app-input-warning" : ""}`}
                    value={form.targetText}
                    onChange={(event) => {
                      clearSuggestions();
                      setWordStatus("");
                      setLastAdded(null);
                      setForm({ ...form, targetText: event.target.value });
                    }}
                    placeholder={t("library.targetPlaceholder")}
                    lang={setup.targetLanguage}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={targetMissing}
                  />
                  {targetMissing ? <span className="app-warning-text text-xs">{t("library.targetRequired")}</span> : null}
                  {duplicateWord ? <span className="app-warning-text text-xs">{t("library.duplicateInline")}</span> : null}
                </Label>
              </div>

              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="app-label flex items-center gap-1.5 text-sm font-semibold">
                    <FlagIcon code={setup.baseLanguage} />
                    {localizedLanguageName(setup.baseLanguage, profile.uiLanguage)}
                  </span>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => fetchSuggestions(false)}
                    disabled={fetching || !form.targetText.trim() || translationLimitReached}
                  >
                    {fetching ? <LoadingIndicator label={t("library.fetchSuggestions")} /> : <Search size={16} />}
                    {t("library.fetchSuggestions")}
                  </button>
                </div>
                {suggestions.length > 0 ? (
                  <div className="flex flex-wrap gap-2" role="group" aria-label={t("library.suggestions")}>
                    {suggestions.map((suggestion) => {
                      const chosen = splitTranslations(form.translations).includes(suggestion.text);
                      return (
                        <button
                          key={`${suggestion.text}-${suggestion.confidence}`}
                          className={`suggestion-chip ${chosen ? "suggestion-chip-chosen" : ""}`}
                          type="button"
                          aria-pressed={chosen}
                          lang={setup.baseLanguage}
                          onClick={() => {
                            const next = splitTranslations(form.translations).filter((value) => value !== suggestion.text);
                            if (!chosen) next.push(suggestion.text);
                            setForm({ ...form, translations: next.join("; ") });
                          }}
                        >
                          {chosen ? <Check size={15} strokeWidth={3} aria-hidden="true" /> : null}
                          {suggestion.text}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <input
                  className={`app-input ${translationsMissing ? "app-input-warning" : ""}`}
                  value={form.translations}
                  onChange={(event) => setForm({ ...form, translations: event.target.value })}
                  aria-label={t("common.translations")}
                  placeholder={t("ui.translationsPlaceholder")}
                  lang={setup.baseLanguage}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={translationsMissing}
                  aria-describedby={wordTranslationHintId}
                />
                {translationsMissing ? <span className="app-warning-text text-xs">{t("library.translationsRequired")}</span> : null}
                <p id={wordTranslationHintId} className="capture-hint app-muted text-xs">{t("library.translationHint")}</p>
              </div>

              <div className="capture-options">
                <AppSelect
                  value={form.deckId}
                  ariaLabel={t("common.deck")}
                  disabled={savingWord}
                  placement="above"
                  wrap
                  options={decks.map((deck) => ({ value: deck.id, label: deck.name }))}
                  onChange={(deckId) => setForm({ ...form, deckId })}
                />
                {!notesOpen && !form.notes ? (
                  <button className="app-button app-button-secondary" type="button" onClick={() => setNotesOpen(true)}>
                    <Plus size={16} />
                    {t("ui.note")}
                  </button>
                ) : null}
              </div>
              {notesOpen || form.notes ? (
                <Label text={`${t("common.notes")} (${t("common.optional")})`}>
                  <textarea
                    className="app-input library-note-input"
                    value={form.notes}
                    onChange={(event) => setForm({ ...form, notes: event.target.value })}
                    placeholder={t("library.notesPlaceholder")}
                    autoCapitalize="sentences"
                    autoFocus={notesOpen && !form.notes}
                  />
                </Label>
              ) : null}
            </fieldset>
            <div className="capture-footer">
              <p className={`capture-lookups text-xs ${translationLimitReached ? "app-warning-text" : "app-muted"}`}>
                {t("ui.lookupsLeft", { count: translationRemaining })}
              </p>
              <p className="app-muted text-sm" role="status">{wordStatus}</p>
              <div className="flex gap-2">
                <button className="app-button app-button-ghost" type="button" onClick={resetWordForm} disabled={savingWord}>
                  {t("common.reset")}
                </button>
                <button className="app-button app-button-primary app-button-large" type="submit" disabled={savingWord}>
                  {savingWord ? <LoadingIndicator label={t("ui.addAndNext")} /> : null}
                  {t("ui.addAndNext")}
                  <ArrowRight size={19} strokeWidth={2.4} />
                </button>
              </div>
            </div>
          </form>
          </div>
        </Modal>
      ) : null}

      {editingWord ? (
        <Modal title={t("common.edit")} onClose={closeEditModal}>
          <form className="grid gap-3" onSubmit={updateWord} noValidate>
            <Label
              text={
                <span className="flex items-center gap-1.5">
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
                lang={setup.targetLanguage}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={editTargetMissing}
                data-autofocus
              />
              {editTargetMissing ? <span className="app-warning-text text-xs">{t("library.targetRequired")}</span> : null}
              {editDuplicateWord ? <span className="app-warning-text text-xs">{t("library.duplicateInline")}</span> : null}
            </Label>
            <Label
              text={
                <span className="flex items-center gap-1.5">
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
                lang={setup.baseLanguage}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={editTranslationsMissing}
              />
              {editTranslationsMissing ? <span className="app-warning-text text-xs">{t("library.translationsRequired")}</span> : null}
            </Label>
            <div className="grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
              <AppSelect
                label={t("library.primaryDeck")}
                value={editForm.deckId}
                options={(decks.filter((deck) => editDeckIds.includes(deck.id)).length > 0
                  ? decks.filter((deck) => editDeckIds.includes(deck.id))
                  : decks
                ).map((deck) => ({ value: deck.id, label: deck.name }))}
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
            <div className="app-subpanel grid gap-2 p-3">
              <h3 className="app-heading text-sm font-semibold">{t("library.deckAssignments")}</h3>
              <div className="grid gap-1">
                {decks.map((deck) => {
                  const checked = editDeckIds.includes(deck.id);
                  const isLastAssigned = checked && editDeckIds.length <= 1;
                  return (
                    <label key={deck.id} className="deck-word-option">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isLastAssigned}
                        onChange={(event) => toggleEditDeck(deck.id, event.target.checked)}
                      />
                      <span className="min-w-0">
                        <span className="deck-word-option-target">{deck.name}</span>
                        <span className="deck-word-option-translation">
                          {isLastAssigned ? t("library.atLeastOneDeck") : checked ? t("library.assigned") : t("library.unassigned")}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="app-divider flex flex-wrap items-center justify-end gap-2 border-t pt-3">
              <button
                className="app-button app-button-ghost app-text-danger mr-auto"
                type="button"
                onClick={() => {
                  const word = editingWord;
                  closeEditModal();
                  void deleteWord(word);
                }}
              >
                <Trash2 size={17} />
                {t("common.delete")}
              </button>
              <button className="app-button app-button-ghost" type="button" onClick={closeEditModal}>
                {t("common.cancel")}
              </button>
              <button className="app-button app-button-primary" type="submit">
                {t("common.save")}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      <div className="library-tools">
        <label className="search-field">
          <Search size={19} aria-hidden="true" />
          <span className="sr-only">{t("common.search")}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("library.searchPlaceholder")}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <div className="filter-chips" role="group" aria-label={t("library.filters")}>
          {(["all", "due", "new", "learned"] as const).map((value) => (
            <button
              key={value}
              className="filter-chip"
              type="button"
              aria-pressed={statusFilter === value}
              onClick={() => setStatusFilter(value)}
            >
              {value === "all" ? t("common.all") : t(`common.${value}`)}
              <span className="filter-chip-count">{statusCounts[value]}</span>
            </button>
          ))}
          {decks.length > 1 ? (
            <div className="filter-deck">
              <AppSelect
                value={deckFilter}
                ariaLabel={t("common.deck")}
                compact
                options={[
                  { value: "all", label: t("ui.allDecks") },
                  ...decks.map((deck) => ({ value: deck.id, label: deck.name }))
                ]}
                onChange={setDeckFilter}
              />
            </div>
          ) : null}
        </div>
      </div>

      {filteredWords.length === 0 ? (
        <p className="app-surface-card app-muted p-4">{t("library.noWords")}</p>
      ) : null}
      {wordGroups.map((group) => (
        <section key={group.key} className="grid gap-2" aria-labelledby={`library-group-${group.key}`}>
          <h2 id={`library-group-${group.key}`} className="section-label">{group.label}</h2>
          <ul className="word-list">
            {group.words.map((word) => {
              const progress = wordProgress.get(word.id);
              const deckNames = wordDeckIds(word).map((deckId) => decks.find((deck) => deck.id === deckId)?.name).filter(Boolean).join(", ");
              const strength = progress?.strength ?? 0;
              return (
                <li key={word.id}>
                  <button className="word-row" type="button" onClick={() => editWord(word)} aria-label={`${word.targetText}. ${t("common.edit")}`}>
                    <span className="min-w-0 flex-1">
                      <span className="word-row-target" lang={setup.targetLanguage}>{word.targetText}</span>
                      <span className="word-row-meta">
                        <span lang={setup.baseLanguage}>{word.translations.join(" / ")}</span>
                        {deckNames ? ` · ${deckNames}` : ""}
                      </span>
                    </span>
                    {progress?.due ? <span className="due-pill">{t("common.due")}</span> : null}
                    {progress?.isNew ? <span className="new-pill">{t("common.new")}</span> : null}
                    <span className="strength-meter" role="img" aria-label={t("ui.strength", { level: strength })}>
                      {[1, 2, 3].map((level) => <span key={level} className={level <= strength ? "strength-on" : undefined} />)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {filteredWords.length > visibleWords.length ? (
        <button className="app-button app-button-secondary app-button-large justify-self-center" type="button" onClick={() => setVisibleCount((count) => count + libraryPageSize)}>
          {t("ui.showMore", { count: filteredWords.length - visibleWords.length })}
        </button>
      ) : null}
    </section>
  );
}

function DecksView({
  profile,
  setup,
  decks,
  words,
  cards,
  onStudyDeck,
  deckSort,
  onSortChange,
  onRefresh,
  onStatus
}: {
  profile: Profile;
  setup: LearningSetup;
  decks: Deck[];
  words: WordEntry[];
  cards: CardState[];
  onStudyDeck: (deckId: string) => void;
  deckSort: DeckSort;
  onSortChange: (sort: DeckSort) => void;
  onRefresh: (nextActiveId?: string, showLoading?: boolean) => Promise<void>;
  onStatus: (message: string) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [openMenuDeckId, setOpenMenuDeckId] = useState<string | null>(null);
  const defaultDeckId = findDefaultDeck(decks, setup.baseLanguage)?.id;
  const deckStats = useMemo(() => {
    const now = new Date();
    const cardsByWord = groupCardsByWord(cards);
    return new Map(decks.map((deck) => {
      const deckWords = words.filter((word) => wordDeckIds(word).includes(deck.id));
      const strengths = deckWords.map((word) => wordStrength(cardsByWord.get(word.id)));
      return [deck.id, {
        words: deckWords.length,
        learned: strengths.filter((strength) => strength >= 2).length,
        learning: strengths.filter((strength) => strength === 1).length,
        fresh: strengths.filter((strength) => strength === 0).length,
        due: deckWords.reduce((total, word) =>
          total + (cardsByWord.get(word.id) ?? []).filter((card) => new Date(card.due) <= now).length, 0)
      }];
    }));
  }, [cards, decks, words]);

  useEffect(() => {
    if (!openMenuDeckId) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !(event.target as HTMLElement).closest(".deck-menu")) {
        setOpenMenuDeckId(null);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [openMenuDeckId]);
  const [deckName, setDeckName] = useState("");
  const [createDeckOpen, setCreateDeckOpen] = useState(false);
  const [creatingDeck, setCreatingDeck] = useState(false);
  const [createDeckStatus, setCreateDeckStatus] = useState("");
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

  async function addDeck(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deckName.trim() || creatingDeck) {
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

    setCreatingDeck(true);
    setCreateDeckStatus("");
    try {
      await db.transaction("rw", db.decks, db.words, async () => {
        await db.decks.add(deck);
        await Promise.all(
          selectedWordIds.map(async (wordId) => {
            const word = await db.words.get(wordId);
            if (!word) return;
            await db.words.update(wordId, {
              deckIds: mergeDeckIds(word.deckIds ?? [word.deckId], deck.id),
              updatedAt: timestamp
            });
          })
        );
      });
    } catch {
      setCreateDeckStatus(t("status.saveFailed"));
      return;
    } finally {
      setCreatingDeck(false);
    }
    resetDeckCreation();
    setCreateDeckOpen(false);
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

  async function submitDeckRename(event: SubmitEvent<HTMLFormElement>) {
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
    const otherDecks = decks.filter((candidate) => candidate.id !== deck.id);
    const defaultDeck = findDefaultDeck(otherDecks, setup.baseLanguage);
    let destination = defaultDeck?.id ?? "";
    const destinations = otherDecks.map((candidate) => ({ value: candidate.id, label: candidate.name }));
    if (!defaultDeck) {
      destinations.unshift({ value: "", label: t("decks.newDefaultDeck", { name: defaultDeckNames[setup.baseLanguage] }) });
    }
    destinations.push({ value: "delete", label: t("decks.deleteExclusiveWords") });
    const confirmed = await confirm({
      title: t("decks.deleteDeck"),
      message: (
        <div className="grid gap-2">
          <p className="app-heading break-words font-semibold">{deck.name}</p>
          <AppSelect
            label={t("decks.transferDestination")}
            defaultValue={destination}
            options={destinations}
            onChange={(value) => { destination = value; }}
            wrap
          />
        </div>
      ),
      confirmLabel: t("decks.deleteDeck"),
      cancelLabel: t("common.cancel"),
      variant: "danger"
    });
    if (!confirmed) {
      return;
    }

    try {
      await deleteDeckWithWords(deck.id, destination === "delete" ? "delete" : "reassign", destination || undefined);
      await onRefresh();
      onStatus(t("status.deleted"));
    } catch {
      await onRefresh();
      onStatus(t("decks.deleteFailed"));
    }
  }

  function resetDeckCreation() {
    setDeckName("");
    setSelectedWordIds([]);
    setDeckWordSearch("");
    setCreateDeckStatus("");
  }

  function closeCreateDeck() {
    setCreateDeckStatus("");
    setCreateDeckOpen(false);
  }

  return (
    <section className="grid gap-4">
      <header className="view-header">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="app-display text-3xl">{t("decks.title")}</h1>
          <span className="app-muted whitespace-nowrap text-sm font-semibold">{t("ui.deckCount", { count: decks.length })}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="w-36">
            <AppSelect
              value={deckSort}
              ariaLabel={t("decks.sort")}
              compact
              wrap
              options={(["newest", "nameDescending", "nameAscending"] as const).map((value) => ({ value, label: t(`decks.${value}`) }))}
              onChange={(value) => onSortChange(value as DeckSort)}
            />
          </div>
          <button className="app-button app-button-dark" type="button" aria-haspopup="dialog" onClick={() => setCreateDeckOpen(true)}>
            <Plus size={17} strokeWidth={2.4} />
            {t("ui.newDeck")}
          </button>
        </div>
      </header>
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
      {createDeckOpen ? (
        <Modal title={t("decks.createDeck")} onClose={closeCreateDeck} closeDisabled={creatingDeck}>
          <form className="grid gap-3" onSubmit={addDeck}>
            <fieldset className="grid min-w-0 gap-3" disabled={creatingDeck}>
              <Label text={t("decks.deckName")}>
                <input className="app-input" value={deckName} onChange={(event) => setDeckName(event.target.value)} placeholder={t("decks.deckNamePlaceholder")} data-autofocus required />
              </Label>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="app-heading text-sm font-semibold">{t("decks.selectWords")}</h3>
                <span className="app-chip">{selectedWordIds.length} {t("decks.selectedWords")}</span>
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
            </fieldset>
            <div className="app-divider flex flex-wrap items-center justify-end gap-2 border-t pt-3">
              <p className="app-muted mr-auto text-sm" role="status">{createDeckStatus}</p>
              <button className="app-button app-button-ghost" type="button" onClick={resetDeckCreation} disabled={creatingDeck}>
                {t("common.reset")}
              </button>
              <button className="app-button app-button-primary" type="submit" disabled={creatingDeck || !deckName.trim()}>
                {creatingDeck ? <LoadingIndicator label={t("decks.createDeck")} /> : <Plus size={17} />}
                {t("decks.createDeck")}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      <div className="deck-card-grid">
        {decks.map((deck, index) => {
          const stats = deckStats.get(deck.id) ?? { words: 0, learned: 0, learning: 0, fresh: 0, due: 0 };
          const menuOpen = openMenuDeckId === deck.id;
          return (
            <article key={deck.id} className="deck-card" aria-labelledby={`deck-${deck.id}-name`}>
              <div className="flex items-center gap-3">
                <span className={`deck-badge deck-badge-large deck-tone-${index % deckToneCount}`} aria-hidden="true">
                  {deck.name.charAt(0).toLocaleUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 id={`deck-${deck.id}-name`} className="app-display truncate text-lg">{deck.name}</h2>
                  <p className="app-muted text-sm">
                    {t("ui.wordCount", { count: stats.words })}
                    {deck.id === defaultDeckId ? ` · ${t("ui.defaultDeck")}` : ""}
                  </p>
                </div>
                <div className="deck-menu">
                  <button
                    className="study-round-button"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-label={t("ui.deckActions", { name: deck.name })}
                    onClick={() => setOpenMenuDeckId(menuOpen ? null : deck.id)}
                  >
                    <MoreHorizontal size={20} />
                  </button>
                  {menuOpen ? (
                    <div className="deck-menu-popup" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOpenMenuDeckId(null);
                          renameDeck(deck);
                        }}
                      >
                        <Edit2 size={17} />
                        {t("common.rename")}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="app-text-danger"
                        onClick={() => {
                          setOpenMenuDeckId(null);
                          void deleteDeck(deck);
                        }}
                      >
                        <Trash2 size={17} />
                        {t("common.delete")}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              {stats.words > 0 ? (
                <div className="grid gap-2">
                  <div
                    className="deck-progress"
                    role="img"
                    aria-label={`${t("ui.learnedCount", { count: stats.learned })}, ${t("ui.learningCount", { count: stats.learning })}, ${t("ui.newCount", { count: stats.fresh })}`}
                  >
                    {stats.learned ? <span className="deck-progress-learned" style={{ flexGrow: stats.learned }} /> : null}
                    {stats.learning ? <span className="deck-progress-learning" style={{ flexGrow: stats.learning }} /> : null}
                    {stats.fresh ? <span className="deck-progress-new" style={{ flexGrow: stats.fresh }} /> : null}
                  </div>
                  <div className="deck-progress-legend">
                    <span><span className="deck-progress-dot deck-progress-learned" aria-hidden="true" />{t("ui.learnedCount", { count: stats.learned })}</span>
                    <span><span className="deck-progress-dot deck-progress-learning" aria-hidden="true" />{t("ui.learningCount", { count: stats.learning })}</span>
                    <span><span className="deck-progress-dot deck-progress-new" aria-hidden="true" />{t("ui.newCount", { count: stats.fresh })}</span>
                  </div>
                </div>
              ) : (
                <p className="app-muted text-sm">{t("ui.emptyDeck")}</p>
              )}
              <button className="deck-study-button" type="button" onClick={() => onStudyDeck(deck.id)} disabled={stats.due === 0}>
                <span>{stats.due > 0 ? t("ui.studyDue", { count: stats.due }) : t("ui.nothingDue")}</span>
                {stats.due > 0 ? <ArrowRight size={19} strokeWidth={2.4} aria-hidden="true" /> : null}
              </button>
            </article>
          );
        })}
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
  theme,
  onThemeChange,
  onUiLanguageChange,
  onSwitchProfile,
  onSwitchSetup,
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
  theme: ThemeMode;
  onThemeChange: (value: ThemeMode) => void;
  onUiLanguageChange: (value: LanguageCode) => void | Promise<void>;
  onSwitchProfile: (profileId: string) => void;
  onSwitchSetup: (setupId: string) => void | Promise<void>;
  onRefresh: (nextActiveId?: string, showLoading?: boolean) => Promise<void>;
  onStatus: (message: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [creatingSetup, setCreatingSetup] = useState(false);
  const [openSetupMenuId, setOpenSetupMenuId] = useState<string | null>(null);

  useEffect(() => {
    if (!openSetupMenuId) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !(event.target as HTMLElement).closest(".deck-menu")) {
        setOpenSetupMenuId(null);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [openSetupMenuId]);

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

  async function createAdditionalProfile(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newProfileName.trim()) {
      return;
    }

    const created = await createProfile(newProfileName, profile.uiLanguage);
    localStorage.setItem(activeProfileStorageKey, created.id);
    setNewProfileName("");
    await onRefresh(created.id);
  }

  async function createSetup(event: SubmitEvent<HTMLFormElement>) {
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

  async function submitSetupRename(event: SubmitEvent<HTMLFormElement>) {
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

  function openNewPair() {
    // Start on a combination this profile doesn't have yet, so Create never duplicates a pair.
    const base = activeSetup?.baseLanguage ?? setupBaseLanguage;
    const taken = new Set(learningSetups.filter((setup) => setup.baseLanguage === base).map((setup) => setup.targetLanguage));
    const target = languageCodes.find((code) => code !== base && !taken.has(code)) ?? setupTargetLanguage;
    setSetupBaseLanguage(base);
    setSetupTargetLanguage(target);
    setSetupName("");
    setCreatingSetup(true);
  }

  const translationsUsed = usage?.count ?? 0;
  const translationPercent = Math.min(100, Math.round((translationsUsed / myMemoryDailyLimit) * 100));
  const editingSetup = learningSetups.find((setup) => setup.id === editingSetupLanguagesId) ?? null;
  const languageOptions = languageCodes.map((code) => ({
    value: code,
    label: (
      <span className="flex min-w-0 items-center gap-2">
        <FlagIcon code={code} />
        <span className="truncate">{languageOptionLabel(code, i18n.language)}</span>
      </span>
    )
  }));

  return (
    <section className="settings grid min-w-0 gap-6">
      <h1 className="app-display text-3xl">{t("settings.title")}</h1>

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

      {creatingProfile ? (
        <Modal title={t("ui.newProfile")} onClose={() => setCreatingProfile(false)}>
          <form
            className="grid gap-4"
            onSubmit={async (event) => {
              await createAdditionalProfile(event);
              setCreatingProfile(false);
            }}
          >
            <Label text={t("profile.name")}>
              <input className="app-input" value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} placeholder={t("profile.namePlaceholder")} data-autofocus required />
            </Label>
            <p className="app-muted text-sm">{t("profile.count", { count: String(profiles.length) })}</p>
            <button className="app-button app-button-primary app-button-large" type="submit" disabled={!newProfileName.trim()}>
              <Plus size={18} />
              {t("common.create")}
            </button>
          </form>
        </Modal>
      ) : null}

      {creatingSetup ? (
        <Modal title={t("ui.newLanguagePair")} onClose={() => setCreatingSetup(false)}>
          <form
            className="grid gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const existing = learningSetups.find(
                (candidate) => candidate.baseLanguage === setupBaseLanguage && candidate.targetLanguage === setupTargetLanguage
              );
              if (existing) {
                // Switch to the pair the user already has rather than creating a duplicate.
                setCreatingSetup(false);
                onStatus(t("ui.pairExists"));
                await onSwitchSetup(existing.id);
                return;
              }
              await createSetup(event);
              setCreatingSetup(false);
            }}
          >
            <AppSelect
              label={t("setup.targetLanguage")}
              value={setupTargetLanguage}
              options={languageOptions.filter((option) => option.value !== setupBaseLanguage)}
              onChange={(value) => setSetupTargetLanguage(value as LanguageCode)}
            />
            <AppSelect
              label={t("setup.baseLanguage")}
              value={setupBaseLanguage}
              options={languageOptions.filter((option) => option.value !== setupTargetLanguage)}
              onChange={(value) => setSetupBaseLanguage(value as LanguageCode)}
            />
            <Label text={`${t("setup.name")} (${t("common.optional")})`}>
              <input
                className="app-input"
                value={setupName}
                onChange={(event) => setSetupName(event.target.value)}
                placeholder={setupNamePlaceholder(setupBaseLanguage, setupTargetLanguage, i18n.language, t)}
              />
            </Label>
            <button className="app-button app-button-primary app-button-large" type="submit">
              <Plus size={18} />
              {t("common.create")}
            </button>
          </form>
        </Modal>
      ) : null}

      {editingSetup ? (
        <Modal title={t("setup.editLanguages")} onClose={() => setEditingSetupLanguagesId(null)}>
          <div className="grid gap-4">
            <p className="app-muted text-sm">{learningSetupDisplayName(editingSetup, i18n.language)}</p>
            <AppSelect
              label={t("setup.targetLanguage")}
              value={editingTargetLanguage}
              options={languageOptions.filter((option) => option.value !== editingBaseLanguage)}
              onChange={(value) => setEditingTargetLanguage(value as LanguageCode)}
            />
            <AppSelect
              label={t("setup.baseLanguage")}
              value={editingBaseLanguage}
              options={languageOptions.filter((option) => option.value !== editingTargetLanguage)}
              onChange={(value) => setEditingBaseLanguage(value as LanguageCode)}
            />
            <div className="flex justify-end gap-2">
              <button className="app-button app-button-ghost" type="button" onClick={() => setEditingSetupLanguagesId(null)}>
                {t("common.cancel")}
              </button>
              <button className="app-button app-button-primary" type="button" onClick={() => void saveSetupLanguages(editingSetup)}>
                {t("common.save")}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      <input ref={backupMergeInputRef} className="hidden" type="file" accept="application/json,.json" onChange={(event) => void importBackup(event, "merge")} />
      <input ref={backupReplaceInputRef} className="hidden" type="file" accept="application/json,.json" onChange={(event) => void importBackup(event, "replace")} />
      <input ref={csvImportInputRef} className="hidden" type="file" accept=".csv,text/csv" onChange={(event) => void importCsvWords(event)} />

      <SettingsGroup title={t("profile.label")}>
        <div className="settings-row">
          <span className="today-avatar settings-avatar" aria-hidden="true">{initials(profile.name)}</span>
          <span className="settings-row-text">
            <span className="settings-row-title">{profile.name}</span>
            <span className="settings-row-hint">{t("profile.count", { count: String(profiles.length) })}</span>
          </span>
        </div>
        {profiles.length > 1 ? (
          <div className="settings-row">
            <span className="settings-row-text">
              <span className="settings-row-title">{t("profile.switch")}</span>
            </span>
            <div className="settings-row-control">
              <AppSelect
                value={profile.id}
                ariaLabel={t("profile.switch")}
                compact
                options={profiles.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
                onChange={onSwitchProfile}
              />
            </div>
          </div>
        ) : null}
        <button className="settings-row" type="button" aria-haspopup="dialog" onClick={() => setCreatingProfile(true)}>
          <span className="settings-row-icon" aria-hidden="true"><Plus size={18} /></span>
          <span className="settings-row-text"><span className="settings-row-title">{t("ui.newProfile")}</span></span>
          <ChevronRight className="settings-row-chevron" size={18} aria-hidden="true" />
        </button>
      </SettingsGroup>

      <SettingsGroup title={t("settings.languages")}>
        {learningSetups.map((setup) => {
          const active = setup.id === activeSetup?.id;
          const wordCount = setupWordCounts[setup.id] ?? 0;
          const menuOpen = openSetupMenuId === setup.id;
          return (
            <div key={setup.id} className="settings-row">
              <button
                className="settings-setup-main"
                type="button"
                aria-pressed={active}
                onClick={() => {
                  if (!active) void onSwitchSetup(setup.id);
                }}
              >
                <FlagIcon code={setup.targetLanguage} />
                <span className="settings-row-text">
                  <span className="settings-row-title">{learningSetupDisplayName(setup, i18n.language)}</span>
                  <span className="settings-row-hint">
                    {t("setup.baseShort")}: {languageOptionLabel(setup.baseLanguage, i18n.language)} · {t("ui.wordCount", { count: wordCount })}
                  </span>
                </span>
                {active ? (
                  <span className="settings-active-pill"><Check size={14} strokeWidth={3} aria-hidden="true" />{t("ui.activePair")}</span>
                ) : null}
              </button>
              <div className="deck-menu">
                <button
                  className="study-round-button"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={t("ui.deckActions", { name: learningSetupDisplayName(setup, i18n.language) })}
                  onClick={() => setOpenSetupMenuId(menuOpen ? null : setup.id)}
                >
                  <MoreHorizontal size={20} />
                </button>
                {menuOpen ? (
                  <div className="deck-menu-popup" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setOpenSetupMenuId(null); renameSetup(setup); }}>
                      <Edit2 size={17} />
                      {t("common.rename")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={wordCount > 0}
                      onClick={() => { setOpenSetupMenuId(null); beginLanguageEdit(setup); }}
                    >
                      <Languages size={17} />
                      <span className="menu-item-text">
                        {t("setup.editLanguages")}
                        {wordCount > 0 ? <span className="menu-item-hint">{t("setup.languagesLocked")}</span> : null}
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="app-text-danger"
                      disabled={learningSetups.length <= 1}
                      onClick={() => { setOpenSetupMenuId(null); void removeSetup(setup); }}
                    >
                      <Trash2 size={17} />
                      <span className="menu-item-text">
                        {t("common.delete")}
                        {learningSetups.length <= 1 ? <span className="menu-item-hint">{t("setup.keepOne")}</span> : null}
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        <button className="settings-row" type="button" aria-haspopup="dialog" onClick={openNewPair}>
          <span className="settings-row-icon" aria-hidden="true"><Plus size={18} /></span>
          <span className="settings-row-text"><span className="settings-row-title">{t("ui.newLanguagePair")}</span></span>
          <ChevronRight className="settings-row-chevron" size={18} aria-hidden="true" />
        </button>
      </SettingsGroup>

      <SettingsGroup title={t("settings.preferences")}>
        <div className="settings-row">
          <span className="settings-row-text"><span className="settings-row-title">{t("profile.uiLanguage")}</span></span>
          <div className="settings-row-control">
            <AppSelect
              value={profile.uiLanguage}
              ariaLabel={t("profile.uiLanguage")}
              compact
              options={languageOptions}
              onChange={(value) => onUiLanguageChange(value as LanguageCode)}
            />
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-text"><span className="settings-row-title">{t("settings.theme")}</span></span>
          <div className="settings-segmented" role="group" aria-label={t("settings.theme")}>
            {(["light", "dark"] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={theme === mode} onClick={() => onThemeChange(mode)}>
                {mode === "light" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
                {t(mode === "light" ? "settings.themeLight" : "settings.themeDark")}
              </button>
            ))}
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.usage")}>
        <div className="settings-row settings-usage">
          <span className="settings-row-text">
            <span className="settings-row-title">{t("ui.lookupsUsed", { used: translationsUsed, limit: myMemoryDailyLimit })}</span>
            <span className="settings-usage-meter" aria-hidden="true"><span style={{ width: `${translationPercent}%` }} /></span>
          </span>
          <span className={`settings-status-pill ${online ? "settings-status-online" : "settings-status-offline"}`}>
            {online ? t("connection.online") : t("connection.offline")}
          </span>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.data")}>
        <SettingsActionRow
          icon={<Download size={18} />}
          title={t("settings.exportBackup")}
          hint={t("ui.exportBackupHint")}
          busy={localBusy === "exportBackup"}
          disabled={settingsBusy}
          onClick={() => void exportBackup()}
        />
        <SettingsActionRow
          icon={<Upload size={18} />}
          title={t("settings.importBackupMerge")}
          hint={t("settings.importBackupMergeHint")}
          busy={localBusy === "importBackupMerge"}
          disabled={settingsBusy}
          onClick={() => backupMergeInputRef.current?.click()}
        />
        <SettingsActionRow
          icon={<RotateCcw size={18} />}
          title={t("settings.importBackupReplace")}
          hint={t("settings.importBackupReplaceHint")}
          busy={localBusy === "importBackupReplace"}
          disabled={settingsBusy}
          onClick={() => backupReplaceInputRef.current?.click()}
        />
        <SettingsActionRow
          icon={<FileUp size={18} />}
          title={t("settings.importCsv")}
          hint={t("settings.importCsvHint")}
          busy={localBusy === "importCsv"}
          disabled={!activeSetup || settingsBusy}
          onClick={() => csvImportInputRef.current?.click()}
        />
        <SettingsActionRow
          icon={<FileDown size={18} />}
          title={t("library.exportCsv")}
          hint={t("ui.exportCsvHint")}
          onClick={() => downloadTextFile("lexora-export.csv", createCsvExport(words, decks), "text/csv")}
        />
      </SettingsGroup>

      <SettingsGroup title={t("cloud.title")}>
        {!cloudProvider.isConfigured() ? (
          <div className="settings-row">
            <span className="settings-row-icon" aria-hidden="true"><Cloud size={18} /></span>
            <span className="settings-row-text">
              <span className="settings-row-title">{t("cloud.notConnected")}</span>
              <span className="settings-row-hint">{t("cloud.notConfigured")}</span>
            </span>
          </div>
        ) : (
          <>
            <div className="settings-row">
              <span className="settings-row-icon" aria-hidden="true"><Cloud size={18} /></span>
              <span className="settings-row-text">
                <span className="settings-row-title">{cloudConnected ? t("cloud.connected") : t("cloud.notConnected")}</span>
                <span className="settings-row-hint">
                  {lastCloudBackupAt ? t("cloud.lastBackup", { date: new Date(lastCloudBackupAt).toLocaleString(i18n.language) }) : t("cloud.body")}
                </span>
              </span>
              {cloudConnected ? (
                <button className="app-button app-button-secondary" type="button" onClick={disconnectCloud} disabled={cloudBusy}>
                  {t("cloud.disconnect")}
                </button>
              ) : (
                <button className="app-button app-button-primary" type="button" onClick={() => void connectCloud()} disabled={cloudBusy || !online}>
                  {cloudBusy ? <LoadingIndicator label={t("cloud.connectGoogle")} /> : null}
                  {t("cloud.connectGoogle")}
                </button>
              )}
            </div>
            <div className="settings-row settings-row-stack">
              <Label text={t("cloud.folderPath")}>
                <input className="app-input" value={cloudFolderPath} onChange={(event) => setCloudFolderPath(event.target.value)} placeholder={defaultCloudBackupFolder} />
              </Label>
            </div>
            <label className="settings-row">
              <span className="settings-row-text">
                <span className="settings-row-title">{t("cloud.autoBackup")}</span>
                <span className="settings-row-hint">{t("cloud.autoBackupHint")}</span>
              </span>
              <input className="settings-switch" type="checkbox" role="switch" checked={cloudAutoBackup} onChange={(event) => setCloudAutoBackup(event.target.checked)} />
            </label>
            <SettingsActionRow
              icon={<Upload size={18} />}
              title={t("cloud.backupNow")}
              busy={cloudBusy}
              disabled={cloudBusy || !online}
              onClick={() => void backupToCloud()}
            />
            {!online ? <p className="settings-row settings-row-hint">{t("cloud.offline")}</p> : null}
            <div className="settings-row settings-row-stack">
              <div className="flex items-center justify-between gap-2">
                <span className="settings-row-title">{t("cloud.backups")}</span>
                <button className="text-button" type="button" onClick={() => void refreshCloudBackups()} disabled={cloudBusy || !online || !cloudConnected}>
                  <RotateCcw size={16} />
                  {t("cloud.refresh")}
                </button>
              </div>
              {cloudBackups.length === 0 ? <p className="settings-row-hint">{t("cloud.noBackups")}</p> : null}
              {cloudBackups.map((backup) => (
                <div key={backup.id} className="settings-cloud-backup">
                  <span className="min-w-0">
                    <span className="settings-row-title block truncate">{backup.name}</span>
                    <span className="settings-row-hint">{new Date(backup.modifiedTime).toLocaleString(i18n.language)}</span>
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <button className="app-button app-button-secondary app-button-compact" type="button" onClick={() => void importCloudBackup(backup, "merge")} disabled={cloudBusy || !online}>
                      {t("settings.importBackupMerge")}
                    </button>
                    <button className="app-button app-button-secondary app-button-compact" type="button" onClick={() => void importCloudBackup(backup, "replace")} disabled={cloudBusy || !online}>
                      {t("settings.importBackupReplace")}
                    </button>
                    <button className="app-button app-button-ghost app-icon-button app-text-danger" type="button" onClick={() => void deleteCloudBackup(backup)} disabled={cloudBusy || !online} aria-label={t("cloud.deleteBackup")}>
                      <Trash2 size={17} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </SettingsGroup>

      <div className="settings-card">
        <button className="settings-row settings-danger" type="button" onClick={resetData}>
          <span className="settings-row-icon" aria-hidden="true"><Trash2 size={18} /></span>
          <span className="settings-row-text">
            <span className="settings-row-title">{t("settings.resetAll")}</span>
            <span className="settings-row-hint">{t("settings.resetWarning")}</span>
          </span>
        </button>
      </div>
    </section>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section className="settings-group" aria-labelledby={id}>
      <h2 id={id} className="section-label">{title}</h2>
      <div className="settings-card">{children}</div>
    </section>
  );
}

function SettingsActionRow({ icon, title, hint, busy = false, disabled = false, onClick }: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="settings-row" type="button" onClick={onClick} disabled={disabled}>
      <span className="settings-row-icon" aria-hidden="true">{busy ? <LoadingIndicator label={title} /> : icon}</span>
      <span className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {hint ? <span className="settings-row-hint">{hint}</span> : null}
      </span>
      <ChevronRight className="settings-row-chevron" size={18} aria-hidden="true" />
    </button>
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
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void | Promise<void>;
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

type ScheduleResult = { ok: true; scheduled: Partial<CardState> } | { ok: false };

/** The latest review time saved for a card, from its scheduler state or the card record. */
function lastSavedReview(card: CardState): number | undefined {
  const times = [card.fsrsCard?.last_review, card.lastReviewedAt]
    .map((value) => (typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : Number.NaN))
    .filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : undefined;
}

/**
 * Schedules a review without ever discarding the card's saved history.
 *
 * If the device clock is behind the card's last review (a clock or time-zone change, or a backup
 * from another device), the review is placed at that last review instead of before it, which the
 * scheduler would reject as negative elapsed time. Any other failure returns `ok: false` and the
 * caller saves nothing, so the stored card stays exactly as it was.
 */
function scheduleWithSavedHistory(
  card: CardState,
  rating: ReviewRating,
  now = new Date(),
  { logFailure = true }: { logFailure?: boolean } = {}
): ScheduleResult {
  const lastReview = lastSavedReview(card);
  const reviewedAt = lastReview !== undefined && lastReview > now.getTime() ? new Date(lastReview) : now;
  try {
    return { ok: true, scheduled: scheduleReview(card, rating, reviewedAt) };
  } catch (error) {
    if (logFailure) console.error("Could not schedule review for card", card.id, error);
    return { ok: false };
  }
}

/** How many decks the Today screen lists before "See all". */
const todayDeckLimit = 4;

/** Number of deck colour tones defined in index.css (.deck-tone-0 …). */
const deckToneCount = 4;

function initials(name: string): string {
  const letters = name.trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0).toLocaleUpperCase());
  return letters.join("") || "?";
}

function preferredLibraryDeckId(decks: Deck[], baseLanguage: LanguageCode): string {
  return findDefaultDeck(decks, baseLanguage)?.id ?? decks[0]?.id ?? "";
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
  t: (key: string, values: { base: string; target: string }) => string
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

function getPrompt(studyCard: StudyCard): string {
  return studyCard.card.direction === "target-base" ? studyCard.word.targetText : studyCard.word.translations[0] ?? "";
}

function getAcceptedAnswers(studyCard: StudyCard): string[] {
  return studyCard.card.direction === "target-base" ? studyCard.word.translations : [studyCard.word.targetText];
}

function directionLabel(direction: CardDirection, t: (key: string) => string): string {
  return direction === "target-base" ? t("study.targetBase") : t("study.baseTarget");
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

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}
