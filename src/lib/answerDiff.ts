import { levenshtein, normalizeAnswer } from "./matching";

export interface DiffPart {
  text: string;
  /** True for letters that are not shared with the other string. */
  differs: boolean;
}

/**
 * Lines a typed answer up with a correct answer, letter by letter, so the screen can mark the
 * letters the learner got wrong and the ones they left out. Letters are compared case-insensitively
 * but accents count, since a missing accent is something to learn.
 */
export function diffAnswer(typed: string, correct: string): { typed: DiffPart[]; correct: DiffPart[] } {
  const a = [...typed];
  const b = [...correct];
  const same = (x: string, y: string) => x.toLocaleLowerCase() === y.toLocaleLowerCase();

  // Longest common subsequence table.
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = same(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const keptA = new Array<boolean>(a.length).fill(false);
  const keptB = new Array<boolean>(b.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (same(a[i], b[j])) {
      keptA[i] = true;
      keptB[j] = true;
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return { typed: toParts(a, keptA), correct: toParts(b, keptB) };
}

/** The closest accepted answer, using the same normalization as the answer matcher. */
export function closestAnswer(typed: string, accepted: string[]): string | undefined {
  const target = normalizeAnswer(typed);
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const answer of accepted) {
    const distance = levenshtein(target, normalizeAnswer(answer));
    if (distance < bestDistance) {
      best = answer;
      bestDistance = distance;
    }
  }
  return best;
}

function toParts(letters: string[], kept: boolean[]): DiffPart[] {
  const parts: DiffPart[] = [];
  letters.forEach((letter, index) => {
    const differs = !kept[index];
    const last = parts[parts.length - 1];
    if (last && last.differs === differs) last.text += letter;
    else parts.push({ text: letter, differs });
  });
  return parts;
}
