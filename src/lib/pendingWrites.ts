/**
 * Rating writes that are still being saved, kept outside any component so they survive
 * navigation: a review started from another screen must not read cards before an earlier
 * rating has landed.
 */
const pendingRatingWrites = new Set<Promise<void>>();

/** Registers a rating write and returns it unchanged, so callers can still see a failure. */
export function trackRatingWrite<T>(write: Promise<T>): Promise<T> {
  const settled: Promise<void> = write.then(
    () => undefined,
    () => undefined
  );
  pendingRatingWrites.add(settled);
  void settled.then(() => pendingRatingWrites.delete(settled));
  return write;
}

/** Resolves once every rating write started so far has finished, whether it saved or failed. */
export async function waitForPendingRatingWrites(): Promise<void> {
  while (pendingRatingWrites.size > 0) {
    await Promise.all([...pendingRatingWrites]);
  }
}
