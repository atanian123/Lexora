# Lexora

Lexora is an offline-first Progressive Web App for vocabulary and phrase learning. It helps a learner build a personal word library, organize it by language setup and deck, and practice with typed flashcards scheduled by spaced repetition.

The app is designed for personal and small-family use in phase 1: all learning data stays in the browser, profiles are local, and the app can be installed on desktop and mobile devices.

## What Lexora Delivers

- Local-first vocabulary learning with no account required.
- Multiple named learner profiles on the same device.
- Multiple learning setups per profile, for example Spanish from German and French from German.
- Separate app language and study languages.
- Word and phrase library with translations, notes, decks, filters, and search.
- Translation suggestions through MyMemory, with manual entry always available.
- Typed flashcard practice with answer checking, close-answer handling, and FSRS scheduling.
- Per-direction review history: target to base and base to target are tracked independently.
- Full JSON backup and restore, Google Drive cloud backup, plus CSV word import/export.
- Installable PWA behavior with service-worker caching.

## Supported Languages

Lexora supports the following app and study languages in phase 1:

- English
- German
- Bulgarian
- French
- Italian
- Spanish
- Portuguese
- Russian

The app UI language is selected per profile and does not need to match the base language of a learning setup.

## Core Concepts

**Profile**  
A local learner account on the device. Each profile has its own app language, learning setups, decks, words, subsets, and review progress.

**Learning setup**  
A study configuration with one base language and one target language. A profile can have multiple setups. Learning data is scoped to the setup so different language pairs do not mix.

**Base language**  
The language the learner already knows. Accepted translations are stored in this language.

**Target language**  
The language the learner is practicing.

**Deck**  
A named group of words inside one learning setup.

**Subset**  
A saved custom selection of words used to practice a focused group.

**Due card**  
A card scheduled for review now by the spaced-repetition system.

## User Workflow

1. Create a named profile on first launch.
2. Create an initial learning setup by choosing base and target languages.
3. Add words or phrases in the Library.
4. Accept translation suggestions or enter translations manually.
5. Organize entries into decks or subsets.
6. Open Study, choose scope and direction, and start a session.
7. Type answers, review the result, and continue with Next.
8. Export a backup or connect Google Drive when moving devices or protecting local data.

## Library

The Library is the main vocabulary workspace.

Supported actions:

- Add a word or phrase in the active target language.
- Fetch translation suggestions from MyMemory.
- Add one or more accepted translations.
- Add optional notes or context.
- Assign the entry to a deck.
- Edit or delete existing entries.
- Search words, translations, and notes.
- Filter by deck and review status.
- Monitor daily translation usage.

Manual translation entry remains available when offline or when the translation quota is reached.

## Study

The Study screen starts practice sessions from the active learning setup.

Study options:

- **Scope:** all words, one deck, or one saved subset.
- **Direction:** target to base, base to target, or mixed.
- **Due:** cards scheduled for review now.
- **Practice anyway:** include cards that are not due yet.

During a session:

- The learner types an answer and presses Enter or Submit.
- Lexora reveals the correct answer and marks the result as correct, close, or wrong.
- A close answer can be accepted manually.
- Lexora preselects a scheduling rating:
  - correct: Good
  - wrong: Again
  - close: Again unless accepted, then Hard
- The primary action is Next. The rating can still be changed before moving on.
- After Next, focus returns to the answer input for fast keyboard practice.

Session controls:

- **Pause:** keeps the current session open so it can be resumed.
- **End session:** exits the current session. Already rated cards remain saved.
- **Summary:** shown only after a real session with reviewed cards.
- **No cards due:** shown separately when no scheduled cards match the selected scope.

## Spaced Repetition

Lexora uses `ts-fsrs`, a TypeScript implementation of FSRS.

Each word has separate card state per direction:

- target to base
- base to target

This matters because recognizing a foreign word and producing that word from the base language can have different difficulty and review timing.

The four ratings affect scheduling:

- **Again:** missed it; the card is re-queued and scheduled soon.
- **Hard:** remembered with effort.
- **Good:** remembered correctly.
- **Easy:** remembered immediately.

## Data Portability

Data portability is available from Settings.

**Export backup**  
Exports a full Lexora JSON backup including profiles, learning setups, decks, words, subsets, card review state, and translation usage metadata.

**Import backup**  
Merges backup data into the current browser data. Existing records with the same IDs are updated, and unrelated local data is preserved.

**Restore backup**  
Replaces all local Lexora data on the device with the backup contents. This requires confirmation.

**Export CSV**  
Exports the active word list in a spreadsheet-friendly format.

**Import CSV words**  
Adds words to the active learning setup. Duplicate target words in that setup are skipped.

Supported CSV columns:

