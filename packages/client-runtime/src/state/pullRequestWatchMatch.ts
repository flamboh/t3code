/**
 * Pure matcher shared by web and mobile for the small "watching" indicator
 * on linked PR rows. A row matches an active watch by PR number plus a
 * case-insensitive repository match; rows without a repository fall back to
 * a number-only match.
 */

export interface PullRequestWatchMatchRef {
  readonly number: number;
  readonly repository?: string | null | undefined;
}

export interface PullRequestWatchMatchCandidate {
  readonly number: number;
  readonly repository: string;
}

function normalizedRepository(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.toLowerCase();
}

export function isPullRequestWatchMatch(
  watch: PullRequestWatchMatchCandidate,
  ref: PullRequestWatchMatchRef,
): boolean {
  if (watch.number !== ref.number) return false;
  const rowRepository = normalizedRepository(ref.repository);
  if (rowRepository === null) return true;
  return watch.repository.trim().toLowerCase() === rowRepository;
}

/** All watches in `watches` that watch the given PR row. */
export function matchingPullRequestWatches<W extends PullRequestWatchMatchCandidate>(
  watches: ReadonlyArray<W>,
  ref: PullRequestWatchMatchRef,
): Array<W> {
  return watches.filter((watch) => isPullRequestWatchMatch(watch, ref));
}
