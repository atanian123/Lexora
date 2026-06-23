# Lexora — Requirements Document

**Version:** 1.2  
**Date:** 2026-06-17  
**Status:** Draft

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Functional Requirements](#2-functional-requirements)
   - 2.1 [Language Configuration](#21-language-configuration)
   - 2.2 [Learning Setups](#22-learning-setups)
   - 2.3 [Word & Phrase Management](#23-word--phrase-management)
   - 2.4 [Translation](#24-translation)
   - 2.5 [Decks & Subsets](#25-decks--subsets)
   - 2.6 [Exercise / Flashcard Mode](#26-exercise--flashcard-mode)
   - 2.7 [Spaced Repetition](#27-spaced-repetition)
   - 2.8 [User Profiles](#28-user-profiles)
   - 2.9 [Data Portability](#29-data-portability)
3. [Non-Functional Requirements](#3-non-functional-requirements)
   - 3.1 [Platform & Installability](#31-platform--installability)
   - 3.2 [Offline Support](#32-offline-support)
   - 3.3 [Performance](#33-performance)
   - 3.4 [Accessibility](#34-accessibility)
   - 3.5 [Extensibility](#35-extensibility)
   - 3.6 [Internationalisation](#36-internationalisation)
   - 3.7 [Data & Privacy](#37-data--privacy)
4. [Technical Stack](#4-technical-stack)
5. [Architecture Decisions](#5-architecture-decisions)
6. [Out of Scope — Phase 1](#6-out-of-scope--phase-1)
7. [Open Questions](#7-open-questions)
8. [Glossary](#8-glossary)
9. [Phase 1 Implementation Plan](#9-phase-1-implementation-plan)

---

## 1. Project Overview

**Lexora** is a Progressive Web App (PWA) for self-directed vocabulary and phrase learning. Users add words in a foreign language, confirm a machine-provided translation, then practice via a flashcard loop driven by a spaced-repetition algorithm. The app works fully offline after the first load and is installable on both desktop and mobile devices.

**Target users (phase 1):** personal / small family group  
**Target users (phase 2+):** public, multi-user

---

## 2. Functional Requirements

### 2.1 Language Configuration

| ID | Requirement |
|----|-------------|
| FR-01 | The user selects an **app language** (the language used for UI labels, buttons, messages, and settings). |
| FR-02 | The user selects one active **learning setup**, which defines the base language and target language used for vocabulary, translation, and exercises. |
| FR-03 | Supported languages in phase 1: **English (EN), German (DE), Bulgarian (BG), French (FR), Italian (IT), Spanish (ES), Portuguese (PT), Russian (RU)**. |
| FR-04 | The app UI is rendered in the selected **app language**, independently from any learning setup's base or target language. |
| FR-05 | The app language can be changed in settings at any time. Existing learning data is preserved. |

---

### 2.2 Learning Setups

| ID | Requirement |
|----|-------------|
| FR-06 | Each profile can contain multiple **learning setups** (e.g. "Spanish over German", "French over German", "Italian over English"). |
| FR-07 | A learning setup stores: profile ID, display name, base language, target language, creation date, and updated date. |
| FR-08 | Exactly one learning setup is active per profile at a time. The user can switch the active setup from the main app UI. |
| FR-09 | On first launch, after creating a profile, the user must create an initial learning setup before entering the main app. |
| FR-10 | The user can create, rename, and delete learning setups. Deleting a setup deletes or exports its scoped decks, words, subsets, and SRS progress after confirmation. |
| FR-11 | A learning setup's base/target languages can be edited only while the setup has no words. Once words exist, the user creates a new setup for a different language pair. This prevents changing the meaning of stored translations and review history. |
| FR-12 | Learning setup IDs are stable and are used to scope decks, words, subsets, and SRS card state. |

---

### 2.3 Word & Phrase Management

| ID | Requirement |
|----|-------------|
| FR-13 | The user can add a **word or phrase** in the active learning setup's target language. |
| FR-14 | Each entry stores: learning setup ID, target-language text, one or more accepted base-language translations, optional notes, the deck it belongs to, and SRS metadata. |
| FR-15 | A word may have **multiple accepted translations**; all are treated as correct during exercise. |
| FR-16 | The user can **edit** or **delete** any word at any time from the library view. |
| FR-17 | The library view shows all words in the active setup with their translations, deck, language pair, and last-reviewed date. |
| FR-18 | The library supports **search and filter** by deck and review status within the active learning setup. |

---

### 2.4 Translation

| ID | Requirement |
|----|-------------|
| FR-19 | When the user adds a word, the app **automatically fetches translation suggestions** from the translation API using the active learning setup's target-to-base language pair. |
| FR-20 | The user is shown the suggestions (with confidence scores if available) and **confirms or selects** the preferred translation. |
| FR-21 | The user may **manually type** a translation instead of or in addition to the API suggestion. |
| FR-22 | The user may **accept multiple translations** for a single word. |
| FR-23 | If the translation API is unavailable (offline), the user can still add a word with a manual translation. |
| FR-24 | The translation provider is abstracted behind a **provider interface**, enabling future provider swap or addition without changing app logic. |
| FR-25 | **Phase 1 provider:** MyMemory API (`api.mymemory.translated.net`) — no API key required, browser-direct calls. |
| FR-26 | The app displays a **persistent usage indicator** (e.g. an amber/orange bar or badge) showing how close the session is to the MyMemory anonymous daily limit (500 requests). When the limit is reached, translation fetch is disabled for the remainder of the day and the user is informed; manual translation entry remains available. |

#### Translation Provider Interface (reference)

```typescript
interface TranslationProvider {
  name: string;
  translate(text: string, from: string, to: string): Promise<TranslationResult[]>;
  isAvailable(): boolean;
}

interface TranslationResult {
  text: string;
  confidence: number; // 0–1
  source: string;     // provider name, e.g. "mymemory"
}
```

---

### 2.5 Decks & Subsets

| ID | Requirement |
|----|-------------|
| FR-27 | Words are organised into **decks** (e.g. "Travel", "Food", "Work"). A word belongs to exactly one deck. |
| FR-28 | Decks belong to exactly one learning setup. |
| FR-29 | A **default deck** is created automatically for each new learning setup. |
| FR-30 | The user can create, rename, and delete decks. Deleting a deck prompts to reassign or delete its words. |
| FR-31 | Before starting an exercise session the user selects the **exercise scope**: all words, a specific deck, or a saved custom subset within the active learning setup. |
| FR-32 | A **custom subset** is a saved, reusable named collection defined by selecting individual words from the active setup's library. Custom subsets can be created, renamed, edited, and deleted by the user. |

---

### 2.6 Exercise / Flashcard Mode

| ID | Requirement |
|----|-------------|
| FR-33 | The exercise presents words as **flashcards** one at a time. |
| FR-34 | The user selects the **card direction** before or during a session: **target → base**, **base → target**, or **mixed** (random per card). |
| FR-35 | The front of the card shows the prompt; the user types their answer and submits. |
| FR-36 | After submission the app reveals the correct answer(s) and the user **self-rates** the result: Again / Hard / Good / Easy (aligned with FSRS rating scale). |
| FR-37 | **Fuzzy matching** is applied: a typo of exactly **1 character** (Levenshtein distance = 1) is flagged as "close" rather than outright wrong, and the user decides whether to accept. This tolerance is fixed and not user-configurable in phase 1. |
| FR-38 | The session ends when the scheduled card queue is empty. A **session summary** is shown (cards reviewed, accuracy, streak). |
| FR-39 | The user can **pause or abandon** a session at any time; progress for already-rated cards is saved. |

---

### 2.7 Spaced Repetition

| ID | Requirement |
|----|-------------|
| FR-40 | The app uses the **FSRS (Free Spaced Repetition Scheduler)** algorithm to determine when each card is next due. |
| FR-41 | Cards rated **Again** are re-queued within the current session and scheduled for the near future. |
| FR-42 | Cards rated **Hard / Good / Easy** receive progressively longer review intervals. |
| FR-43 | **Difficult words** (repeatedly rated Again or Hard) are surfaced more frequently until consistently rated Good or Easy. |
| FR-44 | Words not recently reviewed are occasionally included in sessions for **long-term retention**. |
| FR-45 | FSRS state per card is stored locally: stability, difficulty, due date, review count, last rating. |
| FR-46 | FSRS scheduling is tracked **per card direction**. A word or phrase has separate SRS state for **target → base** and **base → target**, because each direction may have different difficulty and review history. |

---

### 2.8 User Profiles

| ID | Requirement |
|----|-------------|
| FR-47 | Phase 1 supports **named local profiles** (e.g. family members) selectable from a profile switcher on the home screen. No login required. |
| FR-48 | On first launch, if no profile exists, the user must create a named local profile before entering the main app. No anonymous/default profile is created automatically. |
| FR-49 | Each profile has its own app language preference, learning setups, word library, decks, and SRS progress. |
| FR-50 | Phase 2 will introduce optional **cloud sync** and authentication; the local profile and learning setup model must not conflict with this future state. |
| FR-51 | Translation API usage tracking is shared across all local profiles on the same browser/device, because the MyMemory anonymous limit applies to the client session rather than to an individual Lexora profile. |
| FR-52 | The MyMemory usage counter resets once per local calendar day, using the browser's local date. |

---

### 2.9 Data Portability

| ID | Requirement |
|----|-------------|
| FR-53 | The user can export a full Lexora backup as JSON, including profiles, learning setups, decks, words, custom subsets, per-direction SRS card state, and translation usage metadata. |
| FR-54 | The user can import a Lexora JSON backup in **merge** mode. Existing records with the same IDs are updated; unrelated local records are preserved. |
| FR-55 | The user can restore a Lexora JSON backup in **replace** mode after confirmation. This clears local Lexora data on the device and replaces it with the backup contents. |
| FR-56 | The user can import a CSV word list into the active learning setup. Supported columns include target text, translations, deck, and notes; duplicates by target text in the active setup are skipped. |
| FR-57 | Direct Duolingo account connection is not part of phase 1 because there is no stable official vocabulary import API available for browser-direct use. Duolingo-derived word lists may be imported through the generic CSV path if the user obtains an export elsewhere. |

---

## 3. Non-Functional Requirements

### 3.1 Platform & Installability

| ID | Requirement |
|----|-------------|
| NFR-01 | The app is a **Progressive Web App (PWA)** installable on Android, iOS, Windows, and macOS via the browser's "Add to Home Screen" / "Install" prompt. |
| NFR-02 | The UI is **fully responsive**: optimised for mobile (≥ 320 px) and comfortable on tablet and desktop. |
| NFR-03 | The app passes a **Lighthouse PWA audit** score of ≥ 90. |

---

### 3.2 Offline Support

| ID | Requirement |
|----|-------------|
| NFR-04 | All app assets (JS, CSS, fonts, icons) are **cached by the service worker** on first load. |
| NFR-05 | Exercise and library functions work **fully offline**. |
| NFR-06 | Translation fetch gracefully degrades offline (FR-16). |
| NFR-07 | Data is persisted in **IndexedDB via Dexie.js** — no server required in phase 1. |

---

### 3.3 Performance

| ID | Requirement |
|----|-------------|
| NFR-08 | First Contentful Paint (FCP) ≤ 1.5 s on a mid-range mobile device on Wi-Fi. |
| NFR-09 | Flashcard interactions (flip, submit, advance) complete in ≤ 100 ms (excluding network). |
| NFR-10 | The app remains responsive with a library of up to **10,000 words**. |

---

### 3.4 Accessibility

| ID | Requirement |
|----|-------------|
| NFR-11 | All interactive elements are keyboard-navigable. |
| NFR-12 | Colour contrast meets **WCAG 2.1 AA** for text and UI components. |
| NFR-13 | The app is screen-reader compatible (ARIA labels on cards, buttons, and form fields). |

---

### 3.5 Extensibility

| ID | Requirement |
|----|-------------|
| NFR-14 | The translation layer uses a **provider interface** (see FR-17) so additional providers (DeepL, Google Translate, Azure Translator) can be added without modifying app logic. |
| NFR-15 | The audio/speech layer is reserved in the component architecture (speaker icon placeholder on cards) to support **TTS and STT in phase 3** without structural refactoring. |
| NFR-16 | The data schema is versioned via **Dexie migrations** to support non-breaking schema evolution. |
| NFR-17 | The sync layer is designed for **Dexie Cloud** integration in phase 2 with no schema changes required. |

---

### 3.6 Internationalisation

| ID | Requirement |
|----|-------------|
| NFR-18 | App UI strings are externalised via **i18next** — no hard-coded labels in components. |
| NFR-19 | UI translations are provided for all 8 supported languages (EN, DE, BG, FR, IT, ES, PT, RU). |
| NFR-20 | Date/time formatting respects the user's locale. |
| NFR-21 | RTL layout is not required in phase 1 (none of the 8 languages are RTL). |

---

### 3.7 Data & Privacy

| ID | Requirement |
|----|-------------|
| NFR-22 | All user data (words, progress, profiles) is stored **locally on the device** in phase 1. Nothing is sent to any server except translation API requests. |
| NFR-23 | Translation API calls send **only the word/phrase text** and the language pair — no user identity or profile data. |
| NFR-24 | No analytics, tracking scripts, or third-party SDKs are included in phase 1. |
| NFR-25 | The user can **export and import** data for backup or migration: full JSON backup/restore for all local Lexora data, plus CSV word-list import/export for active learning setups. |
| NFR-26 | The user can **delete** all local data (full reset) from settings. |

---

## 4. Technical Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Framework | **React 19 + Vite + TypeScript** | Mature PWA tooling, large ecosystem, strong typing |
| PWA | **vite-plugin-pwa** (Workbox) | Service worker + manifest generation, offline caching |
| Styling | **Tailwind CSS** | Mobile-first, no runtime overhead |
| Local DB | **Dexie.js** (IndexedDB) | Offline-first, TypeScript-friendly, Dexie Cloud-ready |
| Spaced Repetition | **ts-fsrs** | FSRS algorithm, actively maintained, TypeScript |
| Translation (phase 1) | **MyMemory API** | No API key, browser-direct, supports all 8 languages |
| i18n | **i18next + react-i18next** | Industry standard, lazy loading, pluralisation |
| Future sync | **Dexie Cloud** | Drop-in sync for Dexie, no backend required |

---

## 5. Architecture Decisions

### AD-01 — No backend in phase 1
All logic runs in the browser. The translation API (MyMemory) is called directly from the client. This avoids secret management and infrastructure cost. A thin backend will be introduced in phase 2 to hold API keys for premium translation providers and to power cloud sync.

### AD-02 — Translation provider abstraction
A `TranslationProvider` interface is defined from day one. The active provider is resolved via a factory/registry, making provider swap a configuration change. See FR-17.

### AD-03 — FSRS over SM-2
FSRS is more accurate than SM-2 for scheduling, is open-source, and is implemented in the `ts-fsrs` npm package. It uses the same four-button rating UI familiar from Anki.

### AD-04 — Local-first data, cloud-sync ready
Dexie.js is chosen because it maps cleanly to Dexie Cloud's sync protocol. Adding sync in phase 2 requires only adding the cloud adapter — no schema or query changes.

### AD-05 — Named local profiles, no auth in phase 1
A simple profile switcher (stored in IndexedDB) enables family use without requiring login infrastructure. Phase 2 will introduce proper auth (e.g. email/password or OAuth) with profile migration.

### AD-06 — Learning setup as the language-pair boundary
A profile can contain multiple learning setups. Decks, custom subsets, words, and per-direction FSRS cards are scoped to a learning setup rather than directly to the profile. This lets one learner study multiple target/base combinations (for example ES over DE and FR over DE) without mixing libraries or requiring a later schema rewrite.

### AD-07 — App language is independent from study language
The app UI language is a profile preference and does not have to match the active learning setup's base language. This supports users who prefer the app interface in one language while studying another language pair.

---

## 6. Out of Scope — Phase 1

The following features are explicitly deferred to later phases:

| Feature | Phase |
|---------|-------|
| Cloud sync & multi-device | 2 |
| User authentication | 2 |
| Direct Duolingo account integration | 2 / TBD |
| Public sharing of decks | 2 |
| Text-to-speech (listen to word pronunciation) | 3 |
| Speech-to-text (speak the answer) | 3 |
| Additional translation providers (DeepL, Google, Azure) | 2 |
| Gamification (points, streaks, leaderboards) | TBD |
| Image association with words | TBD |
| Sentence / example usage display | TBD |

---

## 7. Open Questions

| # | Question | Resolution | Status |
|---|----------|------------|--------|
| OQ-01 | Should fuzzy matching tolerance be user-configurable, or fixed? | Fixed at **1 character** (Levenshtein = 1) in phase 1. See FR-29. | ✅ Resolved |
| OQ-02 | Should the MyMemory `email` parameter be included to raise the daily limit? | Not for phase 1. An **amber usage indicator** is shown instead. See FR-19. Can be revisited later. | ✅ Resolved |
| OQ-03 | What is the desired app name? | **Lexora** | ✅ Resolved |
| OQ-04 | Should decks be shareable between profiles on the same device? | Not in phase 1. Each profile has isolated decks. | ✅ Resolved |
| OQ-05 | Is a dark mode required for phase 1? | No. Light mode only in phase 1. | ✅ Resolved |
| OQ-06 | Should SRS scheduling be tracked per word or per card direction? | Per card direction. `target → base` and `base → target` each maintain separate FSRS state. See FR-46. | ✅ Resolved |
| OQ-07 | Are custom subsets temporary session selections or saved reusable collections? | Saved reusable named collections, editable and deletable by the user. See FR-32. | ✅ Resolved |
| OQ-08 | Is MyMemory usage tracked per profile or across profiles? | Across all local profiles on the same browser/device, resetting each local calendar day. See FR-51 and FR-52. | ✅ Resolved |
| OQ-09 | Should a default profile be created automatically on first launch? | No. The user must create a named local profile before entering the app. See FR-48. | ✅ Resolved |
| OQ-10 | Should the app language be the same as the base language? | No. App language is a separate profile preference. Learning setups define base and target languages. See FR-01, FR-04, and FR-06. | ✅ Resolved |
| OQ-11 | Should multiple language pairs be supported in one profile? | Yes. Phase 1 supports multiple learning setups per profile, each with its own base/target language pair and scoped learning data. See FR-06 through FR-12. | ✅ Resolved |

---

## 8. Glossary

| Term | Definition |
|------|------------|
| **Base language** | The language the user already knows for a specific learning setup; accepted translations are stored in this language. |
| **Target language** | The foreign language the user is learning. |
| **App language** | The language used for Lexora UI labels, buttons, messages, and settings. It is independent from learning setup languages. |
| **Learning setup** | A profile-owned study configuration containing a base language, target language, and scoped decks, words, subsets, and SRS progress. |
| **Card direction** | Whether the prompt shown is in the target or base language. |
| **Deck** | A named group of words, used to organise and scope exercises. |
| **FSRS** | Free Spaced Repetition Scheduler — the algorithm that determines card review intervals. |
| **SRS** | Spaced Repetition System — the general technique of reviewing material at increasing intervals. |
| **Fuzzy matching** | Accepting answers with a 1-character spelling difference (Levenshtein distance = 1) as "close" rather than wrong. |
| **PWA** | Progressive Web App — a web application installable on device with offline support. |
| **Lexora** | The name of this application. |
| **MyMemory** | The translation API used in phase 1 (`api.mymemory.translated.net`). Anonymous limit: 500 requests/day. |
| **i18next** | The internationalisation library used for app UI translations. |
| **Dexie.js** | A wrapper around the browser's IndexedDB, used as the local database. |
| **ts-fsrs** | TypeScript implementation of the FSRS spaced repetition algorithm. |

---

## 9. Phase 1 Implementation Plan

Phase 1 targets the complete scope defined in this document. Implementation should be delivered incrementally so functional and architectural risks are found early while still converging on the full phase 1 app.

| Subphase | Goal | Included scope |
|----------|------|----------------|
| 1. Foundation | Establish the installable local-first application shell. | React 19 + Vite + TypeScript, Tailwind CSS, PWA manifest/service worker, i18next setup, routing/layout, accessibility baseline. |
| 2. Local data model | Implement durable offline storage and profile/setup boundaries. | Dexie schema/versioning, first-launch profile creation, profile switcher, app-language preference, learning setup CRUD, active setup selection, default deck creation per setup, Dexie Cloud-ready identifiers. |
| 3. Library management and data portability | Build the core vocabulary management workflow and local migration tools. | Setup-scoped deck CRUD, saved custom subset CRUD, add/edit/delete words and phrases, multiple accepted translations, notes, search/filter, full JSON backup export/import, CSV word import/export, full local reset. |
| 4. Translation layer | Add provider-based translation suggestions with graceful offline fallback. | Translation provider interface, MyMemory provider, local daily request counter shared across profiles, usage indicator, manual translation path. |
| 5. Exercise engine | Deliver the flashcard study loop. | Scope selection, direction selection, typed answers, 1-character fuzzy matching, close-answer handling, self-rating, pause/abandon, session summary. |
| 6. FSRS scheduling | Integrate spaced repetition behavior. | `ts-fsrs` integration, per-direction card state, due queues, Again re-queueing, difficult-card surfacing, long-term retention behavior. |
| 7. Phase 1 hardening | Verify production readiness against non-functional requirements. | Offline behavior, responsive layout from 320 px upward, keyboard/screen-reader checks, Lighthouse PWA target, 10,000-word performance checks, final UI translations for all supported languages. |
