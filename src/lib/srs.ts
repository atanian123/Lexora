import { dateChrono, defineMiddleware, defineScheduler, Rating, State, type Grade } from "ts-fsrs";
import {
  calculateScheduleDays,
  monotonicIntervalConfigSchema,
  schedulerDesiredRetentionMiddleware,
  schedulerFuzzingMiddleware,
  schedulerLearningStepsMiddleware,
  schedulerMaximumIntervalMiddleware,
  schedulerScheduledDaysMiddleware,
  schedulerStatsMiddleware
} from "ts-fsrs/middlewares";
import { FSRS6_DEFAULT_WEIGHTS, FSRS6Model } from "ts-fsrs/models/fsrs-6";
import type { CardState, ReviewRating } from "../types";
import { nowIso } from "./ids";

const reviewIntervals = defineMiddleware({
  name: Symbol("review-intervals"),
  schema: { config: monotonicIntervalConfigSchema },
  handlers: {
    nextInterval(context, next) {
      next();
      const { card, grade } = context.input;
      // Established reviews space out Hard, Good and Easy. Learning steps keep their own timing.
      if (card.state !== State.Review || grade < Rating.Good || context.scheduledDays === undefined) return;

      const interval = (rating: Grade) => context.candidate.nextInterval(context.candidate.step(rating), context.candidate.desiredRetention[rating]);
      const hard = interval(Rating.Hard);
      const candidates = grade === Rating.Good
        ? [hard, context.scheduledDays] as const
        : [hard, interval(Rating.Good), context.scheduledDays] as const;
      const ordered = calculateScheduleDays(candidates, context.config.maximumInterval);
      context.scheduledDays = ordered[ordered.length - 1];
    }
  }
});

const scheduler = defineScheduler({ model: FSRS6Model, chrono: dateChrono })
  .use(
    schedulerDesiredRetentionMiddleware,
    schedulerFuzzingMiddleware,
    schedulerStatsMiddleware,
    schedulerScheduledDaysMiddleware,
    schedulerLearningStepsMiddleware,
    schedulerMaximumIntervalMiddleware,
    reviewIntervals
  )
  .create({ config: {
    weights: [...FSRS6_DEFAULT_WEIGHTS],
    fractionalDays: false,
    desiredRetention: 0.9,
    learningSteps: ["1m", "10m"],
    relearningSteps: ["10m"],
    numRelearningSteps: 1,
    enableShortTerm: true,
    allowModelOverride: false,
    enableFuzz: false,
    maximumInterval: 36500
  } });
type SchedulerCard = ReturnType<typeof scheduler.newCard>;

const ratingMap: Record<ReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy
};

export function scheduleReview(cardState: CardState, rating: ReviewRating, reviewedAt = new Date()): Partial<CardState> {
  const card = toSchedulerCard(cardState);
  const elapsedDays = card.lastReviewAt ? scheduler.chrono.difference(card.lastReviewAt, reviewedAt) : 0;
  const { card: scheduled } = scheduler.review({ card, now: reviewedAt, grade: ratingMap[rating] });
  let dueAt = scheduled.dueAt;
  if (rating === "hard" && scheduled.scheduleStatus === "learning") {
    // Keep the whole-minute Hard interval used by earlier Lexora versions.
    const intervalMinutes = Math.round((dueAt.getTime() - reviewedAt.getTime()) / 60_000);
    dueAt = new Date(reviewedAt.getTime() + intervalMinutes * 60_000);
  }
  const due = dueAt.toISOString();
  const lastReviewedAt = reviewedAt.toISOString();

  return {
    due,
    stability: scheduled.stability,
    difficulty: scheduled.difficulty,
    elapsedDays,
    scheduledDays: scheduled.scheduledDays,
    state: scheduled.state,
    reviewCount: scheduled.reps,
    lapseCount: scheduled.lapses,
    lastRating: rating,
    lastReviewedAt,
    fsrsCard: {
      due,
      stability: scheduled.stability,
      difficulty: scheduled.difficulty,
      elapsed_days: elapsedDays,
      scheduled_days: scheduled.scheduledDays,
      reps: scheduled.reps,
      lapses: scheduled.lapses,
      learning_steps: scheduled.learningStep,
      state: scheduled.state,
      last_review: lastReviewedAt
    },
    updatedAt: nowIso()
  };
}

export function isDue(card: CardState, now = new Date()): boolean {
  return new Date(card.due).getTime() <= now.getTime();
}

function toSchedulerCard(cardState: CardState): SchedulerCard {
  const saved = cardState.fsrsCard;
  if (!saved && cardState.state === undefined) {
    return scheduler.newCard({ now: new Date(cardState.createdAt), cardId: cardState.id });
  }

  const previousState = saved?.state ?? cardState.state;
  const state = readState(previousState);
  return {
    cardId: cardState.id,
    dueAt: readDate(saved?.due) ?? new Date(cardState.due),
    lastReviewAt: state === State.New ? null : readDate(saved?.last_review) ?? readDate(cardState.lastReviewedAt) ?? null,
    state,
    scheduleStatus: state === State.New ? "new" : state === State.Review ? "review" : "learning",
    stability: readNumber(saved?.stability, cardState.stability),
    difficulty: readNumber(saved?.difficulty, cardState.difficulty),
    scheduledDays: readNumber(saved?.scheduled_days, cardState.scheduledDays),
    learningStep: readNumber(saved?.learning_steps),
    reps: readNumber(saved?.reps, cardState.reviewCount),
    lapses: readNumber(saved?.lapses, cardState.lapseCount)
  };
}

function readState(value: unknown): State {
  switch (typeof value === "string" ? value.toLowerCase() : value) {
    case State.Learning: case "learning": return State.Learning;
    case State.Review: case "review": return State.Review;
    case State.Relearning: case "relearning": return State.Relearning;
    default: return State.New;
  }
}

function readDate(value: unknown): Date | undefined {
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
