import { createEmptyCard, fsrs, generatorParameters, Rating } from "ts-fsrs";
import type { CardState, ReviewRating } from "../types";
import { nowIso } from "./ids";

const scheduler = fsrs(generatorParameters());

const ratingMap: Record<ReviewRating, Rating> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy
};

export function scheduleReview(cardState: CardState, rating: ReviewRating, reviewedAt = new Date()): Partial<CardState> {
  const fsrsCard = toFsrsCard(cardState);
  const scheduledCards = scheduler.repeat(fsrsCard, reviewedAt) as any;
  const scheduled = scheduledCards[ratingMap[rating]].card;
  const timestamp = nowIso();

  return {
    due: toIsoDate(scheduled.due),
    stability: scheduled.stability,
    difficulty: scheduled.difficulty,
    elapsedDays: scheduled.elapsed_days,
    scheduledDays: scheduled.scheduled_days,
    state: scheduled.state,
    reviewCount: scheduled.reps,
    lapseCount: scheduled.lapses,
    lastRating: rating,
    lastReviewedAt: reviewedAt.toISOString(),
    fsrsCard: serializeFsrsCard(scheduled),
    updatedAt: timestamp
  };
}

export function isDue(card: CardState, now = new Date()): boolean {
  return new Date(card.due).getTime() <= now.getTime();
}

function toFsrsCard(cardState: CardState): any {
  if (!cardState.fsrsCard) {
    return createEmptyCard(new Date(cardState.createdAt));
  }

  const card = { ...cardState.fsrsCard } as Record<string, unknown>;
  for (const key of ["due", "last_review"]) {
    if (typeof card[key] === "string") {
      card[key] = new Date(card[key] as string);
    }
  }

  return card;
}

function serializeFsrsCard(card: Record<string, unknown>): Record<string, unknown> {
  const serialized = { ...card };
  for (const key of ["due", "last_review"]) {
    const value = serialized[key];
    if (value instanceof Date) {
      serialized[key] = value.toISOString();
    }
  }

  return serialized;
}

function toIsoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
