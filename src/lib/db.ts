import Dexie, { type Table } from "dexie";
import {
  type CardDirection,
  type CardState,
  type CustomSubset,
  type Deck,
  type LanguageCode,
  type LearningSetup,
  type Profile,
  type TranslationUsage,
  type WordEntry
} from "../types";
import { cardDirections, defaultBaseLanguage, defaultDeckNames, defaultTargetLanguage } from "./constants";
import { createId, nowIso } from "./ids";

class LexoraDatabase extends Dexie {
  profiles!: Table<Profile, string>;
  learningSetups!: Table<LearningSetup, string>;
  decks!: Table<Deck, string>;
  words!: Table<WordEntry, string>;
  subsets!: Table<CustomSubset, string>;
  cards!: Table<CardState, string>;
  translationUsage!: Table<TranslationUsage, string>;

  constructor() {
    super("lexora");

    this.version(1).stores({
      profiles: "&id, name, updatedAt",
      learningSetups: "&id, profileId, [profileId+name], updatedAt",
      decks: "&id, profileId, [profileId+name]",
      words: "&id, profileId, deckId, targetText, updatedAt",
      subsets: "&id, profileId, name, updatedAt",
      cards: "&id, profileId, wordId, [wordId+direction], due, [profileId+direction+due]",
      translationUsage: "&id, provider, date"
    });

    this.version(2)
      .stores({
        profiles: "&id, name, updatedAt",
        learningSetups: "&id, profileId, [profileId+name], updatedAt",
        decks: "&id, profileId, [profileId+name]",
        words:
          "&id, profileId, deckId, targetText, baseLanguage, targetLanguage, [profileId+baseLanguage+targetLanguage], updatedAt",
        subsets: "&id, profileId, name, updatedAt",
        cards: "&id, profileId, wordId, [wordId+direction], due, [profileId+direction+due]",
        translationUsage: "&id, provider, date"
      })
      .upgrade(async (transaction) => {
        const profiles = await transaction.table("profiles").toArray();
        const profilesById = new Map(profiles.map((profile: Profile) => [profile.id, profile]));

        await transaction.table("words").toCollection().modify((word: Partial<WordEntry>) => {
          const profile = word.profileId ? profilesById.get(word.profileId) : undefined;
          word.baseLanguage = word.baseLanguage ?? profile?.baseLanguage ?? defaultBaseLanguage;
          word.targetLanguage = word.targetLanguage ?? profile?.targetLanguage ?? defaultTargetLanguage;
        });
      });

    this.version(3)
      .stores({
        profiles: "&id, name, activeLearningSetupId, updatedAt",
        learningSetups: "&id, profileId, [profileId+name], [profileId+baseLanguage+targetLanguage], updatedAt",
        decks: "&id, profileId, learningSetupId, [learningSetupId+name]",
        words: "&id, profileId, learningSetupId, deckId, targetText, updatedAt",
        subsets: "&id, profileId, learningSetupId, name, updatedAt",
        cards: "&id, profileId, learningSetupId, wordId, [wordId+direction], due, [learningSetupId+direction+due]",
        translationUsage: "&id, provider, date"
      })
      .upgrade(async (transaction) => {
        const profilesTable = transaction.table("profiles");
        const setupsTable = transaction.table("learningSetups");
        const decksTable = transaction.table("decks");
        const wordsTable = transaction.table("words");
        const subsetsTable = transaction.table("subsets");
        const cardsTable = transaction.table("cards");
        const profiles = await profilesTable.toArray();
        const timestamp = nowIso();

        for (const profile of profiles as Profile[]) {
          const baseLanguage = profile.baseLanguage ?? defaultBaseLanguage;
          const targetLanguage = profile.targetLanguage ?? defaultTargetLanguage;
          const setup: LearningSetup = {
            id: createId("setup"),
            profileId: profile.id,
            name: `${targetLanguage.toUpperCase()} over ${baseLanguage.toUpperCase()}`,
            baseLanguage,
            targetLanguage,
            createdAt: profile.createdAt ?? timestamp,
            updatedAt: timestamp
          };

          await setupsTable.add(setup);
          await profilesTable.update(profile.id, {
            uiLanguage: profile.uiLanguage ?? baseLanguage,
            activeLearningSetupId: setup.id,
            baseLanguage: undefined,
            targetLanguage: undefined,
            updatedAt: timestamp
          });
          await decksTable.where("profileId").equals(profile.id).modify((deck: Partial<Deck>) => {
            deck.learningSetupId = setup.id;
          });
          await wordsTable.where("profileId").equals(profile.id).modify((word: Partial<WordEntry>) => {
            word.learningSetupId = setup.id;
            delete word.baseLanguage;
            delete word.targetLanguage;
          });
          await subsetsTable.where("profileId").equals(profile.id).modify((subset: Partial<CustomSubset>) => {
            subset.learningSetupId = setup.id;
          });
          await cardsTable.where("profileId").equals(profile.id).modify((card: Partial<CardState>) => {
            card.learningSetupId = setup.id;
          });
        }
      });
  }
}

export const db = new LexoraDatabase();