```csv
targetText,translations,deck,notes
casa,house; home,Basics,Common noun
gracias,thank you,Phrases,
```

Accepted header aliases include `target`, `word`, `phrase`, `translation`, `translations`, `base`, `meaning`, `deck`, `deckName`, `note`, `notes`, `context`, and `example`.

Direct Duolingo account import is not included in phase 1 because there is no stable official browser-friendly Duolingo vocabulary API. If a user obtains a word list from another source, it can be imported through CSV.

## Google Drive Backup

Lexora can store JSON backups in Google Drive while keeping all local import/export options available.

Supported cloud actions:

- Connect one Google Drive account.
- Store backups in a configurable Drive folder. The default folder is `Lexora/Backups`.
- Create a current backup named `lexora-backup-latest.json`.
- Create dated snapshot backups named `lexora-backup-{date}.json`.
- Import a cloud backup by merging it into local data.
- Restore a cloud backup by replacing local data after confirmation.
- Automatically update the latest cloud backup after important local changes while Google Drive is connected.

Google Drive backup is not full multi-device sync. It stores backup files that the user can import or restore.

### Google Cloud Configuration

The app uses Google Identity Services in the browser and requires an OAuth 2.0 Client ID for a web application.

In Google Cloud Console:

1. Enable the **Google Drive API** for the project.
2. Configure the OAuth consent screen.
3. Create or open an **OAuth 2.0 Client ID** with application type **Web application**.
4. Add the local development origins under **Authorized JavaScript origins**:

```text
http://localhost:5173
http://127.0.0.1:5173
```

5. Add the GitHub Pages origin under **Authorized JavaScript origins**:

```text
https://atanian123.github.io
```

For GitHub Pages project sites, only the origin is added here. The `/Lexora/` path is not part of the authorized origin.

No redirect URI is required for the Google Identity Services token flow used by Lexora. Seeing `redirect_uri=gis_transform` in Google's request details is expected.

If the OAuth app is in testing mode, add every test Google account under **Test users** on the OAuth consent screen.

Set the client ID locally in `.env.local`:

```env
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

For GitHub Pages deployment, add the same value as a repository secret named `VITE_GOOGLE_CLIENT_ID`.

## Offline and Privacy Model

Lexora is local-first.

- Profiles, words, decks, subsets, and review history are stored in IndexedDB through Dexie.
- The app shell is cached by the PWA service worker after the first load.
- Study and library management work offline.
- Translation suggestions require network access.
- Translation requests send only the text and language pair to MyMemory.
- No analytics, tracking scripts, login, or full cloud sync are included in phase 1.

Because Google Drive support is backup-based rather than full sync, users should keep regular backups if the data matters.

## Translation Provider

Phase 1 uses MyMemory:

- Endpoint: `https://api.mymemory.translated.net/get`
- No API key required.
- Anonymous usage is limited.
- Lexora tracks local daily usage and disables suggestion fetching when the limit is reached.
- Manual translation entry remains available at all times.

The translation layer is isolated so additional providers can be added later.

## Technical Stack

- React 19
- Vite 8
- TypeScript 6
- Tailwind CSS 4
- Dexie / IndexedDB
- i18next / react-i18next
- ts-fsrs
- vite-plugin-pwa / Workbox
- lucide-react

## Project Structure

```text
src/
  App.tsx              Main application views and workflows
  i18n.ts              UI translations
  index.css            Shared styling and Tailwind entry
  lib/
    constants.ts       Supported languages, ratings, limits
    db.ts              Dexie schema and local data operations
    cloudBackup.ts     Google Drive backup provider abstraction
    export.ts          Backup, CSV export, and import parsing
    ids.ts             ID and date helpers
    matching.ts        Answer normalization and close-answer matching
    srs.ts             FSRS scheduling adapter
    translation.ts     MyMemory provider and usage tracking
  types.ts             Shared domain types
docs/                  Production build output for static hosting
```

## Development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Run the TypeScript check:

```bash
npm run lint
```

Build for production:

```bash
npm run build
```

Build for GitHub Pages:

```bash
npm run build:github
```

Preview the production build locally:

```bash
npm run preview
```

The production build writes to `docs/`. The GitHub Pages build uses `/Lexora/` as the base path.

## Current Limitations

- No full cloud sync or login.
- No direct Duolingo account integration.
- No text-to-speech or speech-to-text yet.
- No public deck sharing.
- MyMemory is the only translation provider in phase 1.
- App data is device/browser-local unless exported manually.

## Roadmap Direction

Likely next phases:

- Optional cloud sync and authentication.
- Additional translation providers.
- Text-to-speech and speech-to-text.
- Shared or public decks.
- Richer import sources if stable official APIs become available.

## Related Documentation

- [Requirements](./REQUIREMENTS.md)
