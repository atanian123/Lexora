export type MatchResult = "correct" | "close" | "wrong";

export function normalizeAnswer(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function evaluateAnswer(answer: string, accepted: string[]): MatchResult {
  const normalizedAnswer = normalizeAnswer(answer);
  const normalizedAccepted = accepted.map(normalizeAnswer).filter(Boolean);

  if (normalizedAccepted.includes(normalizedAnswer)) {
    return "correct";
  }

  if (normalizedAccepted.some((value) => levenshtein(normalizedAnswer, value) === 1)) {
    return "close";
  }

  return "wrong";
}

export function levenshtein(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;

    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost
      );
    }

    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[right.length];
}