export async function createProfile(
  name: string,
  uiLanguage: LanguageCode = defaultBaseLanguage
): Promise<Profile> {
  const timestamp = nowIso();
  const profile: Profile = {
    id: createId("profile"),
    name: name.trim(),
    uiLanguage,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await db.profiles.add(profile);

  return profile;
}

export async function createLearningSetup(
  profileId: string,
  name: string,
  baseLanguage: LanguageCode = defaultBaseLanguage,
  targetLanguage: LanguageCode = defaultTargetLanguage
): Promise<LearningSetup> {
  const timestamp = nowIso();
  const setup: LearningSetup = {
    id: createId("setup"),
    profileId,
    name: name.trim() || `${targetLanguage.toUpperCase()} over ${baseLanguage.toUpperCase()}`,
    baseLanguage,
    targetLanguage,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await db.transaction("rw", db.learningSetups, db.profiles, db.decks, async () => {
    await db.learningSetups.add(setup);
    await db.profiles.update(profileId, { activeLearningSetupId: setup.id, updatedAt: timestamp });
    await db.decks.add({
      id: createId("deck"),
      profileId,
      learningSetupId: setup.id,
      name: defaultDeckNames[baseLanguage],
      createdAt: timestamp,
      updatedAt: timestamp
    });
  });

  return setup;
}

export async function ensureDefaultDeck(
  profileId: string,
  learningSetupId: string,
  baseLanguage: LanguageCode = defaultBaseLanguage
): Promise<Deck> {
  const existing = await db.decks.where("learningSetupId").equals(learningSetupId).first();
  if (existing) {
    return existing;
  }

  const timestamp = nowIso();
  const deck: Deck = {
    id: createId("deck"),
    profileId,
    learningSetupId,
    name: defaultDeckNames[baseLanguage],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await db.decks.add(deck);
  return deck;
}

export async function ensureCardsForWord(word: WordEntry): Promise<void> {
  const timestamp = nowIso();
  const existing = await db.cards.where("wordId").equals(word.id).toArray();
  const existingDirections = new Set(existing.map((card) => card.direction));

  const missing = cardDirections
    .filter((direction) => !existingDirections.has(direction))
    .map((direction) => createInitialCardState(word, direction, timestamp));

  if (missing.length > 0) {
    await db.cards.bulkAdd(missing);
  }
}

export async function ensureCardsForWords(words: WordEntry[]): Promise<void> {
  for (const word of words) {
    await ensureCardsForWord(word);
  }
}

export function createInitialCardState(
  word: WordEntry,
  direction: CardDirection,
  timestamp = nowIso()
): CardState {
  return {
    id: createId("card"),
    profileId: word.profileId,
    learningSetupId: word.learningSetupId,
    wordId: word.id,
    direction,
    due: timestamp,
    reviewCount: 0,
    lapseCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export async function deleteDeckWithWords(deckId: string, mode: "delete" | "reassign", targetDeckId?: string): Promise<void> {
  await db.transaction("rw", db.decks, db.words, db.cards, async () => {
    const words = await db.words.where("deckId").equals(deckId).toArray();

    if (mode === "delete") {
      const wordIds = words.map((word) => word.id);
      await db.words.bulkDelete(wordIds);
      if (wordIds.length > 0) {
        const cards = await db.cards.where("wordId").anyOf(wordIds).toArray();
        await db.cards.bulkDelete(cards.map((card) => card.id));
      }
    } else if (targetDeckId) {
      await Promise.all(words.map((word) => db.words.update(word.id, { deckId: targetDeckId, updatedAt: nowIso() })));
    }

    await db.decks.delete(deckId);
  });
}

export async function deleteLearningSetup(setupId: string): Promise<void> {
  await db.transaction("rw", [db.profiles, db.learningSetups, db.decks, db.words, db.subsets, db.cards], async () => {
    const setup = await db.learningSetups.get(setupId);
    if (!setup) {
      return;
    }

    const [decks, words, subsets, cards] = await Promise.all([
      db.decks.where("learningSetupId").equals(setupId).toArray(),
      db.words.where("learningSetupId").equals(setupId).toArray(),
      db.subsets.where("learningSetupId").equals(setupId).toArray(),
      db.cards.where("learningSetupId").equals(setupId).toArray()
    ]);

    await Promise.all([
      db.decks.bulkDelete(decks.map((deck) => deck.id)),
      db.words.bulkDelete(words.map((word) => word.id)),
      db.subsets.bulkDelete(subsets.map((subset) => subset.id)),
      db.cards.bulkDelete(cards.map((card) => card.id)),
      db.learningSetups.delete(setupId)
    ]);

    const remaining = await db.learningSetups.where("profileId").equals(setup.profileId).first();
    const profile = await db.profiles.get(setup.profileId);
    if (profile?.activeLearningSetupId === setupId) {
      await db.profiles.update(setup.profileId, { activeLearningSetupId: remaining?.id, updatedAt: nowIso() });
    }
  });
}

export async function resetAllLocalData(): Promise<void> {
  await db.transaction("rw", [db.profiles, db.learningSetups, db.decks, db.words, db.subsets, db.cards, db.translationUsage], async () => {
    await Promise.all([
      db.profiles.clear(),
      db.learningSetups.clear(),
      db.decks.clear(),
      db.words.clear(),
      db.subsets.clear(),
      db.cards.clear(),
      db.translationUsage.clear()
    ]);
  });
}
